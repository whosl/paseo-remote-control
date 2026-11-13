import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { NiriIO, type NiriWindow } from "../server/host/niri-io";
import { UnixSocketTransport } from "../test/unix-socket-transport";

if (process.env.PASEO_RC_RUN_LIVE !== "1" || !process.env.PASEO_CLI_UTILS) throw Error("Opt in with PASEO_RC_RUN_LIVE=1 and PASEO_CLI_UTILS=/path/to/cli/dist/utils");
const utils = (file: string) => import(pathToFileURL(path.join(process.env.PASEO_CLI_UTILS!, file)).href);
const { connectToDaemon } = await utils("client.js"), { selectDaemonTarget } = await utils("daemon-target.js");
const daemon = await connectToDaemon({ target: selectDaemonTarget({ home: process.env.PASEO_HOME ?? path.join(homedir(), ".paseo") }) });
const rpc = (method: string, input = {}) => daemon.invokePluginRpc("remote-control", method, input);
const io = new NiriIO(), before = await io.scene();
const original = before.windows.find(w => w.is_focused);
const originalWorkspace = before.workspaces.find(w => w.id === original?.workspace_id);
const empty = before.workspaces.find(w => w.output === originalWorkspace?.output && !before.windows.some(win => win.workspace_id === w.id)) as (typeof before.workspaces)[number] & { idx: number };
const initial = await rpc("remote-control.state");
assert(!initial.paused && !initial.humanPriority && initial.mode === "idle", "Leave the existing control choice unchanged; allow agents explicitly before this test");
assert(empty, "An empty workspace is required");
const directory = await mkdtemp(path.join(tmpdir(), "paseo-rc-fixture-"));
const stateFile = path.join(directory, "state.json");
const fixture = spawn("/usr/bin/python3", [path.resolve("test/fixtures/niri-window.py"), stateFile], { env: { ...await io.environment(), GDK_BACKEND: "wayland" }, stdio: "ignore" });
const home = path.resolve(process.env.PASEO_HOME ?? path.join(homedir(), ".paseo"));
const key = createHash("sha256").update(home).digest("hex").slice(0,12);
const socket = path.join(homedir(), ".local/state/paseo-computer-use", key, "mcp.sock");
const a = new Client({ name: "remote-control-fixture-a", version: "1" });
const b = new Client({ name: "remote-control-fixture-b", version: "1" });
const state = async () => JSON.parse(await readFile(stateFile, "utf8")) as { text: string; clicks: number; positions: Record<string, number[]> };
async function poll<T>(read: () => Promise<T>, valid: (value: T) => boolean): Promise<T> {
  for (let i=0;i<120;i++) { const value = await read(); if (valid(value)) return value; await sleep(50); }
  throw Error("Timed out waiting for the fixture");
}
const center = (p: number[]) => ({ x: p[0]! + p[2]! / 2, y: p[1]! + p[3]! / 2 });
const ok = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args }); assert(!result.isError, JSON.stringify(result)); return result;
};
try {
  const window = await poll(async () => (await io.scene()).windows.find(w => w.app_id === "paseo-cu-fixture"), Boolean) as NiriWindow;
  await io.niri(["action", "move-window-to-workspace", "--window-id", String(window.id), String(empty.idx)]);
  await a.connect(new UnixSocketTransport(socket, { clientId: `fixture-a-${process.pid}`, provider: "codex" }));
  await b.connect(new UnixSocketTransport(socket, { clientId: `fixture-b-${process.pid}`, provider: "codex" }));
  const app = "paseo-cu-fixture", target = { app, window_id: window.id };
  await ok(a,"focus_window",target); await poll(state,s=>!!s.positions?.button); await ok(a,"get_app_state",{...target,include_screenshot:true});
  assert.equal((await rpc("remote-control.state")).mode,"agent");
  const scene = await io.scene(), output = scene.outputs.find(o=>o.name===empty.output)!;
  const displayId = createHash("sha256").update(output.name).digest().readUInt32BE() & 0x7fffffff;
  const frame = await rpc("screen.frame",{display:displayId,maxWidth:1280,quality:0.6}); assert(frame.jpeg,"Human should be able to watch the agent");
  const button = center((await state()).positions.button!);
  await assert.rejects(rpc("screen.input",{display:displayId,events:[{type:"click",x:button.x/output.logical!.width,y:button.y/output.logical!.height,button:"left"}]}),/Take over/);
  await ok(a,"click",{app,...button}); await poll(state,s=>s.clicks===1);
  await ok(a,"click",{app,...center((await state()).positions.entry!)});
  const typing = a.callTool({name:"type_text",arguments:{app,text:"a".repeat(600)}});
  await poll(state,s=>s.text.length>5);
  await rpc("remote-control.takeover"); const interrupted = await typing; assert(interrupted.isError,"Takeover must stop an active tool");
  // The fixture publishes state every 50 ms; allow already-delivered OS events to be reported.
  await sleep(150); const text = (await state()).text; assert(text.length < 600);
  await sleep(200); assert.equal((await state()).text,text,"Agent must not keep typing after cancellation settles");
  assert((await b.callTool({name:"focus_window",arguments:target})).isError,"Another agent must not steal human-held control");
  await rpc("screen.input",{display:displayId,events:[{type:"key",keyCode:0,modifiers:["ctrl"]},{type:"text",text:"HUMAN"}]}); await poll(state,s=>s.text==="HUMAN");
  await rpc("remote-control.allow-agents"); await ok(b,"focus_window",target);
  await mkdir("build",{recursive:true});
  await writeFile("build/live-notice.jpg", await io.capture(output,"jpeg",0.5), {mode:0o600});
  // The layer-shell pill is anchored top-right. This click stays on the disposable fixture's output.
  await io.input(output); io.pointer(output,output.logical!.width-153,44,1);io.pointer(output,output.logical!.width-153,44,0);io.release();
  await poll(()=>rpc("remote-control.state"),s=>s.humanPriority===true);
  console.log(JSON.stringify({mcpAgentInput:"passed",liveViewing:"passed",humanInputRefusedUntilTakeover:"passed",inFlightTypingCanceled:"passed",humanInputAfterCleanup:"passed",secondAgentRefused:"passed",explicitAllow:"passed",localTakeoverButton:"passed"},null,2));
} finally {
  await rpc("remote-control.takeover").catch(()=>{});
  await Promise.all([a.close(),b.close()]);
  if(fixture.exitCode===null)fixture.kill();
  if(original?.id)await io.niri(["action","focus-window","--id",String(original.id)]).catch(()=>{});
  await io.stop();await daemon.close();await rm(directory,{recursive:true,force:true});
}
