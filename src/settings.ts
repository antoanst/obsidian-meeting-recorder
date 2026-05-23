import { App, PluginSettingTab, Setting } from "obsidian";
import type MeetingRecorderPlugin from "./main";

const IS_MAC = process.platform === "darwin";

export interface DeviceMapping {
	output: string;
	multiOutput: string;
}

export interface MeetingRecorderSettings {
	whisperModel: string;
	whisperBinary: string;
	whisperModelsDir: string;
	claudeModel: string;
	audioInput: "mic" | "system" | "both";
	deviceMappings: DeviceMapping[];
	transcriptionInterval: number;
}

export const DEFAULT_SETTINGS: MeetingRecorderSettings = {
	whisperModel: "whisper-large-v3-turbo",
	whisperBinary: "whisper-cli",
	whisperModelsDir: "",
	claudeModel: "sonnet",
	audioInput: "mic",
	deviceMappings: [],
	transcriptionInterval: 30,
};

export class MeetingRecorderSettingTab extends PluginSettingTab {
	plugin: MeetingRecorderPlugin;

	constructor(app: App, plugin: MeetingRecorderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Whisper ──

		new Setting(containerEl).setName("Whisper").setHeading();

		new Setting(containerEl)
			.setName("Whisper binary")
			.setDesc(
				"Path to the Whisper binary. If in PATH, just the name is enough."
			)
			.addText((text) =>
				text
					.setPlaceholder("whisper-cli")
					.setValue(this.plugin.settings.whisperBinary)
					.onChange(async (value) => {
						this.plugin.settings.whisperBinary = value;
						await this.plugin.saveSettings();
					})
			);

		const modelsDirSetting = new Setting(containerEl)
			.setName("Models directory")
			.setDesc(
				this.plugin.settings.whisperModelsDir ||
				"Folder containing GGML model files (e.g. ggml-large-v3.bin)."
			)
			.addText((text) =>
				text
					.setPlaceholder("/path/to/whisper-models")
					.setValue(this.plugin.settings.whisperModelsDir)
					.onChange(async (value) => {
						this.plugin.settings.whisperModelsDir = value.replace(
							/[\/\\]$/,
							""
						);
						await this.plugin.saveSettings();
					})
			);

		// macOS has a native folder picker via osascript. On Windows users paste the path.
		if (IS_MAC) {
			modelsDirSetting.addButton((btn) =>
				btn.setButtonText("Choose folder").onClick(async () => {
					const { execFile } = require("child_process") as typeof import("child_process");
					const script =
						'POSIX path of (choose folder with prompt "Select whisper models directory")';
					execFile(
						"osascript",
						["-e", script],
						(err: Error | null, stdout: string) => {
							if (!err && stdout.trim()) {
								this.plugin.settings.whisperModelsDir =
									stdout.trim().replace(/\/$/, "");
								this.plugin.saveSettings();
								this.display();
							}
						}
					);
				})
			);
		}

		new Setting(containerEl)
			.setName("Transcription model")
			.setDesc("Whisper model variant for local transcription.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("whisper-large-v3-turbo", "Large v3 Turbo (recommended)")
					.addOption("whisper-large-v3", "Large v3 (best accuracy)")
					.addOption("whisper-medium", "Medium (faster)")
					.addOption("whisper-small", "Small (fastest)")
					.setValue(this.plugin.settings.whisperModel)
					.onChange(async (value) => {
						this.plugin.settings.whisperModel = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Transcription interval")
			.setDesc(
				"Seconds of audio to accumulate before running transcription."
			)
			.addSlider((slider) =>
				slider
					.setLimits(10, 120, 5)
					.setValue(this.plugin.settings.transcriptionInterval)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.transcriptionInterval = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Audio ──

		new Setting(containerEl).setName("Audio").setHeading();

		const cableName = IS_MAC ? "BlackHole" : "VB-CABLE";

		new Setting(containerEl)
			.setName("Audio input")
			.setDesc(
				`What audio to capture. "System" and "both" require ${cableName} ` +
				`(see README).`
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("mic", "Microphone only")
					.addOption("system", "System audio only")
					.addOption("both", "Both (mic + system)")
					.setValue(this.plugin.settings.audioInput)
					.onChange(
						async (value: "mic" | "system" | "both") => {
							this.plugin.settings.audioInput = value;
							await this.plugin.saveSettings();
						}
					)
			);

		// Device-mapping auto-switching is macOS-only (uses SwitchAudioSource).
		// On Windows the user sets their default playback to VB-CABLE manually.
		if (IS_MAC) {
			new Setting(containerEl)
				.setName("Device mappings")
				.setDesc(
					"Map each output device to its Multi-Output Device (with BlackHole). " +
					"On record, the plugin detects your current output and switches to the matching Multi-Output Device."
				);

			this.renderDeviceMappings(containerEl);

			new Setting(containerEl).addButton((btn) =>
				btn.setButtonText("+ Add mapping").onClick(async () => {
					this.plugin.settings.deviceMappings.push({
						output: "",
						multiOutput: "",
					});
					await this.plugin.saveSettings();
					this.display();
				})
			);
		}

		// ── Claude ──

		new Setting(containerEl).setName("Claude").setHeading();

		new Setting(containerEl)
			.setName("Summary model")
			.setDesc("Claude model for generating meeting summaries.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("sonnet", "Sonnet (recommended)")
					.addOption("opus", "Opus (complex meetings)")
					.addOption("haiku", "Haiku (fast, shorter)")
					.setValue(this.plugin.settings.claudeModel)
					.onChange(async (value) => {
						this.plugin.settings.claudeModel = value;
						await this.plugin.saveSettings();
					})
			);
	}

	private renderDeviceMappings(containerEl: HTMLElement): void {
		const mappings = this.plugin.settings.deviceMappings;

		for (let i = 0; i < mappings.length; i++) {
			const mapping = mappings[i];

			new Setting(containerEl)
				.addText((text) =>
					text
						.setPlaceholder("Output device")
						.setValue(mapping.output)
						.onChange(async (value) => {
							mapping.output = value;
							await this.plugin.saveSettings();
						})
				)
				.addText((text) =>
					text
						.setPlaceholder("Multi-Output Device")
						.setValue(mapping.multiOutput)
						.onChange(async (value) => {
							mapping.multiOutput = value;
							await this.plugin.saveSettings();
						})
				)
				.addExtraButton((btn) =>
					btn.setIcon("trash").onClick(async () => {
						mappings.splice(i, 1);
						await this.plugin.saveSettings();
						this.display();
					})
				);
		}
	}
}
