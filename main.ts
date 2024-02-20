import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default'
}

interface DynamicTemplate {
	path: string;
	lineStart: number;
	lineEnd?: number;
}

function getDynamicTemplates(md: string): DynamicTemplate[] {
	const regexTempStart = /^%%\s+DT:\s+([^%]+)\s+%%\s*$/i;
	const regexTempEnd = /^%%%%\s*$/;

	const templates: DynamicTemplate[] = [];
	let currentTemplate: DynamicTemplate | null = null;

	const lines = md.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const matchStart = line.match(regexTempStart);
		if (matchStart) {
			const path = matchStart[1];
			currentTemplate = {
				path,
				lineStart: i
			}
			templates.push(currentTemplate);

		} else if (line.match(regexTempEnd) && currentTemplate) {
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

		const { vault } = this.app;

		this.registerEvent(
			vault.on('modify', async (file) => {
				if (file instanceof TFile) {
					const md = await vault.read(file);

					console.log(getDynamicTemplates(md));
				}
			})
		);;
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
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
