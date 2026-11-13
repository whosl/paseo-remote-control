import { setTimeout as sleep } from "node:timers/promises";
import { ComputerUseError, ComputerUseToolError } from "../contract/errors";
import type { HelperPort } from "../contract/helper-port";
import type { HelperCommandName, HelperCommands, HelperUnsolicitedEvent } from "../contract/helper-protocol";
import type { ActionExecutionResult, AppStateResult } from "../contract/results";
import { assertLinuxAppAllowed } from "../linux/niri-port";

interface Display { id: number; x: number; y: number; width: number; height: number; name: string }
interface Window { id: number; app: string; title: string; focused: boolean; minimized: boolean; display: number; x: number; y: number; width: number; height: number }
interface Scene extends Record<string, unknown> { windows: Window[]; displays: Display[]; locked: boolean; sessionId: number }
type Params = Record<string, unknown> & { app?: string; windowId?: number; blockedBundleIds?: string[]; blockedBundleIdPrefixes?: string[] };
type Options = NonNullable<Parameters<HelperPort["request"]>[2]>;
export interface WindowsIO { request<T extends Record<string, unknown>>(command: string, payload?: Record<string, unknown>): Promise<T> }
const result = (reason: string): ActionExecutionResult => ({ ok: true, verification: { state: "unverified", reason } });
const lower = (value: string) => value.toLowerCase();

