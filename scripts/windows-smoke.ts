import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { computeHomeKey } from "../server/agent/contribute";
import { WindowsHost, windowsPipePath } from "../server/host/windows";
import { UnixSocketTransport } from "../test/unix-socket-transport";

if (process.platform !== "win32" || process.env.PASEO_RC_RUN_LIVE !== "1" || !process.env.PASEO_CLI_UTILS) throw new Error("Opt in on Windows with PASEO_RC_RUN_LIVE=1 and PASEO_CLI_UTILS=/path/to/cli/dist/utils");
const exec = promisify(execFile);
const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function ps(script: string) { return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`, "utf16le").toString("base64")], { windowsHide: true, timeout: 30_000 }); }
const utils = (file: string) => import(pathToFileURL(path.join(process.env.PASEO_CLI_UTILS!, file)).href);
const { connectToDaemon } = await utils("client.js"), { selectDaemonTarget } = await utils("daemon-target.js");
const daemon = await connectToDaemon({ target: selectDaemonTarget({ home: process.env.PASEO_HOME ?? path.join(homedir(), ".paseo") }) });
const rpc = (name: string, input = {}) => daemon.invokePluginRpc("remote-control", name, input);
const initial = await rpc("remote-control.state");
assert(!initial.paused && !initial.humanPriority && initial.mode === "idle", "Allow agents explicitly before this offline fixture test");
const io = new WindowsHost();
const before = await io.request("scene") as { windows: { id: number; focused: boolean; app: string }[] };
const original = before.windows.find(w => w.focused);
const directory = await mkdtemp(path.join(tmpdir(), "paseo-rc-fixture-"));
const stateFile = path.join(directory, "state.json"), task = `Paseo-RC-Fixture-${randomUUID()}`;
const a = new Client({ name: "windows-fixture-a", version: "1" }), b = new Client({ name: "windows-fixture-b", version: "1" }), shimClient = new Client({ name: "windows-shim-fixture", version: "1" });
const c = new Client({ name: "windows-fixture-c", version: "1" }), d = new Client({ name: "windows-fixture-d", version: "1" });
const key = computeHomeKey(), socket = windowsPipePath(`paseo-cu-${key}`);
const authToken = (await readFile(path.join(homedir(), ".local/state/paseo-computer-use", key, "mcp-token"), "utf8")).trim();
type State = { text: string; selectionLength: number; clicks: number; window: number; entry: { x: number; y: number }; button: { x: number; y: number } };
async function state(): Promise<State | null> { try { return JSON.parse(await readFile(stateFile, "utf8")); } catch { return null; } }
async function poll<T>(read: () => Promise<T>, valid: (v: T) => boolean): Promise<T> { let last: T | undefined; for (let i = 0; i < 160; i++) { last = await read(); if (valid(last)) return last; await sleep(50); } throw new Error(`Windows fixture timed out: ${JSON.stringify(last)}`); }
const ok = async (client: Client, name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }); assert(!r.isError, JSON.stringify(r)); return r; };
try {
  const viewerStatus = await rpc("screen.status");
  assert(viewerStatus.supported && viewerStatus.screenRecording && viewerStatus.captureMode === "screenshot", "The viewer status RPC must validate and expose Windows capture");
  const shim = path.join(homedir(), ".local/state/paseo-computer-use", key, "bin/paseo-computer-use-shim.mjs");
  await shimClient.connect(new StdioClientTransport({ command: process.execPath, args: [shim, "--socket", socket, "--client", `shim-fixture-${process.pid}`, "--provider", "codex"], env: { ELECTRON_RUN_AS_NODE: "1" } }));
  assert((await shimClient.listTools()).tools.some(t => t.name === "focus_window"), "The installed Windows stdio shim must authenticate and expose visual tools");
  await shimClient.close();
  const args = `-NoProfile -STA -WindowStyle Hidden -File "${path.resolve("test/fixtures/windows-window.ps1")}" -StateFile "${stateFile}"`;
  await ps(`$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(args)}; $p=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Principal $p | Out-Null; Start-ScheduledTask -TaskName ${quote(task)}`);
  const fixture = (await poll(state, s => !!s?.window))!;
  const scene = await io.request("scene") as { windows: { id: number; app: string; display: number }[]; displays: { id: number; x: number; y: number; width: number; height: number }[] };
  const window = scene.windows.find(w => w.id === fixture.window)!; assert(window);
  const display = scene.displays.find(d => d.id === window.display)!;
  const local = (p: { x: number; y: number }) => ({ x: p.x - display.x, y: p.y - display.y });
  await a.connect(new UnixSocketTransport(socket, { clientId: `fixture-a-${process.pid}`, provider: "codex", authToken }));
  await b.connect(new UnixSocketTransport(socket, { clientId: `fixture-b-${process.pid}`, provider: "codex", authToken }));
  const target = { app: window.app, window_id: window.id };
  await ok(a, "focus_window", target); await ok(a, "get_app_state", { ...target, include_screenshot: true });
  assert.equal((await rpc("remote-control.state")).mode, "agent");
  const frame = await rpc("screen.frame", { display: display.id, maxWidth: 1280, quality: .6 }); assert(frame.jpeg, "Live viewing must remain available");
  await assert.rejects(rpc("screen.input", { display: display.id, events: [{ type: "click", x: .5, y: .5, button: "left" }] }), /Take over/);
  await ok(a, "click", { app: window.app, ...local(fixture.button) }); await poll(state, s => s?.clicks === 1);
  await ok(a, "click", { app: window.app, ...local(fixture.entry) });
  await ok(a, "type_text", { app: window.app, text: "Windows Unicode 中文" }); await poll(state, s => s?.text === "Windows Unicode 中文");
  await ok(a, "press_key", { app: window.app, key: "Ctrl+a" });
  await poll(state, s => !!s && s.selectionLength === s.text.length);
  const typing = a.callTool({ name: "type_text", arguments: { app: window.app, text: "a".repeat(600) } });
  await poll(state, s => !!s && /^a{6,}$/.test(s.text));
  await rpc("remote-control.takeover"); assert((await typing).isError);
  await sleep(200); const stopped = (await state())!.text; await sleep(250); assert.equal((await state())!.text, stopped); assert(stopped.length < 600);
  assert((await b.callTool({ name: "focus_window", arguments: target })).isError);
  await rpc("screen.input", { display: display.id, events: [{ type: "key", keyCode: 0, modifiers: ["ctrl"] }, { type: "text", text: "HUMAN" }] });
  await poll(state, s => s?.text === "HUMAN");
  await rpc("remote-control.allow-agents"); await ok(b, "focus_window", target);
  // The native notice is on this display's working-area top right, not on the taskbar.
  const notice = await io.request("notice-location");
  assert(notice.visible, "The production native notice must be visible");
  if (process.env.PASEO_RC_DEBUG === "1") {
    const debug = await io.request("frame", { display: display.id, maxWidth: 1280, quality: .75 });
    await mkdir("build", { recursive: true }); await writeFile("build/windows-notice-debug.jpg", Buffer.from(String(debug.jpeg), "base64"), { mode: 0o600 });
    console.log("notice before", JSON.stringify({ notice, display }));
  }
  await io.request("input", { display: display.id, events: [{ type: "click", x: (Number(notice.takeX) - display.x) / display.width, y: (Number(notice.takeY) - display.y) / display.height }] });
  if (process.env.PASEO_RC_DEBUG === "1") console.log("notice after", JSON.stringify(await io.request("notice-location")));
  await poll<{ humanPriority: boolean }>(() => rpc("remote-control.state"), s => s.humanPriority === true);
  // Each interrupted caller stays aborted for that turn; use fresh fixture callers after explicit approval.
  await c.connect(new UnixSocketTransport(socket, { clientId: `fixture-c-${process.pid}`, provider: "codex", authToken }));
  await rpc("remote-control.allow-agents"); await ok(c, "focus_window", target);
  await ok(c, "click", { app: window.app, ...local(fixture.entry) }); await ok(c, "press_key", { app: window.app, key: "Ctrl+a" });
  const localTyping = c.callTool({ name: "type_text", arguments: { app: window.app, text: "b".repeat(600) } });
  await poll(state, s => !!s && /^b{6,}$/.test(s.text));
  await io.request("input", { display: display.id, events: [{ type: "click", x: (Number(notice.takeX) - display.x) / display.width, y: (Number(notice.takeY) - display.y) / display.height }] });
  assert((await localTyping).isError);
  await poll<{ humanPriority: boolean }>(() => rpc("remote-control.state"), s => s.humanPriority === true);
  // SendInput and the fixture's 50ms state timer may still have one already-delivered character queued.
  await sleep(200); const localStopped = (await state())!.text; await sleep(250); assert.equal((await state())!.text, localStopped); assert(localStopped.length < 600);
  await d.connect(new UnixSocketTransport(socket, { clientId: `fixture-d-${process.pid}`, provider: "codex", authToken }));
  await rpc("remote-control.allow-agents"); await ok(d, "focus_window", target);
  await io.request("input", { display: display.id, events: [{ type: "click", x: (Number(notice.pauseX) - display.x) / display.width, y: (Number(notice.pauseY) - display.y) / display.height }] });
  await poll<{ paused: boolean }>(() => rpc("remote-control.state"), s => s.paused === true);
  await assert.rejects(rpc("screen.input", { display: display.id, events: [{ type: "text", text: "refused" }] }), /paused/);
  await rpc("screen.set-control-paused", { paused: false });
  console.log(JSON.stringify({ realWindowsSession: "passed", viewerStatus: "passed", installedStdioShim: "passed", mcpAgentInput: "passed", unicodeTyping: "passed", liveViewing: "passed", inputGuard: "passed", inFlightCancellation: "passed", humanInput: "passed", secondAgentRefused: "passed", explicitAllow: "passed", nativeTakeoverButton: "passed", nativeTakeoverDuringTyping: "passed", nativePauseButton: "passed" }, null, 2));
} finally {
  await rpc("screen.set-control-paused", { paused: false }).catch(() => {});
  await rpc("remote-control.takeover").catch(() => {});
  await Promise.all([a.close(), b.close(), c.close(), d.close(), shimClient.close()]);
  await ps(`$ErrorActionPreference='SilentlyContinue'; Stop-ScheduledTask -TaskName ${quote(task)}; Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false`).catch(() => {});
  if (original) await io.request("focus", { window: original.id, expectedApp: original.app }).catch(() => {});
  await io.stop(); await daemon.close(); await rm(directory, { recursive: true, force: true });
}
