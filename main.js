var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => MeetingRecorderPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");

// src/settings.ts
var import_obsidian = require("obsidian");
var IS_MAC = process.platform === "darwin";
var DEFAULT_SETTINGS = {
  whisperModel: "whisper-large-v3-turbo",
  whisperBinary: "whisper-cli",
  whisperModelsDir: "",
  claudeModel: "sonnet",
  audioInput: "mic",
  transcriptionInterval: 30
};
var MeetingRecorderSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Whisper").setHeading();
    new import_obsidian.Setting(containerEl).setName("Whisper binary").setDesc(
      "Path to the Whisper binary. If in PATH, just the name is enough."
    ).addText(
      (text) => text.setPlaceholder("whisper-cli").setValue(this.plugin.settings.whisperBinary).onChange(async (value) => {
        this.plugin.settings.whisperBinary = value;
        await this.plugin.saveSettings();
      })
    );
    const modelsDirSetting = new import_obsidian.Setting(containerEl).setName("Models directory").setDesc(
      this.plugin.settings.whisperModelsDir || "Folder containing GGML model files (e.g. ggml-large-v3.bin)."
    ).addText(
      (text) => text.setPlaceholder("/path/to/whisper-models").setValue(this.plugin.settings.whisperModelsDir).onChange(async (value) => {
        this.plugin.settings.whisperModelsDir = value.replace(
          /[\/\\]$/,
          ""
        );
        await this.plugin.saveSettings();
      })
    );
    if (IS_MAC) {
      modelsDirSetting.addButton(
        (btn) => btn.setButtonText("Choose folder").onClick(async () => {
          const { execFile: execFile3 } = require("child_process");
          const script = 'POSIX path of (choose folder with prompt "Select whisper models directory")';
          execFile3(
            "osascript",
            ["-e", script],
            (err, stdout) => {
              if (!err && stdout.trim()) {
                this.plugin.settings.whisperModelsDir = stdout.trim().replace(/\/$/, "");
                this.plugin.saveSettings();
                this.display();
              }
            }
          );
        })
      );
    }
    new import_obsidian.Setting(containerEl).setName("Transcription model").setDesc("Whisper model variant for local transcription.").addDropdown(
      (dropdown) => dropdown.addOption("whisper-large-v3-turbo", "Large v3 Turbo (recommended)").addOption("whisper-large-v3", "Large v3 (best accuracy)").addOption("whisper-medium", "Medium (faster)").addOption("whisper-small", "Small (fastest)").setValue(this.plugin.settings.whisperModel).onChange(async (value) => {
        this.plugin.settings.whisperModel = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Transcription interval").setDesc(
      "Seconds of audio to accumulate before running transcription."
    ).addSlider(
      (slider) => slider.setLimits(10, 120, 5).setValue(this.plugin.settings.transcriptionInterval).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.transcriptionInterval = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Audio").setHeading();
    new import_obsidian.Setting(containerEl).setName("Audio input").setDesc(
      IS_MAC ? `What audio to capture. "System" and "both" record everything your Mac plays (macOS 14.2+; macOS asks once for System Audio Recording permission).` : `What audio to capture. "System" and "both" require VB-CABLE (see README).`
    ).addDropdown(
      (dropdown) => dropdown.addOption("mic", "Microphone only").addOption("system", "System audio only").addOption("both", "Both (mic + system)").setValue(this.plugin.settings.audioInput).onChange(
        async (value) => {
          this.plugin.settings.audioInput = value;
          await this.plugin.saveSettings();
        }
      )
    );
    new import_obsidian.Setting(containerEl).setName("Claude").setHeading();
    new import_obsidian.Setting(containerEl).setName("Summary model").setDesc("Claude model for generating meeting summaries.").addDropdown(
      (dropdown) => dropdown.addOption("sonnet", "Sonnet (recommended)").addOption("opus", "Opus (complex meetings)").addOption("haiku", "Haiku (fast, shorter)").setValue(this.plugin.settings.claudeModel).onChange(async (value) => {
        this.plugin.settings.claudeModel = value;
        await this.plugin.saveSettings();
      })
    );
  }
};

// src/RecorderPanel.ts
var import_obsidian3 = require("obsidian");

// src/audio.ts
var import_obsidian2 = require("obsidian");

// src/system-tap.ts
var { spawn } = require("child_process");
var fs = require("fs");
var os = require("os");
var TAP_BINARY = "meeting-tap";
var EXIT_PERMISSION_DENIED = 3;
var PERMISSION_MESSAGE = "Obsidian isn't allowed to record system audio. Allow it in System Settings \u2192 Privacy & Security \u2192 Screen & System Audio Recording, then try again.";
function tapSupported() {
  if (process.platform !== "darwin") return false;
  const [major, minor] = os.release().split(".").map(Number);
  return major > 23 || major === 23 && minor >= 2;
}
var SystemTap = class {
  /**
   * @param binary   Absolute path to the helper.
   * @param rate     Output sample rate.
   * @param onSamples Called with each block of samples as it arrives.
   * @param onLost   Called if the helper dies mid-recording.
   */
  constructor(binary, rate, onSamples, onLost) {
    this.binary = binary;
    this.rate = rate;
    this.onSamples = onSamples;
    this.onLost = onLost;
    this.child = null;
    this.pending = Buffer.alloc(0);
    this.stopping = false;
  }
  /** Resolves once the helper reports it is capturing (after any permission prompt). */
  start() {
    try {
      fs.chmodSync(this.binary, 493);
    } catch (e) {
      return Promise.reject(
        new Error(`System audio helper not found: ${this.binary}`)
      );
    }
    return new Promise((resolve, reject) => {
      let ready = false;
      let lastError = "";
      let stderrLine = "";
      const child = spawn(this.binary, ["--rate", String(this.rate)], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;
      child.stdout.on("data", (data) => this.handleAudio(data));
      child.stderr.on("data", (data) => {
        var _a, _b;
        const lines = (stderrLine + data.toString()).split("\n");
        stderrLine = (_a = lines.pop()) != null ? _a : "";
        for (const line of lines) {
          let event;
          try {
            event = JSON.parse(line);
          } catch (e) {
            continue;
          }
          if (event.event === "ready" && !ready) {
            ready = true;
            resolve();
          } else if (event.event === "error") {
            lastError = (_b = event.message) != null ? _b : "";
          }
        }
      });
      child.on("error", (err) => {
        this.child = null;
        if (!ready) reject(err);
      });
      child.on("exit", (code) => {
        this.child = null;
        const message = code === EXIT_PERMISSION_DENIED ? PERMISSION_MESSAGE : `System audio capture stopped${lastError ? `: ${lastError}` : ""}`;
        if (!ready) reject(new Error(message));
        else if (!this.stopping) this.onLost(message);
      });
    });
  }
  /** Stop the helper and wait for it to exit (force-kills after 3 s). */
  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    await new Promise((resolve) => {
      const force = window.setTimeout(() => child.kill("SIGKILL"), 3e3);
      child.once("exit", () => {
        window.clearTimeout(force);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.pending = Buffer.alloc(0);
  }
  /** stdout chunks can split a 4-byte sample; carry the remainder over. */
  handleAudio(data) {
    const buf = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    const usable = buf.length - buf.length % 4;
    this.pending = buf.subarray(usable);
    if (usable === 0) return;
    const bytes = new Uint8Array(usable);
    bytes.set(buf.subarray(0, usable));
    this.onSamples(new Float32Array(bytes.buffer));
  }
};

// src/audio.ts
var VIRTUAL_CABLE_HINTS = ["cable", "vb-audio"];
var IS_MAC2 = process.platform === "darwin";
var MIX_GAIN = 0.7;
var MAX_SKEW_SECONDS = 2;
var SampleQueue = class {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }
  /** Remove and return the first n samples, zero-padded if fewer are queued. */
  take(n) {
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
  keepLast(n) {
    if (this.length > n) this.take(this.length - n);
  }
};
var AudioCapture = class {
  /** @param tapBinary Absolute path to the macOS `meeting-tap` helper. */
  constructor(tapBinary) {
    this.tapBinary = tapBinary;
    this.context = null;
    this.streams = [];
    this.processor = null;
    this.tap = null;
    this.paused = false;
    /** Web Audio graph output: mic, or (Windows) mic/cable mix. */
    this.webQueue = new SampleQueue();
    this.hasWebAudio = false;
    /** macOS system audio from the tap helper. */
    this.tapQueue = new SampleQueue();
    this.hasTap = false;
    this.aligned = false;
    this.sampleRate = 16e3;
  }
  async start(mode) {
    try {
      await this.open(mode);
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  async open(mode) {
    const wantsSystem = mode !== "mic";
    const wantsMic = mode !== "system";
    if (wantsSystem && IS_MAC2) {
      if (!tapSupported()) {
        throw new Error("System audio capture needs macOS 14.2 or later");
      }
      this.tap = new SystemTap(
        this.tapBinary,
        this.sampleRate,
        (samples) => {
          if (!this.paused) this.tapQueue.push(samples);
        },
        (message) => new import_obsidian2.Notice(`${message} \u2014 recording continues with the microphone only`)
      );
      this.hasTap = true;
      await this.tap.start();
    }
    const sources = [];
    if (wantsMic) {
      sources.push(await navigator.mediaDevices.getUserMedia({ audio: true }));
    }
    if (wantsSystem && !IS_MAC2) {
      sources.push(await this.virtualCableStream());
    }
    if (sources.length === 0) return;
    this.context = new AudioContext({ sampleRate: this.sampleRate });
    this.streams = sources;
    let source;
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
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
      if (!this.aligned) {
        this.tapQueue.keepLast(chunk.length);
        this.aligned = true;
      }
      this.webQueue.push(chunk);
    };
    source.connect(this.processor);
    this.processor.connect(this.context.destination);
    this.hasWebAudio = true;
  }
  pause() {
    var _a;
    this.paused = true;
    (_a = this.context) == null ? void 0 : _a.suspend();
  }
  resume() {
    var _a;
    this.paused = false;
    (_a = this.context) == null ? void 0 : _a.resume();
  }
  /** Return accumulated samples since last drain, or null if empty. */
  drain() {
    return this.collect(false);
  }
  /** Stop capture and return any remaining samples. */
  async stop() {
    var _a, _b;
    await ((_a = this.tap) == null ? void 0 : _a.stop());
    this.tap = null;
    (_b = this.processor) == null ? void 0 : _b.disconnect();
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
  collect(flush) {
    const web = this.webQueue;
    const tap = this.tapQueue;
    const mixing = this.hasWebAudio && this.hasTap;
    let n;
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
  async virtualCableStream() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cable = devices.find(
      (d) => d.kind === "audioinput" && VIRTUAL_CABLE_HINTS.some(
        (hint) => d.label.toLowerCase().includes(hint)
      )
    );
    if (!cable) {
      new import_obsidian2.Notice(
        "Virtual audio cable not found. Install VB-CABLE for system audio capture."
      );
      throw new Error("Virtual audio cable not found");
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: cable.deviceId } }
    });
  }
};

// src/wav.ts
function encodeWav(samples, sampleRate) {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 32768 : clamped * 32767;
    buf.writeInt16LE(Math.round(int16), offset);
    offset += 2;
  }
  return buf;
}

// src/transcriber.ts
var { execFile } = require("child_process");
var fs2 = require("fs");
var nodePath = require("path");
var os2 = require("os");
function shellEnv() {
  const home = os2.homedir();
  const extra = process.platform === "win32" ? [] : ["/usr/local/bin", "/opt/homebrew/bin", `${home}/.local/bin`];
  const sep = process.platform === "win32" ? ";" : ":";
  const PATH = [process.env.PATH, ...extra].filter(Boolean).join(sep);
  return { ...process.env, PATH };
}
var MODEL_FILES = {
  "whisper-large-v3-turbo": "ggml-large-v3-turbo.bin",
  "whisper-large-v3": "ggml-large-v3.bin",
  "whisper-medium": "ggml-medium.bin",
  "whisper-small": "ggml-small.bin"
};
var Transcriber = class {
  constructor(binary, modelsDir, modelKey) {
    var _a;
    this.binary = binary || "whisper-cli";
    const file = (_a = MODEL_FILES[modelKey]) != null ? _a : "ggml-large-v3.bin";
    this.modelPath = modelsDir ? nodePath.join(modelsDir, file) : "";
  }
  /** Return an error message if setup is invalid, or null if OK. */
  async verify() {
    if (!this.modelPath) {
      return "Whisper models directory not set (see Meeting Recorder settings)";
    }
    try {
      fs2.accessSync(this.modelPath, fs2.constants.R_OK);
    } catch (e) {
      return `Model file not found: ${this.modelPath}`;
    }
    return new Promise((resolve) => {
      execFile(this.binary, ["--help"], { env: shellEnv() }, (err) => {
        if ((err == null ? void 0 : err.code) === "ENOENT") {
          resolve(`Whisper binary not found: ${this.binary}`);
        } else {
          resolve(null);
        }
      });
    });
  }
  /** Transcribe a PCM audio chunk. Returns the transcribed text. */
  async transcribe(samples, sampleRate) {
    const wav = encodeWav(samples, sampleRate);
    const prefix = nodePath.join(os2.tmpdir(), `mr-${Date.now()}`);
    const wavFile = prefix + ".wav";
    const txtFile = prefix + ".txt";
    try {
      fs2.writeFileSync(wavFile, wav);
      await new Promise((resolve, reject) => {
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
            prefix
          ],
          { timeout: 12e4, env: shellEnv() },
          (err) => err ? reject(err) : resolve()
        );
      });
      return fs2.readFileSync(txtFile, "utf-8").trim();
    } finally {
      try {
        fs2.unlinkSync(wavFile);
      } catch (e) {
      }
      try {
        fs2.unlinkSync(txtFile);
      } catch (e) {
      }
    }
  }
};

// src/summarizer.ts
var { execFile: execFile2 } = require("child_process");
var os3 = require("os");
var NEEDS_SHELL = process.platform === "win32";
var SUMMARY_PROMPT = `Summarize this meeting transcript. Output ONLY markdown \u2014 no preamble, no explanation, no closing.

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
var Summarizer = class {
  constructor(model) {
    this.model = model || "sonnet";
  }
  /** Check if claude CLI is available. */
  async isAvailable() {
    return new Promise((resolve) => {
      execFile2(
        "claude",
        ["--version"],
        { env: this.env(), timeout: 5e3, shell: NEEDS_SHELL },
        (err) => {
          resolve(!err || err.code !== "ENOENT");
        }
      );
    });
  }
  /** Generate a structured summary from a transcript. */
  async summarize(transcript) {
    return new Promise((resolve, reject) => {
      var _a, _b;
      const proc = execFile2(
        "claude",
        ["--print", "--model", this.model],
        {
          timeout: 3e5,
          maxBuffer: 1024 * 1024,
          env: this.env(),
          shell: NEEDS_SHELL
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error((stderr == null ? void 0 : stderr.trim()) || err.message));
          } else if (stdout.trim()) {
            resolve(stdout.trim());
          } else {
            reject(new Error("Claude returned empty response"));
          }
        }
      );
      const input = `<transcript>
${transcript}
</transcript>

${SUMMARY_PROMPT}`;
      (_a = proc.stdin) == null ? void 0 : _a.write(input);
      (_b = proc.stdin) == null ? void 0 : _b.end();
    });
  }
  /** Augmented PATH so Electron can find claude in common install locations. */
  env() {
    const home = os3.homedir();
    const extra = process.platform === "win32" ? [] : ["/usr/local/bin", "/opt/homebrew/bin", `${home}/.local/bin`];
    const sep = process.platform === "win32" ? ";" : ":";
    const PATH = [process.env.PATH, ...extra].filter(Boolean).join(sep);
    return { ...process.env, PATH };
  }
};

// src/RecorderPanel.ts
var GEAR_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
var RecorderPanel = class {
  constructor(plugin) {
    this.containerEl = null;
    this.sourcePath = "";
    this.state = "idle";
    this.timerInterval = null;
    this.elapsedSeconds = 0;
    this.timerEl = null;
    // Audio & transcription
    this.audio = null;
    this.transcriber = null;
    this.transcriptionTimer = null;
    this.isTranscribing = false;
    this.recordingFile = null;
    this.fullTranscript = [];
    this.plugin = plugin;
  }
  /**
   * Attach to a new DOM container. Called by the code block processor
   * each time Obsidian re-renders the block. Preserves recording state.
   */
  attach(containerEl, sourcePath) {
    this.containerEl = containerEl;
    this.sourcePath = sourcePath;
    this.render();
  }
  /** Full teardown — stops recording. */
  detach() {
    this.stopRecording();
    this.state = "idle";
    this.elapsedSeconds = 0;
  }
  // ── Rendering ──
  render() {
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
  renderIdle() {
    if (!this.containerEl) return;
    const row = this.containerEl.createDiv({ cls: "mr-panel-row" });
    const recordBtn = row.createEl("button", { cls: "mr-btn mr-btn-record" });
    recordBtn.createSpan({ cls: "mr-record-dot" });
    recordBtn.createSpan({ text: "Record" });
    recordBtn.addEventListener("click", () => this.onRecord());
    this.addGearButton(row);
  }
  renderRecording() {
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
  renderPaused() {
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
  renderProcessing() {
    if (!this.containerEl) return;
    const row = this.containerEl.createDiv({ cls: "mr-panel-row mr-processing-row" });
    const spinner = row.createDiv({ cls: "mr-spinner" });
    for (let i = 0; i < 3; i++) {
      spinner.createDiv({ cls: "mr-spinner-dot" });
    }
    row.createSpan({ cls: "mr-processing-text", text: "Finalizing transcript\u2026" });
    const barContainer = this.containerEl.createDiv({ cls: "mr-panel-row" });
    const track = barContainer.createDiv({ cls: "mr-progress-track" });
    track.createDiv({ cls: "mr-progress-bar" });
  }
  addGearButton(parent) {
    const btn = parent.createEl("button", { cls: "mr-settings-btn" });
    btn.innerHTML = GEAR_SVG;
    btn.setAttribute("aria-label", "Meeting Recorder settings");
    btn.addEventListener("click", () => {
      this.plugin.app.setting.open();
      this.plugin.app.setting.openTabById("meeting-recorder");
    });
  }
  // ── Actions ──
  async onRecord() {
    var _a;
    const btn = (_a = this.containerEl) == null ? void 0 : _a.querySelector(".mr-btn-record");
    if (btn) {
      btn.empty();
      btn.createSpan({ cls: "mr-record-spinner" });
      btn.createSpan({ text: "Starting\u2026" });
      btn.setAttribute("disabled", "true");
    }
    const s = this.plugin.settings;
    const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(file instanceof import_obsidian3.TFile)) {
      new import_obsidian3.Notice("Cannot find the current file");
      return;
    }
    this.recordingFile = file;
    this.fullTranscript = [];
    this.transcriber = new Transcriber(s.whisperBinary, s.whisperModelsDir, s.whisperModel);
    const err = await this.transcriber.verify();
    if (err) {
      new import_obsidian3.Notice(err);
      this.transcriber = null;
      return;
    }
    this.audio = new AudioCapture(this.plugin.tapBinaryPath());
    try {
      await this.audio.start(s.audioInput);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Audio capture failed";
      new import_obsidian3.Notice(msg);
      this.audio = null;
      this.transcriber = null;
      this.render();
      return;
    }
    this.state = "recording";
    this.elapsedSeconds = 0;
    this.startTimer();
    this.startTranscriptionLoop();
    this.render();
  }
  onPause() {
    var _a;
    (_a = this.audio) == null ? void 0 : _a.pause();
    this.stopTimer();
    this.stopTranscriptionLoop();
    this.state = "paused";
    this.render();
  }
  onResume() {
    var _a;
    (_a = this.audio) == null ? void 0 : _a.resume();
    this.startTimer();
    this.startTranscriptionLoop();
    this.state = "recording";
    this.render();
  }
  async onStop() {
    var _a, _b;
    this.stopTimer();
    this.stopTranscriptionLoop();
    try {
      const remaining = (_b = await ((_a = this.audio) == null ? void 0 : _a.stop())) != null ? _b : null;
      this.audio = null;
      this.state = "processing";
      this.render();
      if (remaining && remaining.length > 0 && this.transcriber) {
        try {
          const text = await this.transcriber.transcribe(remaining, 16e3);
          if (text) this.fullTranscript.push(text);
        } catch (e) {
          console.error("Final transcription failed:", e);
        }
      }
      this.transcriber = null;
      await this.finalizeTranscript();
      await this.generateSummary();
      await this.replaceCodeBlock();
    } finally {
      if (this.audio) {
        await this.audio.stop();
        this.audio = null;
      }
      this.transcriber = null;
      this.recordingFile = null;
      this.fullTranscript = [];
      this.state = "idle";
      this.elapsedSeconds = 0;
    }
  }
  async stopRecording() {
    this.stopTimer();
    this.stopTranscriptionLoop();
    if (this.audio) {
      await this.audio.stop();
      this.audio = null;
    }
    this.transcriber = null;
    this.recordingFile = null;
    this.fullTranscript = [];
  }
  // ── Timer ──
  startTimer() {
    this.stopTimer();
    this.timerInterval = window.setInterval(() => {
      this.elapsedSeconds++;
      this.updateTimerDisplay();
    }, 1e3);
  }
  stopTimer() {
    if (this.timerInterval !== null) {
      window.clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }
  updateTimerDisplay() {
    if (!this.timerEl) return;
    const mins = Math.floor(this.elapsedSeconds / 60).toString().padStart(2, "0");
    const secs = (this.elapsedSeconds % 60).toString().padStart(2, "0");
    this.timerEl.textContent = `${mins}:${secs}`;
  }
  // ── Transcription loop ──
  startTranscriptionLoop() {
    this.stopTranscriptionLoop();
    const ms = this.plugin.settings.transcriptionInterval * 1e3;
    this.transcriptionTimer = window.setInterval(() => {
      this.transcribePending();
    }, ms);
  }
  stopTranscriptionLoop() {
    if (this.transcriptionTimer !== null) {
      window.clearInterval(this.transcriptionTimer);
      this.transcriptionTimer = null;
    }
  }
  async transcribePending() {
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
      new import_obsidian3.Notice("Transcription failed for a segment \u2014 recording continues");
    } finally {
      this.isTranscribing = false;
    }
  }
  // ── Summarization ──
  async generateSummary() {
    if (!this.recordingFile || this.fullTranscript.length === 0) return;
    const summarizer = new Summarizer(this.plugin.settings.claudeModel);
    if (!await summarizer.isAvailable()) {
      new import_obsidian3.Notice("Claude CLI not found \u2014 skipping summary");
      return;
    }
    this.updateProcessingText("Generating summary\u2026");
    try {
      const transcript = this.fullTranscript.join("\n\n");
      const summary = await summarizer.summarize(transcript);
      if (summary) {
        await this.writeSummaryToFile(summary);
      }
    } catch (e) {
      console.error("Summary generation failed:", e);
      new import_obsidian3.Notice("Summary generation failed \u2014 transcript saved");
    }
  }
  updateProcessingText(text) {
    var _a;
    const el = (_a = this.containerEl) == null ? void 0 : _a.querySelector(".mr-processing-text");
    if (el) el.textContent = text;
  }
  async writeSummaryToFile(summary) {
    if (!this.recordingFile) return;
    await this.plugin.app.vault.process(this.recordingFile, (content) => {
      const calloutStart = "> [!quote]- Transcript";
      const idx = content.indexOf(calloutStart);
      if (idx === -1) {
        return content.trimEnd() + "\n\n" + summary;
      }
      return content.slice(0, idx).trimEnd() + "\n\n" + summary + "\n\n" + content.slice(idx);
    });
  }
  // ── File I/O ──
  async writeTranscriptToFile() {
    if (!this.recordingFile) return;
    const text = this.fullTranscript.join("\n\n");
    const section = `<!-- mr-recording -->
${text}
<!-- /mr-recording -->`;
    await this.plugin.app.vault.process(this.recordingFile, (content) => {
      const re = /<!-- mr-recording -->[\s\S]*?<!-- \/mr-recording -->/;
      if (re.test(content)) {
        return content.replace(re, section);
      }
      return content.trimEnd() + "\n\n" + section;
    });
  }
  async finalizeTranscript() {
    if (!this.recordingFile || this.fullTranscript.length === 0) return;
    const text = this.fullTranscript.join("\n\n");
    const lines = text.split("\n").map((l) => `> ${l}`);
    const callout = `> [!quote]- Transcript
${lines.join("\n")}`;
    await this.plugin.app.vault.process(this.recordingFile, (content) => {
      const re = /<!-- mr-recording -->[\s\S]*?<!-- \/mr-recording -->/;
      if (re.test(content)) {
        return content.replace(re, callout);
      }
      return content.trimEnd() + "\n\n" + callout;
    });
  }
  async replaceCodeBlock() {
    if (!this.recordingFile) return;
    await this.plugin.app.vault.process(this.recordingFile, (content) => {
      const re = /```meeting-recorder\n[\s\S]*?```\n?/;
      if (re.test(content)) {
        return content.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
      }
      return content;
    });
  }
};

// src/main.ts
var nodePath2 = require("path");
var MeetingRecorderPlugin = class extends import_obsidian4.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.panel = new RecorderPanel(this);
  }
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new MeetingRecorderSettingTab(this.app, this));
    this.registerMarkdownCodeBlockProcessor(
      "meeting-recorder",
      (source, el, ctx) => {
        el.addClass("mr-panel");
        this.panel.attach(el, ctx.sourcePath);
      }
    );
    this.addCommand({
      id: "insert-meeting-recorder",
      name: "Insert Meeting Recorder",
      editorCallback: (editor) => {
        editor.replaceSelection(
          "```meeting-recorder\n```\n"
        );
      }
    });
  }
  onunload() {
    this.panel.detach();
  }
  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
    delete this.settings.deviceMappings;
  }
  /** Absolute path to the macOS system-audio helper shipped next to main.js. */
  tapBinaryPath() {
    var _a;
    const adapter = this.app.vault.adapter;
    return nodePath2.join(adapter.getBasePath(), (_a = this.manifest.dir) != null ? _a : "", TAP_BINARY);
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
