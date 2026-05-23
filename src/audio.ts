import { Notice } from "obsidian";

type AudioInputMode = "mic" | "system" | "both";

/**
 * Captures raw 16 kHz mono PCM via the Web Audio API.
 * Supports microphone, system audio (via a virtual cable), or both mixed.
 *
 * Virtual cable:
 *   macOS   → BlackHole (https://existential.audio/blackhole/)
 *   Windows → VB-CABLE  (https://vb-audio.com/Cable/)
 */
const VIRTUAL_CABLE_HINTS = ["blackhole", "cable", "vb-audio"];

export class AudioCapture {
	private context: AudioContext | null = null;
	private streams: MediaStream[] = [];
	private processor: ScriptProcessorNode | null = null;
	private buffer: Float32Array[] = [];

	readonly sampleRate = 16_000;

	async start(mode: AudioInputMode): Promise<void> {
		this.context = new AudioContext({ sampleRate: this.sampleRate });

		let source: AudioNode;

		if (mode === "both") {
			const mic = await navigator.mediaDevices.getUserMedia({
				audio: true,
			});
			const cable = await this.virtualCableStream();
			this.streams = [mic, cable];

			const mixer = this.context.createGain();
			mixer.gain.value = 0.7;
			this.context.createMediaStreamSource(mic).connect(mixer);
			this.context.createMediaStreamSource(cable).connect(mixer);
			source = mixer;
		} else if (mode === "system") {
			const cable = await this.virtualCableStream();
			this.streams = [cable];
			source = this.context.createMediaStreamSource(cable);
		} else {
			const mic = await navigator.mediaDevices.getUserMedia({
				audio: true,
			});
			this.streams = [mic];
			source = this.context.createMediaStreamSource(mic);
		}

		// ScriptProcessorNode captures raw PCM Float32 samples
		this.processor = this.context.createScriptProcessor(4096, 1, 1);
		this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
			this.buffer.push(new Float32Array(e.inputBuffer.getChannelData(0)));
		};
		source.connect(this.processor);
		// Connect to destination (required for processing to fire)
		this.processor.connect(this.context.destination);
	}

	pause(): void {
		this.context?.suspend();
	}

	resume(): void {
		this.context?.resume();
	}

	/** Return accumulated samples since last drain, or null if empty. */
	drain(): Float32Array | null {
		if (this.buffer.length === 0) return null;
		const total = this.buffer.reduce((n, a) => n + a.length, 0);
		const out = new Float32Array(total);
		let off = 0;
		for (const chunk of this.buffer) {
			out.set(chunk, off);
			off += chunk.length;
		}
		this.buffer = [];
		return out;
	}

	/** Stop capture and return any remaining samples. */
	async stop(): Promise<Float32Array | null> {
		const remaining = this.drain();
		this.processor?.disconnect();
		this.processor = null;
		for (const s of this.streams) {
			s.getTracks().forEach((t) => t.stop());
		}
		this.streams = [];
		if (this.context) {
			await this.context.close();
			this.context = null;
		}
		return remaining;
	}

	private async virtualCableStream(): Promise<MediaStream> {
		const devices = await navigator.mediaDevices.enumerateDevices();
		const cable = devices.find(
			(d) =>
				d.kind === "audioinput" &&
				VIRTUAL_CABLE_HINTS.some((hint) =>
					d.label.toLowerCase().includes(hint)
				)
		);
		if (!cable) {
			const tool =
				process.platform === "win32" ? "VB-CABLE" : "BlackHole";
			new Notice(
				`Virtual audio cable not found. Install ${tool} for system audio capture.`
			);
			throw new Error("Virtual audio cable not found");
		}
		return navigator.mediaDevices.getUserMedia({
			audio: { deviceId: { exact: cable.deviceId } },
		});
	}
}
