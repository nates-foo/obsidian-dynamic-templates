import { App, MarkdownView, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default'
}

class DynamicTemplate {
	public sourcePath: string;
	public path: string;
	public lineStart: number;
	public lineEnd?: number;
	public args: any;

	constructor(sourcePath: string, path: string, lineStart: number, args: any) {
		this.sourcePath = sourcePath;
		this.path = path;
		this.lineStart = lineStart;
		this.args = args;
	}

	public async generate(app: App): Promise<string | null> {
		// Based on https://github.com/blacksmithgu/obsidian-dataview/blob/e4a6cab97b628deb22d36b73ce912abca541ad42/src/api/inline-api.ts#L317
        const viewFile = app.metadataCache.getFirstLinkpathDest(this.path, this.sourcePath);
		if (!viewFile) return null;

		let contents = await app.vault.cachedRead(viewFile);
		if (contents.contains("await")) contents = "(async () => { " + contents + " })()";

		const dv = this.getDataviewPlugin(app).api;
		if (!this.args.current) {
			this.args.current = dv.page(this.sourcePath);
		}

		const func = new Function('dv', 'input', contents);
		const result = await Promise.resolve(func(dv, this.args));
		return result;
	}

	private getDataviewPlugin(app: App): any {
		// @ts-ignore
		return app.plugins.plugins['dataview'];
	}
}

function getLines(md: string): string[] {
	return md.split(/\r?\n/);
}

function getDynamicTemplates(md: string, sourcePath: string): DynamicTemplate[] {
	const regexTempStart = /^%%\s+([^%]+)\s+%%\s*$/;
	const regexTempEnd = /^%%%%\s*$/;

	const templates: DynamicTemplate[] = [];
	let currentTemplate: DynamicTemplate | null = null;

	const lines = getLines(md);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		const matchStart = line.match(regexTempStart);
		if (matchStart) {
			const args = eval(`({${matchStart[1]}})`);
			if (args.template) {
				currentTemplate = new DynamicTemplate(sourcePath, args.template, i, args);
				templates.push(currentTemplate);
				continue;
			}
		}
		
		if (line.match(regexTempEnd) && currentTemplate) {
			currentTemplate.lineEnd = i;
			currentTemplate = null;
		}
	}

	return templates;
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.addCommand({
			id: 'update',
			name: 'Update',
			checkCallback: (checking: boolean) => {
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					if (!checking && markdownView.file) {
						this.update(markdownView.file);
					}
					return true;
				}
			}
		});
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	public async update(file: TFile) {
		const { vault } = this.app;
		const md = await vault.read(file);

		const templates = getDynamicTemplates(md, file.path);

		const lines = getLines(md);
		let newLines = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			newLines.push(line);

			const template = templates.find(t => t.lineStart === i);
			if (template) {
				const generatedContent = await template.generate(this.app);
				if (generatedContent) {
					newLines.push(...getLines(generatedContent));
					newLines.push('%%%%');
				}

				if (template.lineEnd) {
					i += template.lineEnd - template.lineStart;
				}
			}
		}

		const data = newLines.join("\n");
		// TODO Add metadata
		await vault.modify(file, data);
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Setting #1')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
	}
}
