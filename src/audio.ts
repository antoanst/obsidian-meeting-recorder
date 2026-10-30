import { Notice } from "obsidian";
import { SystemTap, tapSupported } from "./system-tap";

type AudioInputMode = "mic" | "system" | "both";

/**
 * Captures raw 16 kHz mono PCM: microphone via the Web Audio API, system audio,
 * or both mixed.
 *
 * System audio:
 *   macOS   → bundled `meeting-tap` helper (Core Audio process tap, macOS 14.2+)
 *   Windows → VB-CABLE virtual cable (https://vb-audio.com/Cable/)
 */
const VIRTUAL_CABLE_HINTS = ["cable", "vb-audio"];

const IS_MAC = process.platform === "darwin";

/** Gain applied when mixing mic and system audio, to leave headroom. */
const MIX_GAIN = 0.7;

/**
 * Mic and tap run on separate clocks. Mix only what both have delivered, unless one
 * side falls this far behind (e.g. the helper died) — then treat its gap as silence.
 */
const MAX_SKEW_SECONDS = 2;

/** FIFO of PCM chunks. */
class SampleQueue {
	private chunks: Float32Array[] = [];
	length = 0;

	push(chunk: Float32Array): void {
		this.chunks.push(chunk);
		this.length += chunk.length;
	}

	/** Remove and return the first n samples, zero-padded if fewer are queued. */
	take(n: number): Float32Array {
		const out = new Float32Array(n);
		let off = 0;
		while (off < n && this.chunks.length > 0) {
			const head = this.chunks[0];
			const k = Math.min(head.length, n - off);
			out.set(head.subarray(0, k), off);
			off += k;
			if (k === head.length) this.chunks.shift();
			else this.chunks[0] = head.subarray(k);
		}
		this.length -= Math.min(n, this.length);
		return out;
	}

	/** Drop all but the newest n samples. */
	keepLast(n: number): void {
		if (this.length > n) this.take(this.length - n);
	}
}

export class AudioCapture {
	private context: AudioContext | null = null;
	private streams: MediaStream[] = [];
	private processor: ScriptProcessorNode | null = null;
	private tap: SystemTap | null = null;
	private paused = false;

	/** Web Audio graph output: mic, or (Windows) mic/cable mix. */
	private webQueue = new SampleQueue();
	private hasWebAudio = false;
	/** macOS system audio from the tap helper. */
	private tapQueue = new SampleQueue();
	private hasTap = false;
	private aligned = false;

	readonly sampleRate = 16_000;

	/** @param tapBinary Absolute path to the macOS `meeting-tap` helper. */
	constructor(private tapBinary: string) {}

	async start(mode: AudioInputMode): Promise<void> {
		try {
			await this.open(mode);
		} catch (e) {
			// Don't leave the helper or a half-built graph running.
			await this.stop();
			throw e;
		}
	}

	private async open(mode: AudioInputMode): Promise<void> {
		const wantsSystem = mode !== "mic";
		const wantsMic = mode !== "system";

		if (wantsSystem && IS_MAC) {
			if (!tapSupported()) {
				throw new Error("System audio capture needs macOS 14.2 or later");
			}
			this.tap = new SystemTap(
				this.tapBinary,
				this.sampleRate,
				(samples) => {
					if (!this.paused) this.tapQueue.push(samples);
				},
				(message) =>
					new Notice(`${message} — recording continues with the microphone only`)
			);
			this.hasTap = true;
			await this.tap.start();
		}

		const sources: MediaStream[] = [];
		if (wantsMic) {
			sources.push(await navigator.mediaDevices.getUserMedia({ audio: true }));
		}
		if (wantsSystem && !IS_MAC) {
			sources.push(await this.virtualCableStream());
		}
		if (sources.length === 0) return;

		this.context = new AudioContext({ sampleRate: this.sampleRate });
		this.streams = sources;

		let source: AudioNode;
		if (sources.length > 1) {
			const mixer = this.context.createGain();
			mixer.gain.value = MIX_GAIN;
			for (const s of sources) {
				this.context.createMediaStreamSource(s).connect(mixer);
			}
			source = mixer;
		} else {
			source = this.context.createMediaStreamSource(sources[0]);
		}

		// ScriptProcessorNode captures raw PCM Float32 samples
		this.processor = this.context.createScriptProcessor(4096, 1, 1);
		this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
			const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
			if (!this.aligned) {
				// The tap starts first (the mic can take ~1 s, e.g. AirPods switching to
				// headset mode). Drop tap audio from before the mic's first block so the
				// two sides line up when mixed.
				this.tapQueue.keepLast(chunk.length);
				this.aligned = true;
			}
			this.webQueue.push(chunk);
		};
		source.connect(this.processor);
		// Connect to destination (required for processing to fire)
		this.processor.connect(this.context.destination);
		this.hasWebAudio = true;
	}

	pause(): void {
		this.paused = true;
		this.context?.suspend();
	}

	resume(): void {
		this.paused = false;
		this.context?.resume();
	}

	/** Return accumulated samples since last drain, or null if empty. */
	drain(): Float32Array | null {
		return this.collect(false);
	}

	/** Stop capture and return any remaining samples. */
	async stop(): Promise<Float32Array | null> {
		await this.tap?.stop();
		this.tap = null;
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
		return this.collect(true);
	}

	/** Pull mixed samples from the active sources. `flush` takes everything. */
	private collect(flush: boolean): Float32Array | null {
		const web = this.webQueue;
		const tap = this.tapQueue;
		const mixing = this.hasWebAudio && this.hasTap;

		let n: number;
		if (!mixing) {
			n = this.hasWebAudio ? web.length : tap.length;
		} else {
			const lo = Math.min(web.length, tap.length);
			const hi = Math.max(web.length, tap.length);
			const maxSkew = MAX_SKEW_SECONDS * this.sampleRate;
			n = flush || hi - lo > maxSkew ? hi : lo;
		}
		if (n === 0) return null;

		if (!mixing) return (this.hasWebAudio ? web : tap).take(n);

		const out = web.take(n);
		const sys = tap.take(n);
		for (let i = 0; i < n; i++) out[i] = (out[i] + sys[i]) * MIX_GAIN;
		return out;
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
			new Notice(
				"Virtual audio cable not found. Install VB-CABLE for system audio capture."
			);
			throw new Error("Virtual audio cable not found");
		}
		return navigator.mediaDevices.getUserMedia({
			audio: { deviceId: { exact: cable.deviceId } },
		});
	}
}
