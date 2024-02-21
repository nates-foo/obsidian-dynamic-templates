import { App, MarkdownView, Plugin, PluginSettingTab, TFile } from 'obsidian';

// Remember to rename these classes and interfaces!

interface DynamicTemplatesSettings {
	knownTemplatedFilePaths: string[];
}

const DEFAULT_SETTINGS: DynamicTemplatesSettings = {
	knownTemplatedFilePaths: []
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

		const sourcePath = this.sourcePath;
		const dv = this.getDataviewPlugin(app).api;
		const handler = {
			get: function (target: any, prop: any, _receiver: any) {
				if (prop === 'current') {
					return () => target.page(sourcePath);
				}

				// @ts-ignore
				return Reflect.get(...arguments);
			}
		};
		let dvProxy = new Proxy(dv, handler);

		const func = new Function('dv', 'input', contents);
		const result = await Promise.resolve(func(dvProxy, this.args));
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

function hasDynamicTemplates(md: string): boolean {
	const regex = /^%%\s+([^%]+)\s+%%\s*$/m;
	return md.match(regex) != null;
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

export default class DynamicTemplatesPlugin extends Plugin {

	public settings: DynamicTemplatesSettings;

	public async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.addCommand({
			id: 'update-active',
			name: 'Update templates in active file',
			checkCallback: (checking: boolean) => {
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					if (!checking && markdownView.file) {
						this.update(markdownView.file)
							// Commit known templated file paths to disk.
							.then(() => this.saveSettings());
					}
					return true;
				}
			}
		});

		this.addCommand({
			id: 'update-all',
			name: 'Update templates in all files (can be slow)',
			callback: async () => {
				const { vault } = this.app;
				for (const file of vault.getMarkdownFiles()) {
					const md = await vault.read(file);
					if (hasDynamicTemplates(md)) {
						await this.update(file);
					}
				}

				// Commit known templated file paths to disk.
				this.saveSettings();
			}
		});

		this.addCommand({
			id: 'update-known',
			name: 'Update known templates',
			callback: async () => {
				const { vault } = this.app;
				for (const path of this.settings.knownTemplatedFilePaths) {
					const file = vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						this.update(file);
					} else {
						this.removeKnownTemplatedFilePath(path);
					}
				}

				// Commit known templated file paths to disk.
				this.saveSettings();
			}
		});

		// TODO Add a command to insert a known template from a list
	}

	public onunload() {
	}

	public async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	public async saveSettings() {
		await this.saveData(this.settings);
	}

	private async update(file: TFile) {
		// I tried using vault.process rather than vault.read + vault.modify but it doesn't work
		// because the new content must be returned synchronously but template generation is 
		// currently asynchronous.

		const { path } = file;
		const { vault } = this.app;
		const md = await vault.read(file);

		const templates = getDynamicTemplates(md, path);
		if (templates.length === 0) {
			this.removeKnownTemplatedFilePath(path);
			return;
		} else {
			this.addKnownTemplatedFilePath(path);
		}

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

	private addKnownTemplatedFilePath(path: string) {
		if (!this.settings.knownTemplatedFilePaths.contains(path)) {
			this.settings.knownTemplatedFilePaths.push(path);
		}
	}
	
	private removeKnownTemplatedFilePath(path: string) {
		this.settings.knownTemplatedFilePaths.remove(path);
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: DynamicTemplatesPlugin;

	constructor(app: App, plugin: DynamicTemplatesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		/*
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
				*/
	}
}
