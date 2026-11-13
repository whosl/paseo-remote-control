import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { RemoteControlState } from "../../shared/control";
import { CONTROL_OVERLAY } from "./overlay-source.generated";

export class ControlOverlay {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private closing = false;
  constructor(private readonly environment: () => Promise<NodeJS.ProcessEnv>,
    private readonly onAction: (action: "takeover" | "pause") => void,
    private readonly onLost: () => void) {}

  private start(): Promise<void> {
    return this.ready ??= (async () => {
      const env = { ...await this.environment() };
      const root = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share"), "paseo-remote-control/overlay/usr/lib");
      const typelibs = (await readdir(root).catch(() => [])).map((dir) => path.join(root, dir, "girepository-1.0"));
      env.GI_TYPELIB_PATH = [...typelibs, env.GI_TYPELIB_PATH].filter(Boolean).join(":");
      const cache = path.join(homedir(), ".cache/paseo-remote-control");
      await mkdir(cache, { recursive: true, mode: 0o700 });
      const file = path.join(cache, `overlay-${CONTROL_OVERLAY.hash}.py`);
      await writeFile(file, CONTROL_OVERLAY.source, { mode: 0o600 });
      const child = spawn(process.env.PASEO_RC_PYTHON || "/usr/bin/python3", ["-u", file], { env, stdio: "pipe" });
      this.child = child;
      let detail = "";
      child.stderr.on("data", (data) => { detail = (detail + String(data)).slice(-1500); });
      child.stdin.on("error", () => {});
      const lines = createInterface({ input: child.stdout });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error(`Control notice timed out: ${detail}`)); child.kill(); }, 3000);
        const fail = () => {
          clearTimeout(timer); this.child = null; this.ready = null;
          const error = new Error(`Control notice exited: ${detail}`);
          for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
          this.pending.clear(); lines.close(); reject(error);
          if (!this.closing) this.onLost();
        };
        child.once("error", fail); child.once("exit", fail);
        lines.on("line", (line) => {
          try {
            const value = JSON.parse(line);
            if (value.ready) { clearTimeout(timer); resolve(); }
            if (value.action === "takeover" || value.action === "pause") this.onAction(value.action);
            const pending = this.pending.get(value.id);
            if (pending) { clearTimeout(pending.timer); this.pending.delete(value.id); if (value.shown) pending.resolve(); else pending.reject(new Error("Control notice was not shown")); }
          } catch { /* Only our JSON protocol goes to stdout. */ }
        });
      });
    })().catch((error) => { this.ready = null; throw error; });
  }
  update(state: RemoteControlState): void {
    if (this.child && !this.child.killed && this.child.exitCode === null) this.child.stdin.write(JSON.stringify(state) + "\n");
  }
  async show(state: RemoteControlState): Promise<void> {
    await this.start();
    const id = ++this.sequence;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Control notice did not acknowledge display")); }, 2000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ ...state, id }) + "\n");
    });
  }
  async stop(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), new Promise<void>((resolve) => { timer = setTimeout(() => { child.kill(); resolve(); }, 1000); })]);
    clearTimeout(timer!);
  }
}
