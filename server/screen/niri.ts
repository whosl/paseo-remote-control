import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { NiriIO, type NiriOutput } from "../host/niri-io";
import path from "node:path";
import { promisify } from "node:util";
import type { ScreenDisplay, ScreenInputEvent } from "../../shared/screen/rpc";
import { NativeCapture } from "./native-capture";
import { WebRtcWorker } from "./webrtc";

const run = promisify(execFile);
type Output = { name: string; make: string; model: string; current_mode: number | null; modes: { width: number; height: number }[]; logical: { x: number; y: number; width: number; height: number; scale: number; transform: string } | null };
type Display = ScreenDisplay & { output: string };
type Request = Record<string, unknown>;
const KEY_CODES: Record<number, number> = {
  0: 97, 1: 115, 2: 100, 3: 102, 4: 104, 5: 103, 6: 122, 7: 120, 8: 99, 9: 118, 11: 98,
  12: 113, 13: 119, 14: 101, 15: 114, 16: 121, 17: 116, 18: 49, 19: 50, 20: 51, 21: 52,
  22: 54, 23: 53, 24: 61, 25: 57, 26: 55, 27: 45, 28: 56, 29: 48, 30: 93, 31: 111,
  32: 117, 33: 91, 34: 105, 35: 112, 36: 0xff0d, 37: 108, 38: 106, 39: 39, 40: 107,
  41: 59, 42: 92, 43: 44, 44: 47, 45: 110, 46: 109, 47: 46, 48: 0xff09, 49: 32,
  50: 96, 51: 0xff08, 53: 0xff1b, 54: 0xffec, 55: 0xffeb, 56: 0xffe1, 57: 0xffe5,
  58: 0xffe9, 59: 0xffe3, 60: 0xffe2, 61: 0xffea, 62: 0xffe4, 65: 0xffae, 67: 0xffaa,
  69: 0xffab, 71: 0xff7f, 75: 0xffaf, 76: 0xff8d, 78: 0xffad, 81: 0xffbd, 82: 0xffb0,
  83: 0xffb1, 84: 0xffb2, 85: 0xffb3, 86: 0xffb4, 87: 0xffb5, 88: 0xffb6, 89: 0xffb7,
  91: 0xffb8, 92: 0xffb9, 96: 0xffc2, 97: 0xffc3, 98: 0xffc4, 99: 0xffc0, 100: 0xffc5,
  101: 0xffc6, 103: 0xffc8, 105: 0xffca, 106: 0xffcd, 107: 0xffcb, 109: 0xffc7, 111: 0xffc9,
  113: 0xffcc, 114: 0xff63, 115: 0xff50, 116: 0xff55, 117: 0xffff, 118: 0xffc1, 119: 0xff57,
  120: 0xffbf, 121: 0xff56, 122: 0xffbe, 123: 0xff51, 124: 0xff53, 125: 0xff54, 126: 0xff52,
};
const MODIFIERS: Record<string, number> = { shift: 0xffe1, ctrl: 0xffe3, alt: 0xffe9, cmd: 0xffeb };
const symbol = (char: string) => { const cp = char.codePointAt(0)!; return cp <= 255 ? cp : 0x01000000 + cp; };

function jpegSize(jpeg: Buffer): [number, number] {
  let offset = 2;
  while (offset + 9 < jpeg.length) {
    if (jpeg[offset] !== 0xff) break;
    const marker = jpeg[offset + 1]!;
    const size = jpeg.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return [jpeg.readUInt16BE(offset + 7), jpeg.readUInt16BE(offset + 5)];
    if (size < 2) break;
    offset += size + 2;
  }
  throw new Error("Native screen capture did not return a valid JPEG");
}

/** Niri's native capture and shared host input, carried by authenticated Paseo RPCs. */
export class NiriHelper {
  private environment: Promise<NodeJS.ProcessEnv | null> | null = null;
  private scene: { at: number; displays: Display[] } | null = null;
  private buttons = 0;
  private px = 0;
  private py = 0;
  private modifiers = new Set<number>();
  private held = new Map<string, number>();
  private inputTail: Promise<unknown> = Promise.resolve();
  private clipboardText: string | null = null;
  private clipboardVersion = 0;
  private lockState = { at: 0, locked: false };
  private stopped = false;

