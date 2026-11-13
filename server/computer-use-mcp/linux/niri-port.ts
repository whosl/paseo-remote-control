import { setTimeout as sleep } from "node:timers/promises";
import { ComputerUseError, ComputerUseToolError } from "../contract/errors";
import type { HelperPort } from "../contract/helper-port";
import type { HelperCommandName, HelperCommands, HelperUnsolicitedEvent } from "../contract/helper-protocol";
import type { ActionExecutionResult, AppStateResult } from "../contract/results";
import { NiriIO, parseKeyChord, type NiriOutput, type NiriScene, type NiriWindow } from "./niri-io";

type Params = Record<string, unknown> & { app?: string; windowId?: number; blockedBundleIds?: string[]; blockedBundleIdPrefixes?: string[] };
type Options = NonNullable<Parameters<HelperPort["request"]>[2]>;
const lower = (s: string) => s.trim().toLowerCase();
const browserId = (id: string): string | undefined => {
  const s = lower(id);
  if (/firefox|librewolf/.test(s)) return "org.mozilla.firefox";
  if (/chromium/.test(s)) return "org.chromium.Chromium";
  if (/google.chrome|google-chrome/.test(s)) return "com.google.Chrome";
  if (/brave/.test(s)) return "com.brave.Browser";
  if (/microsoft.edge|microsoft-edge/.test(s)) return "com.microsoft.edgemac";
  return undefined;
};
const passwordApp = (id: string) => /(?:^|[.\-_])(?:1password|bitwarden|keepassxc|keepass|seahorse|lastpass|nordpass|protonpass|dashlane)(?:$|[.\-_])/i.test(id);

export function assertLinuxAppAllowed(id: string, params: Params): void {
  const blocked = params.blockedBundleIds ?? []; const canonical = browserId(id);
  if (passwordApp(id) || blocked.some(b => lower(b) === lower(id)) || (params.blockedBundleIdPrefixes ?? []).some(p => lower(id).startsWith(lower(p)))) {
    throw new ComputerUseError({ code: "app_blocked", message: `App '${id}' is blocked.`, bundleId: id });
  }
  if (canonical && blocked.some(b => lower(b) === lower(canonical))) {
    throw new ComputerUseToolError("use_browser_tools", "Use Paseo browser tools, or enable web browsers in Computer Use settings.");
  }
}

/** Decode a small P6 image; the signature never contains or stores a full screenshot. */
export function ppmSignature(ppm: Buffer): string {
  let offset = 0;
  const word = (): string => {
    while (offset < ppm.length) {
      if (ppm[offset] === 35) { while (offset < ppm.length && ppm[offset] !== 10) offset++; }
      else if (ppm[offset]! <= 32) offset++;
      else break;
    }
    const start = offset; while (offset < ppm.length && ppm[offset]! > 32) offset++;
    return ppm.subarray(start, offset).toString();
  };
  const magic = word(), width = Number(word()), height = Number(word()), max = Number(word());
  if (magic !== "P6" || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || max !== 255) throw new Error("Invalid PPM capture");
  if (ppm[offset] === 13 && ppm[offset + 1] === 10) offset += 2; else offset++;
  if (ppm.length - offset !== width * height * 3) throw new Error("Truncated PPM capture");
  const bytes = Buffer.alloc(64 * 40);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 64; x++) {
    const p = offset + (Math.min(height - 1, Math.floor(y * height / 40)) * width + Math.min(width - 1, Math.floor(x * width / 64))) * 3;
    bytes[y * 64 + x] = Math.round(0.299 * ppm[p]! + 0.587 * ppm[p + 1]! + 0.114 * ppm[p + 2]!);
  }
  return bytes.toString("base64");
}

export interface NiriPortIO extends Pick<NiriIO, "environment" | "run" | "niri" | "scene" | "locked" | "capture" | "input" | "key" | "pointer" | "release" | "writeClipboard" | "stop"> {}

/** Visual, focused-display backend. It never claims to provide an accessibility tree. */
export class NiriPort implements HelperPort {
  private readonly listeners = new Set<(event: HelperUnsolicitedEvent) => void>();
  private actionTail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  constructor(private readonly io: NiriPortIO = new NiriIO()) {}

