import { Notice, TFile } from "obsidian";
import type MeetingRecorderPlugin from "./main";
import { AudioCapture } from "./audio";
import { AudioSwitcher } from "./audio-switcher";
import { Transcriber } from "./transcriber";
import { Summarizer } from "./summarizer";

type PanelState = "idle" | "recording" | "paused" | "processing";

const GEAR_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

export class RecorderPanel {
	private plugin: MeetingRecorderPlugin;
	private containerEl: HTMLElement | null = null;
	private sourcePath: string = "";
	private state: PanelState = "idle";
	private timerInterval: number | null = null;
	private elapsedSeconds = 0;
	private timerEl: HTMLElement | null = null;

	// Audio & transcription
	private audio: AudioCapture | null = null;
	private audioSwitcher = new AudioSwitcher();
	private transcriber: Transcriber | null = null;
	private transcriptionTimer: number | null = null;
	private isTranscribing = false;
	private recordingFile: TFile | null = null;
	private fullTranscript: string[] = [];

	constructor(plugin: MeetingRecorderPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Attach to a new DOM container. Called by the code block processor
	 * each time Obsidian re-renders the block. Preserves recording state.
	 */
	attach(containerEl: HTMLElement, sourcePath: string): void {
		this.containerEl = containerEl;
		this.sourcePath = sourcePath;
		this.render();
	}

	/** Full teardown — stops recording. */
	detach(): void {
		this.stopRecording();
		this.state = "idle";
		this.elapsedSeconds = 0;
	}

	// ── Rendering ──

	private render(): void {
		if (!this.containerEl) return;
		this.containerEl.empty();

		switch (this.state) {
			case "idle":
				this.renderIdle();
				break;
			case "recording":
				this.renderRecording();
				break;
			case "paused":
				this.renderPaused();
				break;
			case "processing":
				this.renderProcessing();
				break;
		}
	}

	private renderIdle(): void {
		if (!this.containerEl) return;
		const row = this.containerEl.createDiv({ cls: "mr-panel-row" });

		const recordBtn = row.createEl("button", { cls: "mr-btn mr-btn-record" });
		recordBtn.createSpan({ cls: "mr-record-dot" });
		recordBtn.createSpan({ text: "Record" });
		recordBtn.addEventListener("click", () => this.onRecord());

		this.addGearButton(row);
	}

	private renderRecording(): void {
		if (!this.containerEl) return;
		const row = this.containerEl.createDiv({ cls: "mr-panel-row mr-recording-row" });

		this.timerEl = row.createDiv({ cls: "mr-timer" });
		this.updateTimerDisplay();

		const waveform = row.createDiv({ cls: "mr-waveform" });
		for (let i = 0; i < 24; i++) {
			waveform.createDiv({ cls: "mr-waveform-bar" });
		}

		const controls = row.createDiv({ cls: "mr-controls" });

		const pauseBtn = controls.createEl("button", { cls: "mr-btn mr-btn-pause" });
		const pauseIcon = pauseBtn.createSpan({ cls: "mr-pause-icon" });
		pauseIcon.createSpan({ cls: "mr-pause-bar" });
		pauseIcon.createSpan({ cls: "mr-pause-bar" });
		pauseBtn.createSpan({ text: "Pause" });
		pauseBtn.addEventListener("click", () => this.onPause());

		const stopBtn = controls.createEl("button", { cls: "mr-btn mr-btn-stop" });
		stopBtn.createSpan({ cls: "mr-stop-icon" });
		stopBtn.createSpan({ text: "Stop" });
		stopBtn.addEventListener("click", () => this.onStop());

		this.addGearButton(row);
	}

	private renderPaused(): void {
		if (!this.containerEl) return;
		const row = this.containerEl.createDiv({ cls: "mr-panel-row mr-recording-row" });

		this.timerEl = row.createDiv({ cls: "mr-timer mr-timer-paused" });
		this.updateTimerDisplay();

		const waveform = row.createDiv({ cls: "mr-waveform mr-waveform-paused" });
		for (let i = 0; i < 24; i++) {
			waveform.createDiv({ cls: "mr-waveform-bar" });
		}

		const controls = row.createDiv({ cls: "mr-controls" });

		const resumeBtn = controls.createEl("button", { cls: "mr-btn mr-btn-record" });
		resumeBtn.createSpan({ cls: "mr-record-dot" });
		resumeBtn.createSpan({ text: "Resume" });
		resumeBtn.addEventListener("click", () => this.onResume());

		const stopBtn = controls.createEl("button", { cls: "mr-btn mr-btn-stop" });
		stopBtn.createSpan({ cls: "mr-stop-icon" });
		stopBtn.createSpan({ text: "Stop" });
		stopBtn.addEventListener("click", () => this.onStop());

		this.addGearButton(row);
	}

	private renderProcessing(): void {
		if (!this.containerEl) return;
		const row = this.containerEl.createDiv({ cls: "mr-panel-row mr-processing-row" });

		const spinner = row.createDiv({ cls: "mr-spinner" });
		for (let i = 0; i < 3; i++) {
			spinner.createDiv({ cls: "mr-spinner-dot" });
		}

		row.createSpan({ cls: "mr-processing-text", text: "Finalizing transcript…" });

		const barContainer = this.containerEl.createDiv({ cls: "mr-panel-row" });
		const track = barContainer.createDiv({ cls: "mr-progress-track" });
		track.createDiv({ cls: "mr-progress-bar" });
	}

	private addGearButton(parent: HTMLElement): void {
		const btn = parent.createEl("button", { cls: "mr-settings-btn" });
		btn.innerHTML = GEAR_SVG;
		btn.setAttribute("aria-label", "Meeting Recorder settings");
		btn.addEventListener("click", () => {
			(this.plugin.app as any).setting.open();
			(this.plugin.app as any).setting.openTabById("meeting-recorder");
		});
	}

	// ── Actions ──

	private async onRecord(): Promise<void> {
		// Show loading state immediately
		const btn = this.containerEl?.querySelector(".mr-btn-record") as HTMLElement | null;
		if (btn) {
			btn.empty();
			btn.createSpan({ cls: "mr-record-spinner" });
			btn.createSpan({ text: "Starting…" });
			btn.setAttribute("disabled", "true");
		}

		const s = this.plugin.settings;

		// Resolve recording file from sourcePath
		const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
		if (!(file instanceof TFile)) {
			new Notice("Cannot find the current file");
			return;
		}
		this.recordingFile = file;
		this.fullTranscript = [];

		// Verify whisper setup
		this.transcriber = new Transcriber(s.whisperBinary, s.whisperModelsDir, s.whisperModel);
		const err = await this.transcriber.verify();
		if (err) {
			new Notice(err);
			this.transcriber = null;
			return;
		}

		// Switch audio output for system audio capture
		if (s.audioInput !== "mic") {
			try {
				if (!(await this.audioSwitcher.isAvailable())) {
					new Notice("SwitchAudioSource not found. Install: brew install switchaudio-osx");
					this.transcriber = null;
					return;
				}
				await this.audioSwitcher.engage(s.deviceMappings);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : "Failed to switch audio output";
				new Notice(msg);
				this.transcriber = null;
				return;
			}
		}

		// Start audio capture
		this.audio = new AudioCapture();
		try {
			await this.audio.start(s.audioInput);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : "Audio capture failed";
			new Notice(msg);
			this.audio = null;
			this.transcriber = null;
			await this.audioSwitcher.restore();
			return;
		}

		this.state = "recording";
		this.elapsedSeconds = 0;
		this.startTimer();
		this.startTranscriptionLoop();
		this.render();
	}

	private onPause(): void {
		this.audio?.pause();
		this.stopTimer();
		this.stopTranscriptionLoop();
		this.state = "paused";
		this.render();
	}

	private onResume(): void {
		this.audio?.resume();
		this.startTimer();
		this.startTranscriptionLoop();
		this.state = "recording";
		this.render();
	}

	private async onStop(): Promise<void> {
		this.stopTimer();
		this.stopTranscriptionLoop();

		try {
			// Stop audio and restore device FIRST — guarantees cleanup
			const remaining = await this.audio?.stop() ?? null;
			this.audio = null;
			await this.audioSwitcher.restore();

			this.state = "processing";
			this.render();

			// Final transcription of remaining buffer
			if (remaining && remaining.length > 0 && this.transcriber) {
				try {
					const text = await this.transcriber.transcribe(remaining, 16_000);
					if (text) this.fullTranscript.push(text);
				} catch (e) {
					console.error("Final transcription failed:", e);
				}
			}

			this.transcriber = null;

			// Write final transcript as folded callout
			await this.finalizeTranscript();

			// Generate summary via Claude
			await this.generateSummary();

			// Replace the code block with the generated content
			await this.replaceCodeBlock();
		} finally {
			// Guarantee cleanup even if anything above throws
			if (this.audio) {
				await this.audio.stop();
				this.audio = null;
			}
			await this.audioSwitcher.restore();

			this.transcriber = null;
			this.recordingFile = null;
			this.fullTranscript = [];
			this.state = "idle";
			this.elapsedSeconds = 0;
		}
	}

	private async stopRecording(): Promise<void> {
		this.stopTimer();
		this.stopTranscriptionLoop();
		if (this.audio) {
			await this.audio.stop();
			this.audio = null;
		}
		this.transcriber = null;
		this.recordingFile = null;
		this.fullTranscript = [];
		await this.audioSwitcher.restore();
	}

	// ── Timer ──

	private startTimer(): void {
		this.stopTimer();
		this.timerInterval = window.setInterval(() => {
			this.elapsedSeconds++;
			this.updateTimerDisplay();
		}, 1000);
	}

	private stopTimer(): void {
		if (this.timerInterval !== null) {
			window.clearInterval(this.timerInterval);
			this.timerInterval = null;
		}
	}

	private updateTimerDisplay(): void {
		if (!this.timerEl) return;
		const mins = Math.floor(this.elapsedSeconds / 60).toString().padStart(2, "0");
		const secs = (this.elapsedSeconds % 60).toString().padStart(2, "0");
		this.timerEl.textContent = `${mins}:${secs}`;
	}

	// ── Transcription loop ──

	private startTranscriptionLoop(): void {
		this.stopTranscriptionLoop();
		const ms = this.plugin.settings.transcriptionInterval * 1000;
		this.transcriptionTimer = window.setInterval(() => {
			this.transcribePending();
		}, ms);
	}

	private stopTranscriptionLoop(): void {
		if (this.transcriptionTimer !== null) {
			window.clearInterval(this.transcriptionTimer);
			this.transcriptionTimer = null;
		}
	}

	private async transcribePending(): Promise<void> {
		if (this.isTranscribing) return;
		if (!this.audio || !this.transcriber) return;

		const samples = this.audio.drain();
		if (!samples || samples.length === 0) return;

		this.isTranscribing = true;
		try {
			const text = await this.transcriber.transcribe(samples, this.audio.sampleRate);
			if (text) {
				this.fullTranscript.push(text);
				await this.writeTranscriptToFile();
			}
		} catch (e) {
			console.error("Transcription chunk failed:", e);
			new Notice("Transcription failed for a segment — recording continues");
		} finally {
			this.isTranscribing = false;
		}
	}

	// ── Summarization ──

	private async generateSummary(): Promise<void> {
		if (!this.recordingFile || this.fullTranscript.length === 0) return;

		const summarizer = new Summarizer(this.plugin.settings.claudeModel);

		if (!(await summarizer.isAvailable())) {
			new Notice("Claude CLI not found — skipping summary");
			return;
		}

		this.updateProcessingText("Generating summary…");

		try {
			const transcript = this.fullTranscript.join("\n\n");
			const summary = await summarizer.summarize(transcript);

			if (summary) {
				await this.writeSummaryToFile(summary);
			}
		} catch (e) {
			console.error("Summary generation failed:", e);
			new Notice("Summary generation failed — transcript saved");
		}
	}

	private updateProcessingText(text: string): void {
		const el = this.containerEl?.querySelector(".mr-processing-text");
		if (el) el.textContent = text;
	}

	private async writeSummaryToFile(summary: string): Promise<void> {
		if (!this.recordingFile) return;

		await this.plugin.app.vault.process(this.recordingFile, (content) => {
			const calloutStart = "> [!quote]- Transcript";
			const idx = content.indexOf(calloutStart);
			if (idx === -1) {
				return content.trimEnd() + "\n\n" + summary;
			}
			return (
				content.slice(0, idx).trimEnd() + "\n\n" + summary + "\n\n" + content.slice(idx)
			);
		});
	}

	// ── File I/O ──

	private async writeTranscriptToFile(): Promise<void> {
		if (!this.recordingFile) return;
		const text = this.fullTranscript.join("\n\n");
		const section = `<!-- mr-recording -->\n${text}\n<!-- /mr-recording -->`;

		await this.plugin.app.vault.process(this.recordingFile, (content) => {
			const re = /<!-- mr-recording -->[\s\S]*?<!-- \/mr-recording -->/;
			if (re.test(content)) {
				return content.replace(re, section);
			}
			return content.trimEnd() + "\n\n" + section;
		});
	}

	private async finalizeTranscript(): Promise<void> {
		if (!this.recordingFile || this.fullTranscript.length === 0) return;

		const text = this.fullTranscript.join("\n\n");
		const lines = text.split("\n").map((l) => `> ${l}`);
		const callout = `> [!quote]- Transcript\n${lines.join("\n")}`;

		await this.plugin.app.vault.process(this.recordingFile, (content) => {
			const re = /<!-- mr-recording -->[\s\S]*?<!-- \/mr-recording -->/;
			if (re.test(content)) {
				return content.replace(re, callout);
			}
			return content.trimEnd() + "\n\n" + callout;
		});
	}

	private async replaceCodeBlock(): Promise<void> {
		if (!this.recordingFile) return;

		await this.plugin.app.vault.process(this.recordingFile, (content) => {
			const re = /```meeting-recorder\n[\s\S]*?```\n?/;
			if (re.test(content)) {
				return content.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
			}
			return content;
		});
	}
}
