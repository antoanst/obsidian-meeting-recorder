import { encodeWav } from "./wav";

// Node.js modules available in Obsidian desktop (Electron)
const { execFile } = require("child_process") as typeof import("child_process");
const fs = require("fs") as typeof import("fs");
const nodePath = require("path") as typeof import("path");
const os = require("os") as typeof import("os");

/** Augmented PATH so Electron finds binaries in common install locations. */
function shellEnv(): Record<string, string | undefined> {
	const home = os.homedir();
	const extra =
		process.platform === "win32"
			? []
			: ["/usr/local/bin", "/opt/homebrew/bin", `${home}/.local/bin`];
	const sep = process.platform === "win32" ? ";" : ":";
	const PATH = [process.env.PATH, ...extra].filter(Boolean).join(sep);
	return { ...process.env, PATH };
}

/** Model setting value → GGML filename */
const MODEL_FILES: Record<string, string> = {
	"whisper-large-v3-turbo": "ggml-large-v3-turbo.bin",
	"whisper-large-v3": "ggml-large-v3.bin",
	"whisper-medium": "ggml-medium.bin",
	"whisper-small": "ggml-small.bin",
};

export class Transcriber {
	private binary: string;
	private modelPath: string;

	constructor(binary: string, modelsDir: string, modelKey: string) {
		this.binary = binary || "whisper-cli";
		const file = MODEL_FILES[modelKey] ?? "ggml-large-v3.bin";
		this.modelPath = modelsDir ? nodePath.join(modelsDir, file) : "";
	}

	/** Return an error message if setup is invalid, or null if OK. */
	async verify(): Promise<string | null> {
		if (!this.modelPath) {
			return "Whisper models directory not set (see Meeting Recorder settings)";
		}

		try {
			fs.accessSync(this.modelPath, fs.constants.R_OK);
		} catch {
			return `Model file not found: ${this.modelPath}`;
		}

		return new Promise((resolve) => {
			execFile(this.binary, ["--help"], { env: shellEnv() }, (err: NodeJS.ErrnoException | null) => {
				if (err?.code === "ENOENT") {
					resolve(`Whisper binary not found: ${this.binary}`);
				} else {
					resolve(null);
				}
			});
		});
	}

	/** Transcribe a PCM audio chunk. Returns the transcribed text. */
	async transcribe(
		samples: Float32Array,
		sampleRate: number
	): Promise<string> {
		const wav = encodeWav(samples, sampleRate);
		const prefix = nodePath.join(os.tmpdir(), `mr-${Date.now()}`);
		const wavFile = prefix + ".wav";
		const txtFile = prefix + ".txt";

		try {
			fs.writeFileSync(wavFile, wav);

			await new Promise<void>((resolve, reject) => {
				execFile(
					this.binary,
					[
						"-m",
						this.modelPath,
						"-f",
						wavFile,
						"--no-timestamps",
						"-otxt",
						"-of",
						prefix,
					],
					{ timeout: 120_000, env: shellEnv() },
					(err: Error | null) => (err ? reject(err) : resolve())
				);
			});

			return fs.readFileSync(txtFile, "utf-8").trim();
		} finally {
			try {
				fs.unlinkSync(wavFile);
			} catch {
				/* already cleaned */
			}
			try {
				fs.unlinkSync(txtFile);
			} catch {
				/* already cleaned */
			}
		}
	}
}