  onEvent(listener: (event: HelperUnsolicitedEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async stop(): Promise<void> { this.stopped = true; await this.io.stop(); this.listeners.clear(); }

  private async scene(signal?: AbortSignal): Promise<NiriScene> {
    signal?.throwIfAborted();
    if (this.stopped) throw new Error("Niri backend stopped");
    if (await this.io.locked()) throw new ComputerUseError({ code: "permission_missing", message: "The Niri session is locked. Unlock it locally before using Computer Use." });
    return this.io.scene(signal);
  }
  private resolve(scene: NiriScene, params: Params): NiriWindow {
    if (!params.app) throw new ComputerUseError({ code: "malformed_request", message: "An exact app id is required; use list_apps." });
    assertLinuxAppAllowed(params.app, params);
    const candidates = scene.windows.filter(w => lower(w.app_id ?? "") === lower(params.app!));
    const window = params.windowId !== undefined ? candidates.find(w => w.id === params.windowId) : candidates.find(w => w.is_focused) ?? candidates[0];
    if (!window) throw new ComputerUseError({ code: params.windowId !== undefined ? "window_gone" : "app_not_found", message: `No window of '${params.app}'${params.windowId !== undefined ? ` with id ${params.windowId}` : ""}.`, windowId: params.windowId });
    assertLinuxAppAllowed(window.app_id ?? "", params); return window;
  }
  private output(scene: NiriScene, window: NiriWindow): NiriOutput {
    const workspace = scene.workspaces.find(w => w.id === window.workspace_id);
    const output = scene.outputs.find(o => o.name === workspace?.output);
    if (!output?.logical || output.current_mode === null) throw new Error("The target window has no active output");
    return output;
  }
  private assertVisible(scene: NiriScene, window: NiriWindow, params: Params): NiriOutput {
    if (!window.is_focused) throw new ComputerUseToolError("stale_state", "The target window is not focused. Call focus_window, then get_app_state before acting.");
    const output = this.output(scene, window);
    const active = scene.workspaces.filter(w => w.output === output.name && w.is_active).map(w => w.id);
    for (const other of scene.windows) if (active.includes(other.workspace_id ?? -1)) assertLinuxAppAllowed(other.app_id ?? "", params);
    return output;
  }
  private async target(params: Params, signal?: AbortSignal): Promise<{ scene: NiriScene; window: NiriWindow; output: NiriOutput }> {
    const scene = await this.scene(signal); const window = this.resolve(scene, params);
    return { scene, window, output: this.assertVisible(scene, window, params) };
  }
  private async stillFocused(id: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const w = await this.io.niri<NiriWindow | null>(["focused-window"], signal);
    if (w?.id !== id) throw new ComputerUseError({ code: "user_active", message: "Focus changed during input. Read the target again before retrying." });
    if (await this.io.locked()) throw new ComputerUseError({ code: "permission_missing", message: "The session locked during input." });
  }
  async focusWindow(params: { app: string; windowId?: number; blockedBundleIds: string[]; blockedBundleIdPrefixes?: string[] }, options: Options = {}): Promise<ActionExecutionResult> {
    return this.serial(async () => {
      const scene = await this.scene(options.signal); const window = this.resolve(scene, params);
      await this.io.niri(["action", "focus-window", "--id", String(window.id)], options.signal);
      await sleep(120, undefined, { signal: options.signal });
      await this.stillFocused(window.id, options.signal);
      return { ok: true, verification: { state: "verified", reason: `focused window ${window.id}; call get_app_state for new coordinates` } };
    });
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const task = this.actionTail.then(fn); this.actionTail = task.catch(() => {}); return task; }
  async request<K extends HelperCommandName>(cmd: K, params: HelperCommands[K]["params"], options: Options = {}): Promise<HelperCommands[K]["result"]> {
    const p = params as unknown as Params;
    if (["click", "drag", "scroll", "press_key", "type_text", "paste_text"].includes(cmd)) {
      return this.serial(() => this.action(cmd, p, options.signal)) as Promise<HelperCommands[K]["result"]>;
    }
    return this.read(cmd, p, options.signal) as Promise<HelperCommands[K]["result"]>;
  }
  private async read(cmd: HelperCommandName, p: Params, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (cmd === "end_turn") { this.io.release(); return { ok: true }; }
    if (cmd === "abort_tap.arm" || cmd === "abort_tap.disarm") return { armed: false };
    if (cmd === "cancel") { this.io.release(); return { cancelled: true }; }
    const scene = await this.scene(signal);
    if (cmd === "status") {
      if (!scene.outputs.length) throw new Error("No active Niri display");
      await this.io.run("wayvnc", ["--version"], signal);
      return { osVersion: "Linux/Niri", axTrusted: false, screenCaptureGranted: true, abortTapAvailable: false, inputSourceId: "niri-native", isInputMethod: false, helperSourceHash: "niri-visual-v1" };
    }
    const allowed = scene.windows.filter(w => { try { assertLinuxAppAllowed(w.app_id ?? "", p); return true; } catch { return false; } });
    if (cmd === "list_apps") return [...new Set(allowed.map(w => w.app_id).filter((x): x is string => Boolean(x)))].map(id => ({ id, bundleIdentifier: id, displayName: id, isRunning: true }));
    if (cmd === "list_windows") return allowed.filter(w => !p.app || lower(w.app_id ?? "") === lower(p.app)).map(w => ({ id: w.id, app: w.app_id ?? "", bundleIdentifier: w.app_id ?? "", title: w.title ?? "" }));
    const window = this.resolve(scene, p); const output = this.output(scene, window); const logical = output.logical!;
    if (cmd === "get_app_state") {
      let screenshot = null;
      if (p.includeScreenshot && window.is_focused) {
        this.assertVisible(scene, window, p);
        const scale = Math.min(1, 1600 / logical.width);
        const jpeg = await this.io.capture(output, "jpeg", scale, signal);
        await this.stillFocused(window.id, signal);
        screenshot = { url: `data:image/jpeg;base64,${jpeg.toString("base64")}`, width: logical.width, height: logical.height, scale };
      }
      const state: AppStateResult = {
        app: { bundleIdentifier: window.app_id!, displayName: window.app_id! }, isActive: window.is_focused,
        appSpecificInstructions: `Linux/Niri visual backend: no indexed controls or AX tree. The screenshot covers the entire ${output.name} display, not a cropped window. Coordinates are display-local logical points; divide image pixels by its scale. focus_window changes the real desktop focus; get_app_state afterwards before clicking. Only focused windows accept input. Use Paseo Stop to cancel; a physical Escape stop hook is not installed.`,
        windowState: {
          text: `App: ${window.app_id}; window ${window.id}; ${window.is_focused ? "focused" : "not focused: call focus_window"}; capture viewport ${logical.width}x${logical.height}`,
          screenshot,
          rawTree: { window_id: window.id, window_title: window.title ?? "", focused_window: scene.windows.find(w => w.is_focused)?.app_id === window.app_id ? { id: scene.windows.find(w => w.is_focused)!.id, title: scene.windows.find(w => w.is_focused)!.title ?? "" } : undefined,
            other_windows: scene.windows.filter(w => w.app_id === window.app_id && w.id !== window.id).map(w => ({ id: w.id, title: w.title ?? "" })),
            window_bounds: { x: logical.x, y: logical.y, width: logical.width, height: logical.height },
            root: { native_id: `niri-window-${window.id}`, role: "AXWindow", name: window.title ?? "", children: [] } },
        },
      }; return state;
    }
    if (cmd === "capture.signature") {
      this.assertVisible(scene, window, p);
      const ppm = await this.io.capture(output, "ppm", 64 / logical.width, signal);
      await this.stillFocused(window.id, signal);
      return { signature: ppmSignature(ppm), width: 64, height: 40, windowId: window.id, windowWidth: logical.width, windowHeight: logical.height };
    }
    throw new ComputerUseToolError("invalid_arguments", "This Niri backend supports visual coordinates and keyboard input, not accessibility element operations.");
  }
  private async action(cmd: string, p: Params, signal?: AbortSignal): Promise<ActionExecutionResult> {
    if (p.nativeId !== undefined) throw new ComputerUseToolError("invalid_arguments", "Niri has no element indexes. Use display coordinates from get_app_state.");
    const { window, output } = await this.target(p, signal);
    const logical = output.logical!;
    const point = (x: unknown, y: unknown): [number, number] => {
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= logical.width || y >= logical.height) throw new ComputerUseToolError("invalid_arguments", `Coordinates must be inside ${logical.width}x${logical.height} logical display points.`);
      return [x, y];
    };
    // Validate all arguments before input connects or any key/button goes down.
    let chord: number[] | undefined; let hold: number[];
    try {
      chord = cmd === "press_key" ? parseKeyChord(String(p.key)) : undefined;
      hold = Array.isArray(p.holdKeys) ? p.holdKeys.map(k => parseKeyChord(String(k))).flat() : [];
    } catch (error) { throw new ComputerUseToolError("invalid_arguments", error instanceof Error ? error.message : String(error)); }
    const from = cmd === "drag" ? point(p.fromX, p.fromY) : cmd === "click" || cmd === "scroll" ? point(p.x, p.y) : undefined;
    const to = cmd === "drag" ? point(p.toX, p.toY) : undefined;
    if (cmd === "type_text" && [...String(p.text)].some(char => ![9, 10, 13].includes(char.charCodeAt(0)) && (char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126))) return this.paste(p, window, output, signal);
    if (cmd === "paste_text") return this.paste(p, window, output, signal);
    await this.io.input(output); await this.stillFocused(window.id, signal);
    try {
      for (const key of hold) this.io.key(key, true);
      if (cmd === "click") {
        const mask = p.button === "right" || p.button === "r" ? 4 : p.button === "middle" || p.button === "m" ? 2 : 1;
        for (let i = 0; i < Number(p.clickCount ?? 1); i++) { this.io.pointer(output, ...from!, mask); this.io.pointer(output, ...from!, 0); }
      } else if (cmd === "drag") {
        this.io.pointer(output, ...from!, 1);
        for (let i = 1; i <= 20; i++) { await this.stillFocused(window.id, signal); this.io.pointer(output, from![0] + (to![0] - from![0]) * i / 20, from![1] + (to![1] - from![1]) * i / 20, 1); await sleep(10, undefined, { signal }); }
      } else if (cmd === "scroll") {
        const mask = { up: 8, u: 8, down: 16, d: 16, left: 32, l: 32, right: 64, r: 64 }[String(p.direction)];
        if (!mask) throw new ComputerUseToolError("invalid_arguments", "Unknown scroll direction");
        for (let i = 0; i < Math.min(500, Math.ceil(Number(p.pages ?? 1) * 12)); i++) { signal?.throwIfAborted(); this.io.pointer(output, ...from!, mask); this.io.pointer(output, ...from!, 0); }
      } else if (cmd === "press_key") {
        for (const k of chord!) this.io.key(k, true); for (const k of [...chord!].reverse()) this.io.key(k, false);
      } else if (cmd === "type_text") {
        let i = 0;
        for (const char of String(p.text)) {
          signal?.throwIfAborted(); if (i++ % 20 === 0) await this.stillFocused(window.id, signal);
          const code = char === "\n" || char === "\r" ? 0xff0d : char === "\t" ? 0xff09 : char.codePointAt(0)!;
          this.io.key(code, true); this.io.key(code, false); await sleep(4, undefined, { signal });
        }
      }
      return { ok: true, verification: { state: "unverified", reason: "Input delivered to the focused Niri window; inspect the returned screenshot." }, inputPath: "keys" };
    } finally { this.io.release(); }
  }
  private async paste(p: Params, window: NiriWindow, output: NiriOutput, signal?: AbortSignal): Promise<ActionExecutionResult> {
    if (p.format && p.format !== "text") throw new ComputerUseToolError("invalid_arguments", "Niri paste supports plain text only.");
    let previous: string | null = null;
    try {
      const types = (await this.io.run("wl-paste", ["--list-types"], signal)).toString();
      if (!types.split("\n").some(t => /^text\/plain(?:;|$)/.test(t))) throw new ComputerUseToolError("invalid_arguments", "Clipboard contains non-text data. Copy plain text or clear it before using Niri paste.");
      previous = (await this.io.run("wl-paste", ["--no-newline", "--type", "text"], signal)).toString();
    } catch (e) { if ((e as { code?: unknown }).code !== 1) throw e; }
    const text = String(p.text);
    await this.io.input(output); await this.stillFocused(window.id, signal);
    try {
      await this.io.writeClipboard(text, signal);
      await this.stillFocused(window.id, signal);
      this.io.key(0xffe3, true); this.io.key(118, true); this.io.key(118, false); this.io.release();
      await sleep(250, undefined, { signal });
    } finally {
      this.io.release();
      try {
        if ((await this.io.run("wl-paste", ["--no-newline", "--type", "text"])).toString() === text) await this.io.writeClipboard(previous);
      } catch { /* Preserve a newer clipboard owner rather than overwriting it. */ }
    }
    return { ok: true, verification: { state: "unverified", reason: "Plain text pasted; inspect the returned screenshot." }, inputPath: "paste" };
  }
}
