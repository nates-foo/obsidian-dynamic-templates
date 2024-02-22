import { App, Editor, MarkdownView, Plugin, PluginSettingTab, SuggestModal, TFile } from 'obsidian';

/**
 * TERMINOLOGY
 * - Template reference = %% template: … %%
 * - Template (script) = the JS file used to generate Markdown
 * - Template invocation = executing a template with args to generate Markdown
 * - Template result = the generated content
 * - Source = the Markdown note making the template invocation
 */

interface DynamicTemplatesSettings {
	// Markdown notes that contain Markdown.
	knownTemplatedFilePaths: string[];
	// JavaScript templates.
	knownTemplatePaths: string[];
}

const DEFAULT_SETTINGS: DynamicTemplatesSettings = {
	knownTemplatedFilePaths: [],
	knownTemplatePaths: []
}

function getDataviewPlugin(app: App): any | null {
	// @ts-ignore
	return app.plugins.plugins['dataview'];
}

function getLines(md: string): string[] {
	return md.split(/\r?\n/);
}

function hasDynamicTemplates(md: string): boolean {
	// TODO Simpler, more performant heuristic?
	const regex = /^%%\s+([^%]+)\s+%%\s*$/m;
	return md.match(regex) != null;
}

/**
 * Models a template, as in a JavaScript file which can be invoked with arguments and returns
 * Markdown.
 */
class DynamicTemplate {

	/**
	 * @param sourcePath the path of the file referencing "path"
	 * @param path the path of the template script
	 * @returns a template instance or null if the template script wasn't found
	 */
	public static async get(app: App, sourcePath: string, path: string): Promise<DynamicTemplate | null> {
		// Based on https://github.com/blacksmithgu/obsidian-dataview/blob/e4a6cab97b628deb22d36b73ce912abca541ad42/src/api/inline-api.ts#L317
        const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
		if (!file) return null;

		let code = await app.vault.cachedRead(file);
		if (code.contains("await")) code = "(async () => { " + code + " })()";

		const func = new Function('dv', 'input', code);
		return new DynamicTemplate(app, func);
	}

	private app: App;
	private templateFunction: Function;

	private constructor(app: App, templateFunction: Function) {
		this.app = app;
		this.templateFunction = templateFunction;
	}

	/**
	 * @param sourcePath the path of the file invoking the template
	 */
	public async invoke(sourcePath: string, args?: any): Promise<string | null | undefined> {
		let dvProxy = null;
		const dv = getDataviewPlugin(this.app)?.api;
		if (dv) {
			const handler = {
				get: function (target: any, prop: any, _receiver: any) {
					if (prop === 'current') {
						return () => target.page(sourcePath);
					}

					// @ts-ignore
					return Reflect.get(...arguments);
				}
			};
			dvProxy = new Proxy(dv, handler);
		}

		const result = await Promise.resolve(this.templateFunction(dvProxy, args));
		// TODO If there was an error, display it
		return result?.toString();
	}
}

/**
 * %%{ template: … }%%
 */
class DynamicTemplateReference {
	public app: App;
	public sourcePath: string;
	public path: string;
	public lineStart: number;
	public lineEnd?: number;
	public args: any;

	/**
	 * @param sourcePath path to the source / templated note.
	 * @param path path to the JavaScript template.
	 * @param lineStart the starting line for the template section.
	 * @param args arguments passed to the template.
	 */
	constructor(app: App, sourcePath: string, path: string, lineStart: number, args: any) {
		this.app = app;
		this.sourcePath = sourcePath;
		this.path = path;
		this.lineStart = lineStart;
		this.args = args;
	}

