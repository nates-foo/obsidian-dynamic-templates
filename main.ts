import { App, Editor, MarkdownView, Plugin, PluginSettingTab, SuggestModal, TFile } from 'obsidian';
import { readFileSync } from 'fs';
import { Script } from 'vm';

/**
 * TERMINOLOGY
 * - Template reference = %%{ template: … }%%
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
	const regex = /^%%{\s+([^%]+)\s+}%%\s*$/m;
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
	 * @returns a template instance, even if the template script could not be found
	 */
	public static async get(app: App, sourcePath: string, path: string): Promise<DynamicTemplate> {
		// Based on https://github.com/blacksmithgu/obsidian-dataview/blob/e4a6cab97b628deb22d36b73ce912abca541ad42/src/api/inline-api.ts#L317
        const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);

		let code: string;
		if (file) {
			code = await app.vault.cachedRead(file);
			if (code.contains('await')) code = 'return (async () => { ' + code + ' })()';
		} else {
			code = "throw new Error('Template not found')";
		}

		return new DynamicTemplate(app, path, code, file != null);
	}

	private app: App;
	private code: string;

	public path: string;
	public exists: boolean;

	private constructor(app: App, path: string, code: string, exists: boolean) {
		this.app = app;
		this.code = code;
		this.path = path;
		this.exists = exists;
	}

	private customRequire(vaultSourcePath: string, dv: any): (module: string) => any {
		return (module: string): any => {
			try {
				return require(module);
			} catch (error) {
				if (error.code === 'MODULE_NOT_FOUND') {
					let vaultPath = module;
					if (!vaultPath.startsWith('/')) {
						// Relative path.
						const index = vaultSourcePath.lastIndexOf('/');
						if (index > 0) {
							vaultPath = '/' + vaultSourcePath.substring(0, index) + '/' + vaultPath;
						}
					}

					// @ts-ignore
					const absolutePath = this.app.vault.adapter.basePath + vaultPath;

					const moduleCode = readFileSync(absolutePath, 'utf8');
					const script = new Script(moduleCode, { filename: module });
					const context = { require: this.customRequire(vaultPath, dv), module: { exports: {} }, dv };
					script.runInNewContext(context);
					return context.module.exports;
				}
			}
		}
	}
	/**
	 * @param sourcePath the path of the file invoking the template
	 */
	public async invoke(sourcePath: string, args?: any): Promise<string | null | undefined> {
		try {
			const templateFunction = new Function('require', 'dv', 'input', 'invokeTemplate', this.code);

			const invokeTemplate = async (path: string, args?: any): Promise<string | null | undefined> => {
				const template = await DynamicTemplate.get(this.app, sourcePath, path);
				return template.invoke(sourcePath, args);
			}

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

			const customRequire = this.customRequire(this.path, dv);
			const result = await Promise.resolve(templateFunction(customRequire, dvProxy, args, invokeTemplate));
			return result?.toString();

		} catch (error) {
			console.error(error);
			if (error.name) {
				return `%% **${error.name}:** ${error.message} %%`;
			} else {
				return `%% ${error.toString()} %%`;
			}
		}
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

	public async template(): Promise<DynamicTemplate> {
		return await DynamicTemplate.get(this.app, this.sourcePath, this.path);
	}

	public async invokeTemplate(): Promise<string | null | undefined> {
		const template = await this.template();
		return template.invoke(this.sourcePath, this.args);
	}
}

export default class DynamicTemplatesPlugin extends Plugin {

	public settings: DynamicTemplatesSettings;

	public async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.addCommand({
			id: 'invoke-active',
			name: 'Invoke templates in active file',
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
			id: 'invoke-all',
			name: 'Invoke templates in all Markdown files (can be slow)',
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
			id: 'invoke-known',
			name: 'Invoke all known templates',
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
							.then(async (template: DynamicTemplate) => {
								let templateInsert = `%%{ template: '${selectedTemplatePath}' }%%`;

								const result = await template.invoke(file.path)
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

								if (!template.exists) {
									this.removeKnownTemplatePath(template.path);
									this.saveSettings();
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
		const regexTempStart = /^%%{\s+([^%]+)\s+}%%\s*$/;
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
				const args = new Function(`return {${matchTempStart[1]}}`)();
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

		const { path: sourcePath } = file;
		const { vault } = this.app;
		const md = await vault.read(file);

		const references = this.getDynamicTemplateReferences(md, sourcePath);
		if (references.length === 0) {
			this.removeKnownTemplatedFilePath(sourcePath);
			return;
		} else {
			this.addKnownTemplatedFilePath(sourcePath);
		}

		const lines = getLines(md);
		let newLines = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			newLines.push(line);

			const reference = references.find(t => t.lineStart === i);
			if (reference) {
				const template = await reference.template();
				const result = await template.invoke(sourcePath, reference.args);
				if (result) {
					newLines.push(...getLines(result));
					newLines.push('%%%%');
				}

				if (template.exists) {
					this.addKnownTemplatePath(reference.path);
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
