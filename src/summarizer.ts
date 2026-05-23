/**
 * Spawns `claude --print` to generate a structured meeting summary
 * from a transcript. Runs headless — no terminal or popups.
 */

const { execFile } = require("child_process") as typeof import("child_process");
const os = require("os") as typeof import("os");

// On Windows `claude` is installed as claude.cmd (an npm shim), which execFile
// can't resolve without a shell. shell:true is safe here — all args are constants.
const NEEDS_SHELL = process.platform === "win32";

const SUMMARY_PROMPT = `Summarize this meeting transcript. Output ONLY markdown — no preamble, no explanation, no closing.

Use these sections (omit any with no content):

### Action Items
- [ ] Specific actionable item

### Key Decisions
- Decision that was made

### Notes
- Other notable points

Rules:
- One line per item, keep concise
- Action items use checkbox format (- [ ])
- Omit empty sections entirely`;

export class Summarizer {
	private model: string;

	constructor(model: string) {
		this.model = model || "sonnet";
	}

	/** Check if claude CLI is available. */
	async isAvailable(): Promise<boolean> {
		return new Promise((resolve) => {
			execFile(
				"claude",
				["--version"],
				{ env: this.env(), timeout: 5_000, shell: NEEDS_SHELL },
				(err: NodeJS.ErrnoException | null) => {
					resolve(!err || err.code !== "ENOENT");
				}
			);
		});
	}

	/** Generate a structured summary from a transcript. */
	async summarize(transcript: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const proc = execFile(
				"claude",
				["--print", "--model", this.model],
				{
					timeout: 300_000,
					maxBuffer: 1024 * 1024,
					env: this.env(),
					shell: NEEDS_SHELL,
				},
				(err: Error | null, stdout: string, stderr: string) => {
					if (err) {
						reject(new Error(stderr?.trim() || err.message));
					} else if (stdout.trim()) {
						resolve(stdout.trim());
					} else {
						reject(new Error("Claude returned empty response"));
					}
				}
			);

			const input = `<transcript>\n${transcript}\n</transcript>\n\n${SUMMARY_PROMPT}`;
			proc.stdin?.write(input);
			proc.stdin?.end();
		});
	}

	/** Augmented PATH so Electron can find claude in common install locations. */
	private env(): Record<string, string | undefined> {
		const home = os.homedir();
		const extra =
			process.platform === "win32"
				? []
				: ["/usr/local/bin", "/opt/homebrew/bin", `${home}/.local/bin`];
		const sep = process.platform === "win32" ? ";" : ":";
		const PATH = [process.env.PATH, ...extra].filter(Boolean).join(sep);
		return { ...process.env, PATH };
	}
}
