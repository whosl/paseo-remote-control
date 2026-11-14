import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { WEBRTC_HELPER } from "./webrtc-source.generated";
import { readVideoIceConfiguration } from "./video-config";

type Pending = { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
export class WebRtcWorker {
  private child: ReturnType<typeof spawnProcess> | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private stopped = false;
  private readonly root = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData/Local"), "paseo-remote-control") : path.join(homedir(), ".local/share/paseo-screen");
  private readonly python = path.join(this.root, process.platform === "win32" ? "rtc-venv/Scripts/python.exe" : "rtc-venv/bin/python");
  private readonly recorder = path.join(this.root, "bin/wf-recorder");

  constructor(private readonly log: (message: string) => void) {}

  async available(): Promise<boolean> {
    if (process.platform !== "linux" && process.platform !== "win32") return false;
    try { await Promise.all([access(this.python, constants.X_OK), ...(process.platform === "linux" ? [access(this.recorder, constants.X_OK)] : [])]); return true; } catch { return false; }
  }

  async offerWindows(input: { sdp: string; width: number; height: number; fps: number }, startCapture: (feed: Record<string, unknown>) => Promise<unknown>): Promise<{ session: string; sdp: string }> {
    if (!(await this.available())) throw new Error("Direct video is unavailable on this host");
    await this.start(process.env);
    const session = randomUUID();
    try {
      const feed = await this.request("windows-prepare", { session, width: input.width, height: input.height });
      await startCapture({ ...feed, width: input.width, height: input.height, fps: input.fps });
      const result = await this.request("offer", { ...input, session, ...await readVideoIceConfiguration({ role: "host" }) });
      if (result.session !== session || typeof result.sdp !== "string") throw new Error("Invalid direct video answer");
      return { session, sdp: result.sdp };
    } catch (error) { await this.request("stop", { session }).catch(() => {}); throw error; }
  }

  async offer(input: { sdp: string; output: string; width: number; fps: number }, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
    if (!(await this.available())) throw new Error("Direct video is unavailable on this host");
    await this.start(env);
    const configuration = await readVideoIceConfiguration({ role: "host" });
    const session = randomUUID();
    try { return await this.request("offer", { ...input, ...configuration, session, recorder: this.recorder }); }
    catch (error) { void this.request("stop", { session }).catch(() => {}); throw error; }
  }

  async command(method: "ping" | "stop", session: string): Promise<Record<string, unknown>> {
    if (!this.child) { if (method === "stop") return {}; throw new Error("Direct screen session has ended"); }
    return this.request(method, { session });
  }

  private async start(env: NodeJS.ProcessEnv): Promise<void> {
    if (this.stopped) throw new Error("Direct screen worker stopped");
    if (this.child) return;
    this.starting ??= (async () => {
      const directory = process.platform === "win32" ? path.join(this.root, "rtc") : path.join(homedir(), ".cache/paseo-screen/rtc");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `${WEBRTC_HELPER.hash}.py`);
      await writeFile(file, WEBRTC_HELPER.source, { mode: 0o600 });
      if (this.stopped) throw new Error("Direct screen worker stopped");
      const childEnv = { ...env };
      if (process.platform === "linux") {
        const vaapi = env.PASEO_REMOTE_CONTROL_VAAPI_ENCODER || path.join(this.root, "bin/vaapi-encoder-v1");
        try { await access(vaapi, constants.X_OK); childEnv.PASEO_REMOTE_CONTROL_VAAPI_ENCODER = vaapi; } catch { /* Optional hardware helper: software remains available. */ }
      }
      const child = spawnProcess(this.python, ["-u", file], { env: childEnv, stdio: "pipe" });
      this.child = child;
      let detail = "";
      child.stderr.on("data", (chunk: Buffer) => { detail = (detail + chunk.toString()).slice(-2000); });
      child.stdin.on("error", () => {});
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line);
          if (message.event === "encoder" && (message.backend === "h264_nvenc" || message.backend === "h264_vaapi" || message.backend === "libx264")) {
            this.log(`Video encoder: ${message.backend}${message.fallback === true ? " (hardware fallback)" : ""}`);
            return;
          }
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result ?? {});
        } catch { this.log("Direct screen worker returned invalid data"); }
      });
      const failed = () => {
        if (this.child === child) this.child = null;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(`Direct screen worker exited: ${detail}`)); }
        this.pending.clear(); lines.close();
      };
      child.on("error", failed); child.on("exit", failed);
    })().finally(() => { this.starting = null; });
    await this.starting;
  }

  private request(method: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(new Error("Direct screen worker is not running"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Direct screen request timed out")); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify({ id, method, ...input }) + "\n", (error) => {
        if (error && this.pending.delete(id)) { clearTimeout(timer); reject(error); }
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.starting?.catch(() => {});
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
    await terminateProcess(child, "SIGTERM");
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(() => { void terminateProcess(child); resolve(); }, 2500); })]);
    clearTimeout(timer!);
  }
}
