/**
 * Runs the bundled `meeting-tap` helper (macOS 14.2+, source in native/meeting-tap.swift).
 * It captures everything the Mac plays through a Core Audio process tap and streams
 * mono Float32 PCM on stdout. The output device is never changed, so meeting apps keep
 * playing to whatever speakers/headphones the user picked.
 *
 * macOS asks once for "System Audio Recording" permission, attributed to Obsidian.
 */

import type { ChildProcess } from "child_process";

const { spawn } = require("child_process") as typeof import("child_process");
const fs = require("fs") as typeof import("fs");
const os = require("os") as typeof import("os");

export const TAP_BINARY = "meeting-tap";

/** Exit code the helper uses when the user has denied the permission. */
const EXIT_PERMISSION_DENIED = 3;

const PERMISSION_MESSAGE =
	"Obsidian isn't allowed to record system audio. Allow it in System Settings → " +
	"Privacy & Security → Screen & System Audio Recording, then try again.";

/** Process taps need macOS 14.2 (Darwin 23.2). */
export function tapSupported(): boolean {
	if (process.platform !== "darwin") return false;
	const [major, minor] = os.release().split(".").map(Number);
	return major > 23 || (major === 23 && minor >= 2);
}

export class SystemTap {
	private child: ChildProcess | null = null;
	private pending: Buffer = Buffer.alloc(0);
	private stopping = false;

	/**
	 * @param binary   Absolute path to the helper.
	 * @param rate     Output sample rate.
	 * @param onSamples Called with each block of samples as it arrives.
	 * @param onLost   Called if the helper dies mid-recording.
	 */
	constructor(
		private binary: string,
		private rate: number,
		private onSamples: (samples: Float32Array) => void,
		private onLost: (message: string) => void
	) {}

	/** Resolves once the helper reports it is capturing (after any permission prompt). */
	start(): Promise<void> {
		try {
			// iCloud/Dropbox sync can drop the executable bit.
			fs.chmodSync(this.binary, 0o755);
		} catch {
			return Promise.reject(
				new Error(`System audio helper not found: ${this.binary}`)
			);
		}

		return new Promise((resolve, reject) => {
			let ready = false;
			let lastError = "";
			let stderrLine = "";

			// stdin stays open as a pipe; the helper exits when it closes.
			const child = spawn(this.binary, ["--rate", String(this.rate)], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;

			child.stdout!.on("data", (data: Buffer) => this.handleAudio(data));

			child.stderr!.on("data", (data: Buffer) => {
				const lines = (stderrLine + data.toString()).split("\n");
				stderrLine = lines.pop() ?? "";
				for (const line of lines) {
					let event: { event?: string; message?: string };
					try {
						event = JSON.parse(line);
					} catch {
						continue;
					}
					if (event.event === "ready" && !ready) {
						ready = true;
						resolve();
					} else if (event.event === "error") {
						lastError = event.message ?? "";
					}
				}
			});

			child.on("error", (err) => {
				this.child = null;
				if (!ready) reject(err);
			});

			child.on("exit", (code) => {
				this.child = null;
				const message =
					code === EXIT_PERMISSION_DENIED
						? PERMISSION_MESSAGE
						: `System audio capture stopped${lastError ? `: ${lastError}` : ""}`;
				if (!ready) reject(new Error(message));
				else if (!this.stopping) this.onLost(message);
			});
		});
	}

	/** Stop the helper and wait for it to exit (force-kills after 3 s). */
	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.stopping = true;
		await new Promise<void>((resolve) => {
			const force = window.setTimeout(() => child.kill("SIGKILL"), 3000);
			child.once("exit", () => {
				window.clearTimeout(force);
				resolve();
			});
			child.kill("SIGTERM");
		});
		this.pending = Buffer.alloc(0);
	}

	/** stdout chunks can split a 4-byte sample; carry the remainder over. */
	private handleAudio(data: Buffer): void {
		const buf = this.pending.length ? Buffer.concat([this.pending, data]) : data;
		const usable = buf.length - (buf.length % 4);
		this.pending = buf.subarray(usable);
		if (usable === 0) return;

		// Copy into a fresh, 4-byte aligned buffer before viewing as Float32.
		const bytes = new Uint8Array(usable);
		bytes.set(buf.subarray(0, usable));
		this.onSamples(new Float32Array(bytes.buffer));
	}
}