	public async invokeTemplate(): Promise<string | null | undefined> {
		const template = await DynamicTemplate.get(this.app, this.sourcePath, this.path);
		return template ? template.invoke(this.sourcePath, this.args) : null;
	}
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
						await this.update(file);
					} else {
						this.removeKnownTemplatedFilePath(path);
					}
				}

				// Commit known templated file paths to disk.
				this.saveSettings();
			}
		});

		this.addCommand({
			id: 'insert',
			name: 'Insert from known templates',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				new StringSuggestModel(
					this.app,
					this.settings.knownTemplatePaths,
					(selectedTemplatePath) => {
						const { file } = view;
						if (!file) return;

						const cursor = editor.getCursor();
						const lineContent = editor.getLine(cursor.line);

						DynamicTemplate.get(this.app, file.path, selectedTemplatePath)
							.then(async (template: DynamicTemplate | null) => {
								const result = template?.invoke(file.path)

								let templateInsert = `%% template: '${selectedTemplatePath}' %%`;
								if (result) {
									templateInsert += `\n${result}\n%%%%`;
								}

								if (lineContent.trim() === "") {
									// If the line is empty, insert text at the cursor position.
									editor.replaceRange(templateInsert, cursor);
									// Move cursor to end of insert.
									editor.setCursor(cursor.line, templateInsert.length);
								} else {
									// If the line is not empty, insert text on the next line.
									const position = { line: cursor.line, ch: lineContent.length };
									editor.replaceRange("\n" + templateInsert, position);
									// Move cursor to end of insert.
									editor.setCursor(cursor.line + 1, templateInsert.length);
								}
							});
					}
				).open();
			}
		});
	}

	public onunload() {
	}

	public async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	public async saveSettings() {
		await this.saveData(this.settings);
	}

	private getDynamicTemplateReferences(md: string, sourcePath: string): DynamicTemplateReference[] {
		const regexTempStart = /^%%\s+([^%]+)\s+%%\s*$/;
		const regexTempEnd = /^%%%%\s*$/;

		const templates: DynamicTemplateReference[] = [];
		let currentTemplate: DynamicTemplateReference | null = null;

		// In order to support nested code blocks we keep track of the depth of all open code blocks:
		// - ``` is a depth of 0, ```` is 1, ````` is 2, basically the number of backticks - 3.
		const codeBlockStack: number[] = [];
		const regexCodeBlock = /^```(`*)[^`]*$/;

		const lines = getLines(md);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Keep track of whether we are in a code block or nested code blocks.
			const matchCodeBlock = line.match(regexCodeBlock);
			if (matchCodeBlock) {
				const depth = matchCodeBlock[1].length;
				const index = codeBlockStack.indexOf(depth);
				if (index === -1) {
					// New code block for this particular depth, add it to the stack.
					codeBlockStack.push(depth);
				} else {
					// Closing a previously open code block, remove all code blocks that have been open
					// since (they are considered arbitrary code rather than code blocks).
					codeBlockStack.splice(index);
				}
				continue;
			}

			// If we are in a code block then ignore templates.
			if (codeBlockStack.length > 0) continue;

			const matchTempStart = line.match(regexTempStart);
			if (matchTempStart) {
				const args = eval(`({${matchTempStart[1]}})`);
				if (args.template) {
					currentTemplate = new DynamicTemplateReference(app, sourcePath, args.template, i, args);
					templates.push(currentTemplate);
					continue;
				}
			}

			if (line.match(regexTempEnd) && currentTemplate) {
				currentTemplate.lineEnd = i;
				currentTemplate = null;
				continue;
			}

		}

		return templates;
	}

	private async update(file: TFile) {
		// I tried using vault.process rather than vault.read + vault.modify but it doesn't work
		// because the new content must be returned synchronously but template generation is 
		// currently asynchronous.

		const { path } = file;
		const { vault } = this.app;
		const md = await vault.read(file);

		const references = this.getDynamicTemplateReferences(md, path);
		if (references.length === 0) {
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

			const reference = references.find(t => t.lineStart === i);
			if (reference) {
				const generatedContent = await reference.invokeTemplate();
				if (generatedContent) {
					this.addKnownTemplatePath(reference.path);

					newLines.push(...getLines(generatedContent));
					newLines.push('%%%%');
				} else {
					this.removeKnownTemplatePath(reference.path);
				}

				if (reference.lineEnd) {
					i += reference.lineEnd - reference.lineStart;
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

	private addKnownTemplatePath(path: string) {
		if (!this.settings.knownTemplatePaths.contains(path)) {
			this.settings.knownTemplatePaths.push(path);
		}
	}
	
	private removeKnownTemplatePath(path: string) {
		this.settings.knownTemplatePaths.remove(path);
	}
}

export class StringSuggestModel extends SuggestModal<string> {

	private suggestions: string[];
	private callback: (selection: string) => void;

	public constructor(
		app: App,
		data: string[],
		callback: (selection: string) => void
	) {
		super(app);
		this.suggestions = data;
		this.callback = callback;
	}

	public override getSuggestions(query: string): string[] {
		return this.suggestions.filter(t => t.toLowerCase().includes(query.toLowerCase()));
	}

	public override renderSuggestion(suggestion: string, el: HTMLElement) {
		el.createEl('div', { text: suggestion });
	}

	public override onChooseSuggestion(suggestion: string, _evt: MouseEvent | KeyboardEvent) {
		this.callback(suggestion);
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
