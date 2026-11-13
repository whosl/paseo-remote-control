// The local RFB input transport follows the MIT-licensed Niri backend in
// kevguy/paseo-screen (Copyright (c) 2026 Kevin Lai). No TCP listener is opened.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const exec = promisify(execFile);
export interface NiriWindow {
  id: number; app_id: string | null; title: string | null; workspace_id: number | null;
  is_focused: boolean; layout: { window_size: [number, number] };
}
export interface NiriWorkspace { id: number; output: string | null; is_active: boolean }
export interface NiriOutput {
  name: string; current_mode: number | null; modes: { width: number; height: number }[];
  logical: { x: number; y: number; width: number; height: number; scale: number } | null;
}
export interface NiriScene {
  windows: NiriWindow[]; workspaces: NiriWorkspace[]; outputs: NiriOutput[];
}

async function readExactly(socket: Socket, count: number): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  while (size < count) {
    const part = socket.read(count - size) as Buffer | null;
    if (part) { parts.push(part); size += part.length; continue; }
    if (socket.destroyed || socket.readableEnded) throw new Error("Niri input connection closed");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); socket.off("readable", ready); socket.off("error", failed); socket.off("close", closed); };
      const ready = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const closed = () => failed(new Error("Niri input connection closed"));
      const timer = setTimeout(() => failed(new Error("Niri input handshake timed out")), 3000);
      socket.once("readable", ready); socket.once("error", failed); socket.once("close", closed);
    });
  }
  return Buffer.concat(parts);
}

async function connectRfb(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath); socket.on("error", () => {});
  try {
    if (!(await readExactly(socket, 12)).toString().startsWith("RFB 003.")) throw new Error("Invalid RFB greeting");
    socket.write("RFB 003.008\n");
    const count = (await readExactly(socket, 1))[0]!;
    if (!count || !(await readExactly(socket, count)).includes(1)) throw new Error("Local RFB authentication unavailable");
    socket.write(Buffer.from([1]));
    if ((await readExactly(socket, 4)).readUInt32BE() !== 0) throw new Error("Local RFB authentication failed");
    socket.write(Buffer.from([1]));
    const init = await readExactly(socket, 24); const length = init.readUInt32BE(20);
    if (length > 65536) throw new Error("Invalid RFB desktop name");
    await readExactly(socket, length); socket.on("data", () => {}); socket.resume();
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

export const KEY_SYMBOLS: Readonly<Record<string, number>> = {
  return: 0xff0d, enter: 0xff0d, escape: 0xff1b, esc: 0xff1b, tab: 0xff09,
  backspace: 0xff08, delete: 0xffff, insert: 0xff63, space: 32,
  left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54,
  home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56,
  shift: 0xffe1, ctrl: 0xffe3, control: 0xffe3, alt: 0xffe9, option: 0xffe9,
  super: 0xffeb, meta: 0xffeb, cmd: 0xffeb, command: 0xffeb,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 0xffbe + i])),
};

export function parseKeyChord(chord: string): number[] {
  const parts = chord.split("+").map(x => x.trim());
  if (parts.length === 0 || parts.some(x => !x)) throw new Error("Use a key name or a chord such as Ctrl+s");
  return parts.map((part, i) => {
    const named = KEY_SYMBOLS[part.toLowerCase()];
    if (named !== undefined) return named;
    if (part.length === 1 && part.charCodeAt(0) >= 32 && part.charCodeAt(0) <= 126 && i === parts.length - 1) return part.charCodeAt(0);
    throw new Error(`Unknown key: ${part}`);
  });
}

export class NiriIO {
  private envPromise: Promise<NodeJS.ProcessEnv> | null = null;
  private socket: Socket | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private directory: string | null = null;
  private output: string | null = null;
  private px = 0; private py = 0; private buttons = 0;
  private held = new Set<number>(); private stopped = false;

  async environment(): Promise<NodeJS.ProcessEnv> {
    return this.envPromise ??= (async () => {
      const env = { ...process.env };
      const result = await exec("systemctl", ["--user", "show-environment"], { timeout: 5000 });
      for (const line of result.stdout.split("\n")) {
        const pos = line.indexOf("="); const key = line.slice(0, pos);
        if (["WAYLAND_DISPLAY", "NIRI_SOCKET", "XDG_CURRENT_DESKTOP", "XDG_RUNTIME_DIR"].includes(key)) env[key] = line.slice(pos + 1);
      }
      env.XDG_RUNTIME_DIR ||= `/run/user/${process.getuid?.()}`;
      if (!env.NIRI_SOCKET || !env.WAYLAND_DISPLAY || env.XDG_CURRENT_DESKTOP !== "niri" || !existsSync(env.NIRI_SOCKET)) {
        throw new Error("No accessible Niri session. Log in to Niri and import its environment into the systemd user session.");
      }
      return env;
    })().catch(error => { this.envPromise = null; throw error; });
  }

