import { Plugin } from "obsidian";
import {
	MeetingRecorderSettings,
	DEFAULT_SETTINGS,
	MeetingRecorderSettingTab,
} from "./settings";
import { RecorderPanel } from "./RecorderPanel";

export default class MeetingRecorderPlugin extends Plugin {
	settings: MeetingRecorderSettings = DEFAULT_SETTINGS;
	private panel: RecorderPanel = new RecorderPanel(this);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new MeetingRecorderSettingTab(this.app, this));

		// Render recorder UI inside ```meeting-recorder``` code blocks.
		// The panel is a singleton — Obsidian re-runs processors on view
		// changes, so we swap the DOM element while preserving recording state.
		this.registerMarkdownCodeBlockProcessor(
			"meeting-recorder",
			(source, el, ctx) => {
				el.addClass("mr-panel");
				this.panel.attach(el, ctx.sourcePath);
			}
		);

		// Command to insert the code block at cursor
		this.addCommand({
			id: "insert-meeting-recorder",
			name: "Insert Meeting Recorder",
			editorCallback: (editor) => {
				editor.replaceSelection(
					"```meeting-recorder\n```\n"
				);
			},
		});
	}

	onunload(): void {
		this.panel.detach();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
