import { describe, expect, it } from "vitest";
import { createComputerUseService } from "../server/computer-use-mcp";
import { NiriPort, assertLinuxAppAllowed, ppmSignature, type NiriPortIO } from "../server/computer-use-mcp/linux/niri-port";
import { NiriIO, parseKeyChord, type NiriScene } from "../server/computer-use-mcp/linux/niri-io";
import { ControlLock } from "../server/computer-use-mcp/policy/lock";
import { ComputerUseMcpServer } from "../server/computer-use-mcp/mcp/server";

const ppm = Buffer.concat([Buffer.from("P6\n2 2\n255\n"), Buffer.from([10, 10, 10, 255, 255, 255, 0, 0, 0, 128, 128, 128])]);
function fake() {
  const scene: NiriScene = {
    windows: [{ id: 42, app_id: "cu-fixture", title: "Fixture", workspace_id: 1, is_focused: true, layout: { window_size: [700, 500] } }],
    workspaces: [{ id: 1, output: "DP-1", is_active: true }],
    outputs: [{ name: "DP-1", current_mode: 0, modes: [{ width: 1600, height: 1200 }], logical: { x: -800, y: 0, width: 800, height: 600, scale: 2 } }],
  };
  const calls: { method: string; args?: unknown }[] = []; const held = new Set<number>();
  let locked = false; let clipboard: string | null = "clipboard before"; let nonText = false;
  const io: NiriPortIO = {
    environment: async () => ({}),
    scene: async () => structuredClone(scene), locked: async () => locked,
    async niri<T>(args: string[]): Promise<T> {
      calls.push({ method: "niri", args });
      if (args[0] === "focused-window") return structuredClone(scene.windows.find(w => w.is_focused) ?? null) as T;
      if (args[0] === "action") { const id = Number(args.at(-1)); for (const w of scene.windows) w.is_focused = w.id === id; }
      return null as T;
    },
    async run(cmd, args) {
      calls.push({ method: cmd, args });
      if (cmd === "wl-paste") {
        if (clipboard === null) throw Object.assign(new Error("empty"), { code: 1 });
        return Buffer.from(args.includes("--list-types") ? nonText ? "image/png\n" : "text/plain;charset=utf-8\n" : clipboard);
      }
      return Buffer.from("ok");
    },
    async capture(_output, format) { calls.push({ method: "capture", args: format }); return format === "ppm" ? ppm : Buffer.from("jpeg"); },
    async input() { calls.push({ method: "input" }); },
    key(code, down) { calls.push({ method: "key", args: [code, down] }); if (down) held.add(code); else held.delete(code); },
    pointer(_o, x, y, buttons) { calls.push({ method: "pointer", args: [x, y, buttons] }); },
    release() { calls.push({ method: "release" }); held.clear(); },
    async writeClipboard(text) { clipboard = text; calls.push({ method: "clipboard", args: text }); },
    async stop() { held.clear(); },
  };
  return { scene, io, calls, held, setLocked: (v: boolean) => { locked = v; }, setNonText: () => { nonText = true; }, clipboard: () => clipboard };
}
const args = { app: "cu-fixture", blockedBundleIds: [] as string[] };

