// Opt-in: this briefly opens an offline fixture on an empty Niri workspace,
// exercises real MCP input there, and restores the original focused window.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createComputerUseService } from "../server/computer-use-mcp";
import { NiriIO, type NiriWindow } from "../server/computer-use-mcp/linux/niri-io";
import { NiriPort } from "../server/computer-use-mcp/linux/niri-port";
import type { ToolCallResult } from "../server/computer-use-mcp/mcp/tools";

if (process.env.PASEO_CU_RUN_LIVE !== "1") throw new Error("Set PASEO_CU_RUN_LIVE=1 to run the real desktop check.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(tmpdir(), "paseo-cu-live-"));
const stateFile = path.join(dir, "state.json");
const io = new NiriIO();
const before = await io.scene();
const original = before.windows.find(w => w.is_focused);
const originalWorkspace = before.workspaces.find(w => w.id === original?.workspace_id);
const empty = before.workspaces.find(w => w.output === originalWorkspace?.output && !before.windows.some(win => win.workspace_id === w.id)) as (typeof before.workspaces)[number] & { idx: number };
assert(empty, "An empty workspace is required so the check never captures personal windows");
const fixture = spawn("/usr/bin/python3", [path.join(root, "test/fixtures/niri-window.py"), stateFile], { env: { ...await io.environment(), GDK_BACKEND: "wayland" }, stdio: ["ignore", "ignore", "pipe"] });
let fixtureError = ""; fixture.stderr.on("data", b => { fixtureError = (fixtureError + String(b)).slice(-3000); });
const service = createComputerUseService({ helperPort: new NiriPort(io), target: "linux", platformSupported: true, postActionSleepMs: 100, getSettings: () => ({ enabled: true }) });
const mcp = service.createMcpServer({ clientId: "niri-live-check", provider: "codex" });
const app = "paseo-cu-fixture";
let checks = 0;
async function poll<T>(fn: () => Promise<T>, valid: (v: T) => boolean, message: string, timeout = 7000): Promise<T> {
  const start = Date.now(); let value: T;
  while (Date.now() - start < timeout) { value = await fn(); if (valid(value)) return value; await sleep(50); }
  throw new Error(`${message}; fixture: ${fixtureError}`);
}
async function state() { return JSON.parse(await readFile(stateFile, "utf8")) as { text: string; clicks: number; drag_moves: number; scroll: number; positions: Record<string, number[]> }; }
async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  const reply = await mcp.handleMessage({ jsonrpc: "2.0", id: ++checks, method: "tools/call", params: { name, arguments: args } });
  assert(reply && "result" in reply, `${name}: ${JSON.stringify(reply)}`);
  const result = reply.result as ToolCallResult;
  assert(!result.isError, `${name}: ${JSON.stringify(result)}`); console.log(`PASS ${name}`); return result;
}
const center = (p: number[]) => ({ x: p[0]! + p[2]! / 2, y: p[1]! + p[3]! / 2 });
try {
  const window = await poll(async () => (await io.scene()).windows.find(w => w.app_id === app), Boolean, "Fixture did not open") as NiriWindow;
  await io.niri(["action", "move-window-to-workspace", "--window-id", String(window.id), String(empty.idx)]);
  await tool("focus_window", { app, window_id: window.id });
  await poll(state, s => Boolean(s.positions?.entry), "Fixture did not lay out");
  await sleep(300);
  const screenshot = await tool("get_app_state", { app, window_id: window.id, include_screenshot: true });
  const image = screenshot.content.find(c => c.type === "image"); assert(image?.type === "image");
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await writeFile(path.join(root, "artifacts/niri-live-fixture.jpg"), Buffer.from(image.data, "base64"));
  let s = await state();
  await tool("click", { app, ...center(s.positions.button!) });
  await poll(state, s => s.clicks === 1, "Click was not delivered");
  await tool("click", { app, ...center(s.positions.entry!) });
  await tool("type_text", { app, text: "Hello 139" });
  await poll(state, s => s.text === "Hello 139", "ASCII typing mismatch");
  await tool("press_key", { app, key: "Ctrl+a" });
  await tool("type_text", { app, text: "中文 Computer Use 139" });
  await poll(state, s => s.text === "中文 Computer Use 139", "Unicode paste mismatch");
  s = await state();
  const c = s.positions.canvas!;
  await tool("drag", { app, from_x: c[0]! + 60, from_y: c[1]! + 65, to_x: c[0]! + 220, to_y: c[1]! + 65 });
  await poll(state, s => s.drag_moves > 2, "Drag was not delivered");
  await tool("scroll", { app, ...center(s.positions.scroll!), direction: "down", pages: 1 });
  await poll(state, s => s.scroll > 0, "Scroll was not delivered");
  const stable = await tool("wait_for", { app, any: [{ name: "settled", visual_stable: { quiet_ms: 300 } }], timeout_ms: 3000 });
  assert(stable.content.some(c => c.type === "text" && c.text.includes('"met":"settled"')));
  await tool("click", { app, ...center(s.positions.entry!) });
  await tool("press_key", { app, key: "Ctrl+a" });
  const typing = tool("type_text", { app, text: "x".repeat(1000) }).then(() => false, e => String(e).includes("aborted_by_user"));
  await poll(state, s => s.text.startsWith("xxx"), "Long typing did not start");
  await service.stopControl(); assert(await typing, "Stop did not cancel the MCP action");
  const final = await state(); assert(final.text.length < 1000);
  console.log(JSON.stringify({ status: "PASS", mcpCalls: checks, clicks: final.clicks, dragMoves: final.drag_moves, scroll: final.scroll, stoppedAfterCharacters: final.text.length, screenshot: "artifacts/niri-live-fixture.jpg" }));
} finally {
  await service.stop(); await io.stop(); fixture.kill();
  await Promise.race([new Promise(r => fixture.once("exit", r)), sleep(1500)]);
  // A separate IO restores focus because service.stop disposed the input IO.
  const restore = new NiriIO();
  try { if (original) await restore.niri(["action", "focus-window", "--id", String(original.id)]); }
  finally { await restore.stop(); await rm(dir, { recursive: true, force: true }); }
}
