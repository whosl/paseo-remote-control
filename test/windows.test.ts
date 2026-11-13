import { describe, expect, it } from "vitest";
import { WindowsPort, assertWindowsAppAllowed, windowsKey, type WindowsIO } from "../server/computer-use-mcp/windows/port";
import { createComputerUseService } from "../server/computer-use-mcp";
import { interactiveTaskScript, parseWindowsBridgeMessage, windowsPipePath } from "../server/host/windows";

function fixture() {
  const scene = { windows: [{ id: 42, app: "fixture.exe", title: "Fixture", focused: true, minimized: false, display: 2, x: -1920, y: 200, width: 1920, height: 1080 }], displays: [{ id: 2, x: -1920, y: 200, width: 1920, height: 1080, name: "Display" }], locked: false, sessionId: 1 };
  const calls: { cmd: string; p: Record<string, unknown> }[] = [];
  let clipboard: string | null = "before"; let seq = 1; let nonText = false;
  const io: WindowsIO = { async request<T extends Record<string, unknown>>(cmd: string, p: Record<string, unknown> = {}): Promise<T> {
    calls.push({ cmd, p });
    if (cmd === "scene") return structuredClone(scene) as unknown as T;
    if (cmd === "frame") return { jpeg: "anBlZw==", imageWidth: 1600 } as unknown as T;
    if (cmd === "signature") return { signature: Buffer.alloc(2560).toString("base64"), width: 64, height: 40 } as unknown as T;
    if (cmd === "clipboard") return { text: clipboard, changeCount: seq, nonText } as unknown as T;
    if (cmd === "clipboard-write") { clipboard = String(p.text); seq++; }
    return {} as T;
  } };
  return { scene, calls, io, clipboard: () => clipboard, setNonText: () => { nonText = true; } };
}
const p = { app: "fixture.exe", blockedBundleIds: [] as string[] };