  async run(command: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    const result = await exec(command, args, { env: await this.environment(), encoding: "buffer", timeout: 10000, maxBuffer: 32 * 1024 * 1024, signal });
    signal?.throwIfAborted(); return result.stdout;
  }
  async niri<T>(args: string[], signal?: AbortSignal): Promise<T> {
    const text = (await this.run(process.env.PASEO_CU_NIRI_BIN || "niri", ["msg", "--json", ...args], signal)).toString().trim();
    // Successful action commands have no response body.
    return (text ? JSON.parse(text) : undefined) as T;
  }
  async scene(signal?: AbortSignal): Promise<NiriScene> {
    const [windows, workspaces, outputs] = await Promise.all([
      this.niri<NiriWindow[]>(["windows"], signal), this.niri<NiriWorkspace[]>(["workspaces"], signal),
      this.niri<Record<string, NiriOutput>>(["outputs"], signal),
    ]);
    return { windows, workspaces, outputs: Object.values(outputs).filter(o => o.logical && o.current_mode !== null) };
  }
  async locked(): Promise<boolean> {
    const env = await this.environment();
    const session = env.XDG_SESSION_ID || (await exec("loginctl", ["show-user", String(process.getuid?.()), "-p", "Display", "--value"], { timeout: 3000 })).stdout.trim();
    if (!session) throw new Error("Cannot determine whether the graphical session is locked");
    return (await exec("loginctl", ["show-session", session, "-p", "LockedHint", "--value"], { timeout: 3000 })).stdout.trim() === "yes";
  }
  async capture(output: NiriOutput, format: "jpeg" | "ppm", scale: number, signal?: AbortSignal): Promise<Buffer> {
    const local = path.join(homedir(), ".local", "bin", "grim");
    return this.run(process.env.PASEO_CU_GRIM_BIN || (existsSync(local) ? local : "grim"), ["-t", format, "-s", String(scale), "-o", output.name, "-"], signal);
  }

  async input(output: NiriOutput): Promise<void> {
    if (this.stopped) throw new Error("Niri input stopped");
    if (this.socket && !this.socket.destroyed) {
      if (this.output !== output.name) await this.run("wayvncctl", ["-S", path.join(this.directory!, "ctl"), "output-set", output.name]);
      this.output = output.name; return;
    }
    await this.closeInput();
    this.directory = await mkdtemp(path.join((await this.environment()).XDG_RUNTIME_DIR!, "paseo-cu-"));
    const socketPath = path.join(this.directory, "vnc");
    const child = spawn("wayvnc", ["-C", "/dev/null", "-S", path.join(this.directory, "ctl"), "-o", output.name, "--unix-socket", socketPath], { env: await this.environment(), stdio: "pipe" });
    this.child = child; let error = "";
    child.stdout.resume(); child.stderr.on("data", chunk => { error = (error + String(chunk)).slice(-2000); });
    child.on("error", e => { error = e.message; });
    try {
      for (let i = 0; ; i++) {
        if (this.stopped || child.exitCode !== null || child.signalCode !== null) throw new Error(`Niri input unavailable: ${error}`);
        try { this.socket = await connectRfb(socketPath); this.output = output.name; return; }
        catch { if (i >= 20) throw new Error(`Niri input unavailable: ${error}`); await sleep(50); }
      }
    } catch (e) { await this.closeInput(); throw e; }
  }
  key(code: number, down: boolean): void {
    if (!this.socket || this.socket.destroyed) throw new Error("Niri input disconnected");
    const b = Buffer.alloc(8); b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(code, 4); this.socket.write(b);
    if (down) this.held.add(code); else this.held.delete(code);
  }
  pointer(output: NiriOutput, x: number, y: number, buttons = this.buttons): void {
    const logical = output.logical!; const mode = output.modes[output.current_mode!]!;
    this.px = Math.round(x / logical.width * (mode.width - 1)); this.py = Math.round(y / logical.height * (mode.height - 1));
    this.buttons = buttons;
    const b = Buffer.alloc(6); b[0] = 5; b[1] = buttons; b.writeUInt16BE(this.px, 2); b.writeUInt16BE(this.py, 4);
    if (!this.socket || this.socket.destroyed) throw new Error("Niri input disconnected");
    this.socket.write(b);
  }
  release(): void {
    if (!this.socket || this.socket.destroyed) { this.held.clear(); this.buttons = 0; return; }
    for (const k of this.held) this.key(k, false);
    const b = Buffer.alloc(6); b[0] = 5; b.writeUInt16BE(this.px, 2); b.writeUInt16BE(this.py, 4); this.socket.write(b); this.buttons = 0;
  }
  async writeClipboard(text: string | null, signal?: AbortSignal): Promise<void> {
    const env = await this.environment();
    await new Promise<void>((resolve, reject) => {
      const child = spawn("wl-copy", text === null ? ["--clear"] : ["--type", "text/plain;charset=utf-8"], { env, stdio: "pipe", signal });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Clipboard write timed out")); }, 5000);
      child.stdout.resume(); child.stderr.resume(); child.on("error", e => { clearTimeout(timer); reject(e); });
      child.on("exit", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("Clipboard write failed")); });
      child.stdin.on("error", reject); child.stdin.end(text ?? "");
    });
  }
  private async closeInput(): Promise<void> {
    this.release(); this.socket?.destroy(); this.socket = null; this.output = null;
    if (this.child) { const child = this.child; this.child = null; child.kill(); await Promise.race([new Promise(r => child.once("exit", r)), sleep(1000)]); if (child.exitCode === null) child.kill("SIGKILL"); }
    if (this.directory) { await rm(this.directory, { recursive: true, force: true }); this.directory = null; }
  }
  async stop(): Promise<void> { this.stopped = true; await this.closeInput(); }
}