describe("Niri capture and input", () => {
  it("accepts Niri's empty success response for action commands", async () => {
    class ActionIO extends NiriIO { override async run() { return Buffer.alloc(0); } }
    await expect(new ActionIO().niri(["action", "focus-window", "--id", "42"])).resolves.toBeUndefined();
  });
  it("parses PPM without discarding a whitespace-valued first pixel", () => {
    const sig = Buffer.from(ppmSignature(ppm), "base64");
    expect(sig).toHaveLength(2560); expect(sig[0]).toBe(10); expect(sig[63]).toBe(255);
    expect(() => ppmSignature(ppm.subarray(0, -1))).toThrow("Truncated");
  });
  it("validates complete key chords before posting keys", () => {
    expect(parseKeyChord("Ctrl+Shift+s")).toEqual([0xffe3, 0xffe1, 115]);
    expect(parseKeyChord("Super+Return")).toEqual([0xffeb, 0xff0d]);
    expect(() => parseKeyChord("Ctrl+made-up")).toThrow("Unknown key");
  });
  it("reports visual capabilities without pretending AX or Escape are available", async () => {
    const f = fake(); const port = new NiriPort(f.io); const status = await port.request("status", {});
    expect(status).toMatchObject({ axTrusted: false, abortTapAvailable: false, screenCaptureGranted: true });
    expect(f.calls.some(c => c.method === "capture" || c.method === "input")).toBe(false);
  });
  it("refuses locked sessions before reading windows or capturing", async () => {
    const f = fake(); f.setLocked(true); const port = new NiriPort(f.io);
    await expect(port.request("get_app_state", { ...args, includeScreenshot: true })).rejects.toThrow("locked");
    expect(f.calls).toEqual([]);
  });
  it("captures at logical-point scale with an honest whole-display note", async () => {
    const f = fake(); const port = new NiriPort(f.io); const state = await port.request("get_app_state", { ...args, includeScreenshot: true });
    expect(state.appSpecificInstructions).toContain("entire DP-1 display");
    expect(state.windowState.screenshot).toMatchObject({ width: 800, height: 600, scale: 1 });
    expect(state.windowState.rawTree?.root?.children).toEqual([]);
  });
  it("does not focus an app during a read and refuses input while unfocused", async () => {
    const f = fake(); f.scene.windows[0]!.is_focused = false; const port = new NiriPort(f.io);
    const state = await port.request("get_app_state", { ...args, includeScreenshot: true });
    expect(state.windowState.screenshot).toBeNull();
    await expect(port.request("click", { ...args, x: 20, y: 30 })).rejects.toThrow("not focused");
    expect(f.calls).toEqual([]);
  });
  it("does not fall back to another window when the requested id closes", async () => {
    const f = fake(); const port = new NiriPort(f.io);
    await expect(port.request("click", { ...args, windowId: 99, x: 20, y: 30 })).rejects.toMatchObject({ code: "window_gone" });
    expect(f.calls).toEqual([]);
  });
  it("rejects out-of-display coordinates before input opens", async () => {
    const f = fake(); const port = new NiriPort(f.io);
    await expect(port.request("click", { ...args, x: 800, y: 30 })).rejects.toThrow("Coordinates");
    expect(f.calls).toEqual([]);
  });
  it("blocks password managers, extra app ids and browser aliases", async () => {
    expect(() => assertLinuxAppAllowed("org.keepassxc.KeePassXC", args)).toThrow("blocked");
    expect(() => assertLinuxAppAllowed("cu-fixture", { blockedBundleIds: ["cu-fixture"] })).toThrow("blocked");
    expect(() => assertLinuxAppAllowed("firefox", { blockedBundleIds: ["org.mozilla.firefox"] })).toThrow("browser");
    const f = fake(); f.scene.windows.push({ ...f.scene.windows[0]!, id: 99, app_id: "org.keepassxc.KeePassXC", is_focused: false });
    await expect(new NiriPort(f.io).request("get_app_state", { ...args, includeScreenshot: true })).rejects.toThrow("blocked");
    expect(f.calls).toEqual([]);
  });
  it("restores a plain-text clipboard after Unicode paste", async () => {
    const f = fake(); const port = new NiriPort(f.io);
    const result = await port.request("type_text", { ...args, text: "你好，Niri" });
    expect(result.inputPath).toBe("paste"); expect(f.clipboard()).toBe("clipboard before"); expect(f.held.size).toBe(0);
  });
  it("refuses a non-text clipboard before overwriting it", async () => {
    const f = fake(); f.setNonText(); const port = new NiriPort(f.io);
    await expect(port.request("paste_text", { ...args, text: "new" })).rejects.toThrow("non-text");
    expect(f.calls.some(c => c.method === "clipboard" || c.method === "input")).toBe(false);
  });
  it("releases input on cancellation and stops typing after focus changes", async () => {
    const f = fake(); const port = new NiriPort(f.io); const abort = new AbortController();
    const task = port.request("type_text", { ...args, text: "x".repeat(1000) }, { signal: abort.signal });
    setTimeout(() => abort.abort(new Error("stopped")), 15);
    await expect(task).rejects.toThrow(); expect(f.held.size).toBe(0);
    expect(f.calls.filter(c => c.method === "key").length).toBeLessThan(100);
    f.scene.windows[0]!.is_focused = false;
    await expect(port.request("type_text", { ...args, text: "x" })).rejects.toThrow("not focused");
  });
});

describe("Niri MCP integration", () => {
  it("keeps the macOS Escape requirement while allowing the explicit Linux Stop mode", async () => {
    const f = fake(); const port = new NiriPort(f.io);
    const mac = new ControlLock({ helperPort: port });
    await expect(mac.acquire("mac")).rejects.toThrow("Escape"); mac.dispose();
    const linux = new ControlLock({ helperPort: port, requireAbortTap: false });
    await linux.acquire("one"); await expect(linux.acquire("two")).rejects.toThrow("another session");
    await linux.release(); linux.dispose();
  });
  it("advertises visual tools only and uses MCP for focus/read/click plus Stop", async () => {
    const f = fake(); const service = createComputerUseService({ helperPort: new NiriPort(f.io), target: "linux", platformSupported: true, postActionSleepMs: 0, getSettings: () => ({ enabled: true }) });
    const mcp = service.createMcpServer({ clientId: "fixture", provider: "codex" });
    const call = (name: string, arguments_: unknown = {}) => mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: arguments_ } });
    try {
      const init = await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(JSON.stringify(init)).toContain("Linux/Niri");
      const list = await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const text = JSON.stringify(list); expect(text).toContain('"focus_window"'); expect(text).not.toContain('"set_value"');
      const tools = (list as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } }).result.tools;
      expect(tools.find(t => t.name === "click")?.inputSchema.properties).not.toHaveProperty("element_index");
      expect(JSON.stringify(await call("click", { app: args.app, element_index: 1 }))).toContain("visual-only");
      expect(JSON.stringify(await call("focus_window", { app: args.app, window_id: 42 }))).toContain("verified");
      expect(JSON.stringify(await call("get_app_state", { app: args.app }))).toContain('"image"');
      expect(JSON.stringify(await call("click", { app: args.app, x: 30, y: 40 }))).not.toContain('"isError":true');
      expect(f.calls.some(c => c.method === "pointer")).toBe(true);
      const typing = call("type_text", { app: args.app, text: "x".repeat(1000) });
      await new Promise(r => setTimeout(r, 25)); await service.stopControl();
      expect(JSON.stringify(await typing)).toContain("aborted_by_user"); expect(f.held.size).toBe(0);
    } finally { await service.stop(); }
  });
  it("refuses tools when the host setting is off", async () => {
    const f = fake(); const service = createComputerUseService({ helperPort: new NiriPort(f.io), target: "linux", platformSupported: true });
    const mcp: ComputerUseMcpServer = service.createMcpServer({ clientId: "disabled" });
    const result = await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "focus_window", arguments: { app: args.app } } });
    expect(JSON.stringify(result)).toContain("computer_use_disabled"); expect(f.calls).toEqual([]); await service.stop();
  });
});
