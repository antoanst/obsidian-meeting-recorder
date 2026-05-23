/**
 * Automatically switches macOS audio output to the correct Multi-Output Device
 * (for BlackHole capture) on record, and restores the original on stop.
 *
 * Windows: this is a no-op. The user is expected to set their default playback
 * device to VB-CABLE manually in Windows sound settings before recording.
 *
 * macOS requires: brew install switchaudio-osx
 */

import type { DeviceMapping } from "./settings";

const { execFile } = require("child_process") as typeof import("child_process");
const os = require("os") as typeof import("os");

const IS_MAC = process.platform === "darwin";

/** Augmented PATH so Electron can find Homebrew binaries. */
function shellEnv(): Record<string, string | undefined> {
	const home = os.homedir();
	const PATH = [
		process.env.PATH,
		"/usr/local/bin",
		"/opt/homebrew/bin",
		`${home}/.local/bin`,
	]
		.filter(Boolean)
		.join(":");
	return { ...process.env, PATH };
}

export class AudioSwitcher {
	private previousDevice: string | null = null;

	/**
	 * Detect current output, find the matching Multi-Output Device
	 * from mappings, and switch to it. No-op on non-macOS.
	 */
	async engage(mappings: DeviceMapping[]): Promise<void> {
		if (!IS_MAC) return;

		this.previousDevice = await this.getCurrentDevice();

		const match = mappings.find((m) =>
			this.previousDevice!.toLowerCase().includes(m.output.toLowerCase())
		);

		if (!match) {
			throw new Error(
				`No device mapping found for "${this.previousDevice}". ` +
				`Add a mapping in Meeting Recorder settings.`
			);
		}

		if (this.previousDevice === match.multiOutput) return;
		await this.setDevice(match.multiOutput);
	}

	/** Restore the original output device. No-op on non-macOS. */
	async restore(): Promise<void> {
		if (!IS_MAC) return;
		if (!this.previousDevice) return;
		await this.setDevice(this.previousDevice);
		this.previousDevice = null;
	}

	/** Check if SwitchAudioSource is available. Always true on non-macOS. */
	async isAvailable(): Promise<boolean> {
		if (!IS_MAC) return true;
		return new Promise((resolve) => {
			execFile("SwitchAudioSource", ["-c"], { env: shellEnv() }, (err: NodeJS.ErrnoException | null) => {
				resolve(!err || err.code !== "ENOENT");
			});
		});
	}

	private getCurrentDevice(): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(
				"SwitchAudioSource",
				["-c"],
				{ env: shellEnv() },
				(err: Error | null, stdout: string) => {
					if (err) reject(err);
					else resolve(stdout.trim());
				}
			);
		});
	}

	private setDevice(name: string): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile(
				"SwitchAudioSource",
				["-s", name],
				{ env: shellEnv() },
				(err: Error | null) => {
					if (err) reject(err);
					else resolve();
				}
			);
		});
	}
}