describe("Windows visual control", () => {
  it("rejects malformed bridge envelopes without throwing before authentication", () => {
    for (const line of ["null", "[]", "true", "1", '"hello"', "bad JSON"]) expect(parseWindowsBridgeMessage(line)).toBeNull();
    expect(parseWindowsBridgeMessage('{"hello":"nonce","sessionId":1}')).toEqual({ hello: "nonce", sessionId: 1 });
  });
  it("uses a limited interactive task, quotes paths, and does not expose a TCP listener", () => {
    const script = interactiveTaskScript("task'quoted", "C:\\user's files\\helper.exe", "pipe", "nonce");
    expect(script).toContain("-LogonType Interactive -RunLevel Limited"); expect(script).not.toContain("Highest"); expect(script).toContain("user''s files");
    expect(script).toContain("SetAccessRuleProtection($true,$false)"); expect(script).toContain("[Console]::In.ReadToEnd()");
    expect(windowsPipePath("test")).toBe("\\\\.\\pipe\\test");
  });
  it("validates shortcuts before sending input", () => {
    expect(windowsKey("Ctrl+Shift+s")).toMatchObject({ char: "s", modifiers: ["ctrl", "shift"] });
    expect(windowsKey("Win+Left")).toMatchObject({ keyCode: 123, modifiers: ["cmd"] });
    expect(() => windowsKey("Invalid+z")).toThrow();
    expect(() => windowsKey("Ctrl+made-up")).toThrow();
  });
  it("preserves password-manager and browser restrictions for executable ids", () => {
    for (const id of ["1password.exe", "Bitwarden.exe", "KeePassXC.exe"]) expect(() => assertWindowsAppAllowed(id, p)).toThrow();
    expect(() => assertWindowsAppAllowed("chrome.exe", { ...p, blockedBundleIds: ["com.google.Chrome"] })).toThrow();
    expect(() => assertWindowsAppAllowed("msedge.exe", { ...p, blockedBundleIds: ["com.microsoft.edgemac"] })).toThrow();
    expect(() => assertWindowsAppAllowed("Quark.exe", { ...p, blockedBundleIds: ["com.google.Chrome"] })).toThrow();
    expect(() => assertWindowsAppAllowed("chrome.exe", p)).not.toThrow();
  });
  it("reports visual availability without claiming UIA or Escape hooks", async () => {
    const f = fixture(); const status = await new WindowsPort(f.io).request("status", {});
    expect(status).toMatchObject({ axTrusted: false, screenCaptureGranted: true, abortTapAvailable: false, inputSourceId: "windows-visual" });
  });
  it("refuses Session 0 and secure desktops", async () => {
    const f = fixture(); const port = new WindowsPort(f.io); f.scene.sessionId = 0;
    await expect(port.request("status", {})).rejects.toThrow("Session 0");
    f.scene.sessionId = 1; f.scene.locked = true;
    await expect(port.request("click", { ...p, x: 10, y: 10 })).rejects.toThrow("Unlock");
    expect(f.calls.some(c => c.cmd === "input")).toBe(false);
  });
  it("maps display-local physical pixels independently of monitor offsets/DPI", async () => {
    const f = fixture(); await new WindowsPort(f.io).request("click", { ...p, x: 960, y: 540 });
    expect(f.calls.find(c => c.cmd === "input")?.p).toMatchObject({ display: 2, expectedWindow: 42, expectedApp: "fixture.exe", events: [{ type: "click", x: .5, y: .5 }] });
    expect(f.calls.at(-1)?.cmd).toBe("release");
  });
  it("refuses out-of-display coordinates, stale focus and accessibility indices", async () => {
    const f = fixture(); const port = new WindowsPort(f.io);
    await expect(port.request("click", { ...p, x: 1920, y: 0 })).rejects.toThrow("bounds");
    await expect(port.request("click", { ...p, nativeId: "index" })).rejects.toThrow("indexed");
    f.scene.windows[0]!.focused = false;
    await expect(port.request("click", { ...p, x: 10, y: 10 })).rejects.toThrow("Focus");
    expect(f.calls.some(c => c.cmd === "input")).toBe(false);
  });
  it("returns full-display image scale without claiming an accessibility tree", async () => {
    const f = fixture(); const state = await new WindowsPort(f.io).request("get_app_state", { ...p, includeScreenshot: true });
    expect(state.windowState.screenshot).toMatchObject({ width: 1920, height: 1080, scale: 1600 / 1920 });
    expect(state.appSpecificInstructions).toContain("no UI Automation");
  });
  it("cancels Unicode typing between characters and releases input", async () => {
    const f = fixture(); const port = new WindowsPort(f.io); const controller = new AbortController();
    const typing = port.request("type_text", { ...p, text: "中文".repeat(100) }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 15); await expect(typing).rejects.toThrow();
    const count = f.calls.filter(c => c.cmd === "input").length; expect(count).toBeGreaterThan(0); expect(count).toBeLessThan(200);
    expect(f.calls.at(-1)?.cmd).toBe("release");
  });
  it("keeps held drag modifiers down until the final release", async () => {
    const f = fixture(); await new WindowsPort(f.io).request("drag", { ...p, fromX: 10, fromY: 10, toX: 200, toY: 200, holdKeys: ["ctrl"] });
    const inputs = f.calls.filter(c => c.cmd === "input").flatMap(c => c.p.events as Record<string, unknown>[]);
    expect(inputs[0]).toEqual({ type: "key", keyCode: 59, down: true });
    expect(inputs.filter(e => e.type !== "key").every(e => !e.modifiers)).toBe(true);
    expect(f.calls.at(-1)?.cmd).toBe("release");
  });
  it("cancels a hung capture without occupying the input bridge", async () => {
    const f = fixture(); const controller = new AbortController(); let complete!: (value: Record<string, unknown>) => void;
    const capture: WindowsIO = { request: () => new Promise(resolve => { complete = resolve as typeof complete; }) };
    const port = new WindowsPort(f.io, capture);
    const reading = port.request("get_app_state", { ...p, includeScreenshot: true }, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 10)); controller.abort();
    await expect(reading).rejects.toThrow(); await port.request("cancel", { requestId: 1 });
    expect(f.calls.some(c => c.cmd === "frame")).toBe(false); expect(f.calls.at(-1)?.cmd).toBe("release");
    complete({ jpeg: "anBlZw==", imageWidth: 1600 });
  });
  it("refuses non-text clipboard data and restores previous plain text", async () => {
    const f = fixture(); const port = new WindowsPort(f.io);
    await port.request("paste_text", { ...p, text: "new text" }); expect(f.clipboard()).toBe("before");
    f.setNonText(); await expect(port.request("paste_text", { ...p, text: "new text" })).rejects.toThrow("non-text");
  });
  it("advertises Windows visual tools, not Linux instructions or AX operations", async () => {
    const f = fixture(); const service = createComputerUseService({ helperPort: new WindowsPort(f.io), target: "windows", platformSupported: true, getSettings: () => ({ enabled: true }) });
    const server = service.createMcpServer({ clientId: "windows-test", provider: "codex" });
    const init = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(JSON.stringify(init)).toContain("Windows desktop visually"); expect(JSON.stringify(init)).not.toContain("Linux/Niri");
    const tools = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(JSON.stringify(tools)).toContain("focus_window"); expect(JSON.stringify(tools)).not.toContain('"set_value"');
    expect(JSON.stringify(tools)).not.toContain('"element_index"'); await service.stop();
  });
});