  private readonly capture: NativeCapture;
  private readonly video: WebRtcWorker;

  private inputDisplay: Display | null = null;

  constructor(private readonly log: (message: string) => void, private readonly io = new NiriIO()) { this.capture = new NativeCapture(log); this.video = new WebRtcWorker(log); }

  private env(): Promise<NodeJS.ProcessEnv | null> {
    return (this.environment ??= (async () => {
      if (process.platform !== "linux") return null;
      const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`;
      const imported = (await run("systemctl", ["--user", "show-environment"], { timeout: 5000 })).stdout;
      const selected: NodeJS.ProcessEnv = {};
      for (const line of imported.split("\n")) {
        const pos = line.indexOf("=");
        if (["WAYLAND_DISPLAY", "NIRI_SOCKET", "XDG_CURRENT_DESKTOP"].includes(line.slice(0, pos))) selected[line.slice(0, pos)] = line.slice(pos + 1);
      }
      if (!selected.NIRI_SOCKET || !selected.WAYLAND_DISPLAY || selected.XDG_CURRENT_DESKTOP !== "niri") return null;
      if (!(await readdir(runtime)).includes(path.basename(selected.NIRI_SOCKET))) return null;
      return { ...process.env, ...selected, XDG_RUNTIME_DIR: runtime, XDG_SESSION_TYPE: "wayland" };
    })().catch((error: Error) => { this.log(`Niri detection: ${error.message}`); return null; }));
  }

  async available(): Promise<boolean> { return (await this.env()) !== null; }

  private async locked(): Promise<boolean> {
    if (Date.now() - this.lockState.at < 1000) return this.lockState.locked;
    let locked = false;
    try {
      const session = (await run("loginctl", ["show-user", String(process.getuid?.()), "-p", "Display", "--value"], { timeout: 3000 })).stdout.trim();
      if (session) locked = (await run("loginctl", ["show-session", session, "-p", "LockedHint", "--value"], { timeout: 3000 })).stdout.trim() === "yes";
    } catch { /* Some manually started sessions do not publish a logind lock hint. */ }
    this.lockState = { at: Date.now(), locked };
    return locked;
  }

  private async displays(): Promise<Display[]> {
    if (this.scene && Date.now() - this.scene.at < 1000) return this.scene.displays;
    const env = (await this.env())!;
    const outputs = JSON.parse((await run(process.env.PASEO_CU_NIRI_BIN || "niri", ["msg", "--json", "outputs"], { env, timeout: 5000 })).stdout) as Record<string, Output>;
    const displays: Display[] = [];
    for (const item of Object.values(outputs)) {
      if (!item.logical || item.current_mode === null) continue;
      const mode = item.modes[item.current_mode]!;
      const rotated = /90|270/.test(item.logical.transform);
      const id = createHash("sha256").update(item.name).digest().readUInt32BE() & 0x7fffffff;
      displays.push({ id, ...item.logical, pixelWidth: rotated ? mode.height : mode.width, pixelHeight: rotated ? mode.width : mode.height,
        main: displays.length === 0, builtin: item.name.startsWith("eDP"), name: `${item.name} ${item.model}`.trim(), output: item.name });
    }
    if (!displays.length) throw new Error("No active Niri display is available");
    try {
      const focused = JSON.parse((await run(process.env.PASEO_CU_NIRI_BIN || "niri", ["msg", "--json", "focused-output"], { env, timeout: 3000 })).stdout) as { name?: string } | null;
      if (focused?.name && displays.some((display) => display.output === focused.name)) {
        for (const display of displays) display.main = display.output === focused.name;
      }
    } catch { /* Keep the first output as the fallback when no monitor is focused. */ }
    this.scene = { at: Date.now(), displays };
    return displays;
  }

  private toOutput(display: Display): NiriOutput {
    return { name: display.output, current_mode: 0, modes: [{ width: display.pixelWidth, height: display.pixelHeight }],
      logical: { x: display.x, y: display.y, width: display.width, height: display.height, scale: display.pixelWidth / display.width } };
  }
  private async ensureInput(display: Display): Promise<void> {
    if (this.stopped) throw new Error("Niri screen helper stopped");
    await this.io.input(this.toOutput(display)); this.inputDisplay = display;
  }
  private key(code: number, down: boolean): void { this.io.key(code, down); }

  private syncModifiers(names: string[] = []): void {
    const next = new Set(names.map((name) => MODIFIERS[name]).filter((value): value is number => value !== undefined));
    for (const code of this.modifiers) if (!next.has(code)) this.key(code, false);
    for (const code of next) if (!this.modifiers.has(code)) this.key(code, true);
    this.modifiers = next;
  }

  private pointer(mask = this.buttons): void {
    const d = this.inputDisplay;
    if (!d) throw new Error("No active input display");
    this.io.pointer(this.toOutput(d), this.px / Math.max(1, d.pixelWidth - 1) * d.width, this.py / Math.max(1, d.pixelHeight - 1) * d.height, mask);
  }

  private async sendInput(request: Request): Promise<Request> {
    const all = await this.displays();
    let display = all.find((candidate) => candidate.id === request.display) ?? all[0]!;
    const viewedDisplay = display;
    await this.ensureInput(display);
    let pointerDisplay: number | undefined;
    const events = request.events as ScreenInputEvent[];
    for (const event of events) {
      const text = event.type === "text" ? event.text : event.type === "key" ? event.char : undefined;
      if (text && [...text].some(char => char.charCodeAt(0) > 127)) throw new Error("Niri's keyboard layout cannot type this text directly. Use Paste to send Unicode text.");
    }
    for (const event of events) {
      if ("modifiers" in event) this.syncModifiers(event.modifiers);
      if ("x" in event && event.x !== undefined && "y" in event && event.y !== undefined) {
        let x = viewedDisplay.x + event.x * viewedDisplay.width;
        let y = viewedDisplay.y + event.y * viewedDisplay.height;
        const target = all.find((candidate) => x >= candidate.x && x < candidate.x + candidate.width && y >= candidate.y && y < candidate.y + candidate.height) ?? display;
        if (target.id !== display.id) { await this.ensureInput(target); display = target; pointerDisplay = target.id; }
        x = Math.max(0, Math.min(1, (x - display.x) / display.width));
        y = Math.max(0, Math.min(1, (y - display.y) / display.height));
        this.px = Math.round(x * (display.pixelWidth - 1)); this.py = Math.round(y * (display.pixelHeight - 1));
      }
      if (event.type === "move") this.pointer();
      else if (event.type === "down" || event.type === "up" || event.type === "click") {
        const bit = { left: 1, middle: 2, right: 4 }[event.button];
        if (event.type === "down") { this.buttons |= bit; this.pointer(); }
        else if (event.type === "up") { this.buttons &= ~bit; this.pointer(); }
        else for (let i = 0; i < (event.count ?? 1); i++) { this.pointer(this.buttons | bit); this.pointer(); }
      } else if (event.type === "scroll") {
        for (const [amount, negative, positive] of [[event.dy, 8, 16], [event.dx, 32, 64]]) {
          const count = Math.min(100, Math.max(0, Math.ceil(Math.abs(amount!) / 40)));
          for (let i = 0; i < count; i++) { this.pointer(this.buttons | (amount! < 0 ? negative! : positive!)); this.pointer(); }
        }
      } else if (event.type === "key") {
        const identity = event.keyCode !== undefined ? `key:${event.keyCode}` : `char:${event.char}`;
        const code = this.held.get(identity) ?? (event.keyCode !== undefined ? KEY_CODES[event.keyCode] : symbol(event.char!));
        if (code === undefined) throw new Error(`Unsupported physical key code ${event.keyCode}`);
        if (event.down !== false) this.key(code, true);
        if (event.down !== true) { this.key(code, false); this.held.delete(identity); }
        else this.held.set(identity, code);
      } else if (event.type === "text") {
        this.syncModifiers();
        for (const char of event.text) {
          const code = char === "\n" ? 0xff0d : char === "\t" ? 0xff09 : symbol(char);
          this.key(code, true); this.key(code, false);
        }
      } else if (event.type === "paste") {
        await this.writeClipboard(event.text);
        this.syncModifiers(event.shift ? ["ctrl", "shift"] : ["ctrl"]);
        this.key(118, true); this.key(118, false); this.syncModifiers();
      }
    }
    return { handled: events.length, ...(pointerDisplay !== undefined ? { pointerDisplay } : {}) };
  }

  private async writeClipboard(text: string): Promise<void> {
    const child = spawnProcess("wl-copy", ["--type", "text/plain;charset=utf-8"], { env: (await this.env())!, stdio: "pipe" });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { void terminateProcess(child); reject(new Error("Native clipboard write timed out")); }, 5000);
      let detail = "";
      child.stdout.resume(); child.stderr.on("data", (part: Buffer) => { detail += part.toString(); });
      child.on("error", (error: Error) => { clearTimeout(timer); reject(error); });
      child.on("exit", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Native clipboard write failed: ${detail}`)); });
      child.stdin.on("error", reject); child.stdin.end(text);
    });
  }

  async request<T extends Request>(command: string, request: Request = {}): Promise<T> {
    if (this.stopped) throw new Error("Niri screen helper stopped");
    const env = (await this.env())!;
    if (command === "status" || command === "request") {
      const displays = await this.displays();
      return { screenRecording: true, accessibility: true, locked: await this.locked(), displays, backend: "niri-native", captureMode: await this.capture.mode(), frameWait: true, webrtc: await this.video.available(), awaitingApproval: false } as unknown as T;
    }
    if (command === "rtc-offer") {
      const displays = await this.displays();
      const display = displays.find((item) => item.id === request.display) ?? displays.find((item) => item.main) ?? displays[0]!;
      const width = Math.max(2, Math.floor(Math.min(display.pixelWidth, Number(request.maxWidth)) / 2) * 2);
      return await this.video.offer({ output: display.output, width, fps: Number(request.fps), sdp: String(request.sdp) }, env) as T;
    }
    if (command === "rtc-ping" || command === "rtc-stop") return await this.video.command(command === "rtc-ping" ? "ping" : "stop", String(request.session)) as T;
    if (command === "input") {
      const result = this.inputTail.then(() => this.sendInput(request));
      this.inputTail = result.catch(() => {});
      return result as Promise<T>;
    }
    if (command === "clipboard") {
      let text = "";
      try { text = (await run("wl-paste", ["--no-newline", "--type", "text"], { env, timeout: 3000, maxBuffer: 1024 * 1024 })).stdout; }
      catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
      if (this.clipboardText !== text) { this.clipboardText = text; this.clipboardVersion++; }
      return { changeCount: this.clipboardVersion, text } as unknown as T;
    }
    if (command === "frame") {
      const displays = await this.displays();
      const display = displays.find((item) => item.id === request.display) ?? displays.find((item) => item.main) ?? displays[0]!;
      if (request.wake === true) await run(process.env.PASEO_CU_NIRI_BIN || "niri", ["msg", "action", "power-on-monitors"], { env, timeout: 3000 });
      const scale = Math.min(display.pixelWidth / display.width, Number(request.maxWidth) / display.width);
      const streamed = await this.capture.frame(display, Number(request.maxWidth), Number(request.quality), env, typeof request.since === "string" ? request.since : undefined, Number(request.waitMs) || 0);
      if (this.stopped) throw new Error("Niri screen helper stopped");
      const jpeg = streamed?.jpeg ?? await this.io.capture(this.toOutput(display), "jpeg", scale);
      const [imageWidth, imageHeight] = jpegSize(jpeg);
      const hash = streamed?.hash ?? createHash("sha256").update(jpeg).digest("hex");
      return { display, imageWidth, imageHeight, hash, bytes: jpeg.length, waitedMs: streamed?.waitedMs ?? 0, captureAgeMs: streamed ? Math.max(0, Date.now() - streamed.capturedAt) : undefined, captureMode: streamed ? "native-stream" : "screenshot", locked: await this.locked(), ...(request.since === hash ? { unchanged: true } : { jpeg: streamed?.base64 ?? jpeg.toString("base64") }) } as unknown as T;
    }
    throw new Error(`Unsupported native Niri request ${command}`);
  }

  private async closeInput(): Promise<void> {
    this.io.release(); this.inputDisplay = null;
    this.held.clear(); this.modifiers.clear(); this.buttons = 0;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.video.stop();
    await this.capture.stop();
    await this.inputTail.catch(() => {});
    await this.closeInput();
  }
}