export function windowsKey(key: string): Record<string, unknown> {
  const parts = key.split("+"); const last = parts.pop()!;
  const aliases: Record<string, string> = { control: "ctrl", ctrl: "ctrl", shift: "shift", alt: "alt", option: "alt", super: "cmd", win: "cmd", windows: "cmd", meta: "cmd", cmd: "cmd", command: "cmd" };
  const modifiers = parts.map(part => { const mod = aliases[lower(part)]; if (!mod) throw new Error(`Unsupported modifier: ${part}`); return mod; });
  const codes: Record<string, number> = { return: 36, enter: 36, tab: 48, space: 49, escape: 53, esc: 53, backspace: 51, delete: 117, home: 115, end: 119, pageup: 116, pagedown: 121, left: 123, right: 124, up: 126, down: 125, arrowleft: 123, arrowright: 124, arrowup: 126, arrowdown: 125, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
  const keyCode = codes[lower(last)];
  if (keyCode !== undefined) return { type: "key", keyCode, modifiers };
  if (/^[a-z0-9]$/i.test(last)) return { type: "key", char: last, modifiers };
  throw new Error(`Unsupported Windows shortcut: ${key}`);
}

export function assertWindowsAppAllowed(id: string, p: Params): void {
  const canonical = /^(chrome|chromium|msedge|firefox|brave|opera|vivaldi|librewolf|quark)\.exe$/i.exec(id)?.[1]?.toLowerCase();
  const browser: Record<string, string> = { chrome: "com.google.Chrome", chromium: "org.chromium.Chromium", msedge: "com.microsoft.edgemac", firefox: "org.mozilla.firefox", librewolf: "org.mozilla.firefox", brave: "com.brave.Browser", opera: "com.operasoftware.Opera", vivaldi: "com.vivaldi.Vivaldi", quark: "com.google.Chrome" };
  assertLinuxAppAllowed(id, p);
  if (canonical && (p.blockedBundleIds ?? []).some(b => lower(b) === lower(browser[canonical]!))) throw new ComputerUseToolError("use_browser_tools", "Use Paseo browser tools, or explicitly allow browser apps in Remote Control settings.");
}

/** Focused-window visual tools over the same native input bridge used by human viewers. */
export class WindowsPort implements HelperPort {
  private stopped = false;
  constructor(private readonly io: WindowsIO, private readonly capture: WindowsIO = io) {}
  onEvent(_listener: (event: HelperUnsolicitedEvent) => void): () => void { return () => {}; }
  async stop(): Promise<void> { this.stopped = true; await this.io.request("release").catch(() => {}); }
  private async scene(signal?: AbortSignal): Promise<Scene> {
    signal?.throwIfAborted(); if (this.stopped) throw new Error("Windows agent backend stopped");
    const scene = await this.io.request<Scene>("scene"); signal?.throwIfAborted();
    if (scene.locked || scene.sessionId === 0) throw new ComputerUseError({ code: "permission_missing", message: "Unlock this user's Windows desktop. Session 0, lock screen and UAC secure desktop are not controllable." });
    return scene;
  }
  private resolve(scene: Scene, p: Params): Window {
    if (!p.app) throw new ComputerUseToolError("invalid_arguments", "Use the exact executable id from list_apps, for example notepad.exe.");
    assertWindowsAppAllowed(p.app, p);
    const candidates = scene.windows.filter(w => lower(w.app) === lower(p.app!));
    const window = p.windowId !== undefined ? candidates.find(w => w.id === p.windowId) : candidates.find(w => w.focused) ?? candidates[0];
    if (!window) throw new ComputerUseError({ code: p.windowId !== undefined ? "window_gone" : "app_not_found", message: "The intended Windows window is no longer available.", windowId: p.windowId });
    return window;
  }
  private visible(scene: Scene, window: Window, _p: Params): Display {
    if (!window.focused) throw new ComputerUseToolError("stale_state", "Focus changed. Call focus_window and get_app_state before input.");
    const display = scene.displays.find(d => d.id === window.display); if (!display) throw new Error("Target display disconnected");
    return display;
  }
  private async check(id: number, p: Params, signal?: AbortSignal): Promise<void> {
    const scene = await this.scene(signal); const window = scene.windows.find(w => w.id === id && w.focused);
    if (!window) throw new ComputerUseError({ code: "user_active", message: "The target window lost focus during input. Read again before retrying." });
    this.visible(scene, window, p);
  }
  private readCapture(command: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const operation = this.capture.request(command, payload);
    if (!signal) return operation;
    // A stuck PrintWindow may outlive cancellation, but it owns no input and must not delay takeover.
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    });
  }
  async focusWindow(p: { app: string; windowId?: number; blockedBundleIds: string[]; blockedBundleIdPrefixes?: string[] }, options: Options = {}): Promise<ActionExecutionResult> {
    const scene = await this.scene(options.signal); const window = this.resolve(scene, p);
    await this.io.request("focus", { window: window.id, expectedApp: window.app }); await sleep(100, undefined, { signal: options.signal });
    await this.check(window.id, p, options.signal);
    return { ok: true, verification: { state: "verified", reason: `focused Windows window ${window.id}; read get_app_state for coordinates` } };
  }
  async request<K extends HelperCommandName>(cmd: K, params: HelperCommands[K]["params"], options: Options = {}): Promise<HelperCommands[K]["result"]> {
    return this.handle(cmd, params as unknown as Params, options.signal) as Promise<HelperCommands[K]["result"]>;
  }
  private async handle(cmd: HelperCommandName, p: Params, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (cmd === "abort_tap.arm" || cmd === "abort_tap.disarm") return { armed: false };
    if (cmd === "end_turn" || cmd === "cancel") { await this.io.request("release"); return cmd === "cancel" ? { cancelled: true } : { ok: true }; }
    const scene = await this.scene(signal);
    if (cmd === "status") return { osVersion: "Windows", axTrusted: false, screenCaptureGranted: !!scene.displays.length, abortTapAvailable: false, inputSourceId: "windows-visual", isInputMethod: false, helperSourceHash: "windows-visual-v1" };
    const allowed = scene.windows.filter(w => { try { assertWindowsAppAllowed(w.app, p); return true; } catch { return false; } });
    if (cmd === "list_apps") return [...new Set(allowed.map(w => w.app))].map(id => ({ id, bundleIdentifier: id, displayName: id, isRunning: true }));
    if (cmd === "list_windows") return allowed.filter(w => !p.app || lower(w.app) === lower(p.app)).map(w => ({ id: w.id, app: w.app, bundleIdentifier: w.app, title: w.title }));
    const window = this.resolve(scene, p); const display = scene.displays.find(d => d.id === window.display);
    if (!display) throw new Error("Target display disconnected");
    if (cmd === "get_app_state") {
      let screenshot = null;
      if (p.includeScreenshot && window.focused) {
        this.visible(scene, window, p);
        const frame = await this.readCapture("frame", { display: display.id, maxWidth: 1600, quality: .65, expectedWindow: window.id, expectedApp: window.app }, signal);
        await this.check(window.id, p, signal);
        if (frame.locked || !frame.jpeg) throw new Error("Windows screenshot unavailable");
        screenshot = { url: `data:image/jpeg;base64,${frame.jpeg}`, width: display.width, height: display.height, scale: Number(frame.imageWidth) / display.width };
      }
      const state: AppStateResult = { app: { bundleIdentifier: window.app, displayName: window.app }, isActive: window.focused,
        appSpecificInstructions: "Windows visual backend: no UI Automation tree or element indexes. Screenshot shows only the target window rendered on a blank display-sized canvas; other apps are not captured. x/y are display-local physical pixels before screenshot scaling; divide image coordinates by its scale. Input outside the target window is refused. Some GPU apps do not support PrintWindow and may render blank. Ctrl shortcuts are normal; Win is the desktop key. Focus changes the real desktop. Use Take over, Pause all or Paseo Stop. No global Escape hook. UAC/elevated apps may refuse input; do not elevate to bypass it.",
        windowState: { text: `${window.app}; window ${window.id}; ${window.title}; ${window.focused ? "focused" : "not focused"}; display ${display.width}x${display.height}`, screenshot,
          rawTree: { window_id: window.id, window_title: window.title, window_bounds: { x: display.x, y: display.y, width: display.width, height: display.height }, other_windows: scene.windows.filter(w => w.app === window.app && w.id !== window.id).map(w => ({ id: w.id, title: w.title })), root: { native_id: `windows-${window.id}`, role: "AXWindow", name: window.title, children: [] } } } };
      return state;
    }
    this.visible(scene, window, p);
    if (cmd === "capture.signature") { const sig = await this.readCapture("signature", { display: display.id, expectedWindow: window.id, expectedApp: window.app }, signal); await this.check(window.id, p, signal); return { ...sig, windowId: window.id, windowWidth: display.width, windowHeight: display.height }; }
    if (!["click", "drag", "scroll", "press_key", "type_text", "paste_text"].includes(cmd) || p.nativeId !== undefined) throw new ComputerUseToolError("invalid_arguments", "Windows supports visual coordinates and keyboard input, not indexed controls.");
    const point = (x: unknown, y: unknown) => {
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= display.width || y >= display.height) throw new ComputerUseToolError("invalid_arguments", "Coordinates must be inside the target display's physical pixel bounds.");
      if (display.x + x < window.x || display.y + y < window.y || display.x + x >= window.x + window.width || display.y + y >= window.y + window.height) throw new ComputerUseToolError("invalid_arguments", "Coordinates are outside the intended window.");
      return { x: x / display.width, y: y / display.height };
    };
    const from = cmd === "drag" ? point(p.fromX, p.fromY) : cmd === "click" || cmd === "scroll" ? point(p.x, p.y) : undefined;
    const to = cmd === "drag" ? point(p.toX, p.toY) : undefined;
    const modifiers = (Array.isArray(p.holdKeys) ? p.holdKeys : []).map(k => ({ shift: "shift", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", super: "cmd", win: "cmd", cmd: "cmd", command: "cmd" })[lower(String(k))]);
    if (modifiers.some(m => !m)) throw new ComputerUseToolError("invalid_arguments", "Unsupported held modifier");
    let key: Record<string, unknown> | undefined;
    if (cmd === "press_key") { try { key = windowsKey(String(p.key)); } catch (e) { throw new ComputerUseToolError("invalid_arguments", String(e)); } }
    const send = async (events: Record<string, unknown>[]) => { await this.check(window.id, p, signal); await this.io.request("input", { display: display.id, events, expectedWindow: window.id, expectedApp: window.app }); signal?.throwIfAborted(); };
    try {
      if (cmd === "click") await send([{ type: "click", ...from, button: { r: "right", m: "middle", l: "left" }[String(p.button)] ?? p.button ?? "left", count: p.clickCount ?? 1, modifiers }]);
      if (cmd === "drag") {
        const modifierCodes: Record<string, number> = { ctrl: 59, shift: 56, alt: 58, cmd: 55 };
        if (modifiers.length) await send(modifiers.map(mod => ({ type: "key", keyCode: modifierCodes[mod!], down: true })));
        await send([{ type: "down", ...from, button: "left" }]);
        for (let i = 1; i <= 20; i++) { await send([{ type: "move", x: from!.x + (to!.x - from!.x) * i / 20, y: from!.y + (to!.y - from!.y) * i / 20 }]); await sleep(10, undefined, { signal }); }
        await send([{ type: "up", ...to, button: "left" }]);
      }
      if (cmd === "scroll") {
        const delta = { up: [0, -1], u: [0, -1], down: [0, 1], d: [0, 1], left: [-1, 0], l: [-1, 0], right: [1, 0], r: [1, 0] }[String(p.direction)];
        if (!delta) throw new ComputerUseToolError("invalid_arguments", "Unsupported scroll direction");
        await send([{ type: "scroll", ...from, dx: delta[0]! * Number(p.pages ?? 1) * display.width * .8, dy: delta[1]! * Number(p.pages ?? 1) * display.height * .8 }]);
      }
      if (key) await send([key]);
      if (cmd === "type_text") for (const char of String(p.text)) { await send([{ type: "text", text: char }]); await sleep(4, undefined, { signal }); }
      if (cmd === "paste_text") {
        if (p.format && p.format !== "text") throw new ComputerUseToolError("invalid_arguments", "Windows paste supports plain text only");
        const previous = await this.io.request("clipboard");
        if (previous.nonText) throw new ComputerUseToolError("invalid_arguments", "Copy plain text or clear the non-text clipboard before agent paste.");
        const text = String(p.text); let written: unknown;
        try {
          await this.check(window.id, p, signal); await this.io.request("clipboard-write", { text });
          written = (await this.io.request("clipboard")).changeCount;
          await send([windowsKey("Ctrl+v")]); await sleep(250, undefined, { signal });
        } finally {
          const now = await this.io.request("clipboard").catch(() => null);
          if (now && now.changeCount === written && now.text === text) await this.io.request("clipboard-write", { text: previous.text ?? "" });
        }
      }
      return result("Input delivered to the focused Windows window; inspect the returned screenshot.");
    } finally { await this.io.request("release").catch(() => {}); }
  }
}
