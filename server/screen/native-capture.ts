import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ScreenDisplay } from "../../shared/screen/rpc";
import { MjpegReader } from "./mjpeg";
import { FrameCache, type CachedFrame } from "./frame-cache";
import { captureFps } from "../../shared/screen/capture-policy";

type LiveCapture = {
  child: ReturnType<typeof spawnProcess>;
  frames: FrameCache;
  ready: Promise<void>;
  fail(error: Error): void;
  idle: ReturnType<typeof setTimeout> | null;
  closed: boolean;
};

/** One native encoder per active display/quality; only its newest frame is retained. */
export class NativeCapture {
  private executable: Promise<string | null> | null = null;
  private streams = new Map<string, LiveCapture>();
  private retryAfter = new Map<string, number>();
  private retiring = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly log: (message: string) => void) {}

  private binary(): Promise<string | null> {
    return this.executable ??= (async () => {
      for (const file of [path.join(homedir(), ".local/share/paseo-screen/bin/wf-recorder"), "/usr/bin/wf-recorder"]) {
        try { await access(file, constants.X_OK); return file; } catch { /* Optional fast path. */ }
      }
      return null;
    })();
  }

  async mode(): Promise<string> { return await this.binary() ? "native-stream" : "screenshot"; }

  async frame(display: ScreenDisplay & { output: string }, maxWidth: number, quality: number, env: NodeJS.ProcessEnv, since?: string, waitMs = 0): Promise<(CachedFrame & { waitedMs: number }) | null> {
    const binary = await this.binary();
    if (!binary || this.stopped) return null;
    const width = Math.max(2, Math.floor(Math.min(display.pixelWidth, maxWidth) / 2) * 2);
    const quantizer = Math.max(2, Math.min(15, Math.round(16 - quality * 14)));
    const fps = captureFps(quality);
    const key = `${display.output}:${display.pixelWidth}:${display.pixelHeight}:${width}:${quantizer}:${fps}`;
    if ((this.retryAfter.get(key) ?? 0) > Date.now()) return null;
    let stream = this.streams.get(key);
    if (!stream) {
      // Bound encoders even when several paired clients choose different sizes.
      if (this.streams.size >= 3) {
        const [oldest, capture] = this.streams.entries().next().value!;
        this.streams.delete(oldest);
        this.retire(capture);
      }
      stream = this.start(binary, display.output, width, quantizer, fps, env);
      this.streams.set(key, stream);
    }
    this.streams.delete(key);
    this.streams.set(key, stream);
    if (stream.idle) clearTimeout(stream.idle);
    const current = stream;
    stream.idle = setTimeout(() => {
      if (this.streams.get(key) === current) this.streams.delete(key);
      this.retire(current);
    }, 3000);
    try {
      await stream.ready;
      if (stream.closed) throw new Error("Native capture closed");
      const result = await stream.frames.read(since, waitMs);
      if (stream.closed || !result.frame) throw new Error("Native capture closed");
      return { ...result.frame, waitedMs: result.waitedMs };
    } catch (error) {
      if (this.streams.get(key) === stream) this.streams.delete(key);
      this.retire(stream);
      if (this.stopped) throw new Error("Native capture stopped");
      this.retryAfter.set(key, Date.now() + 30_000);
      this.log(`Continuous capture unavailable; falling back to grim: ${String(error)}`);
      return null;
    }
  }

  private start(binary: string, output: string, width: number, quantizer: number, fps: number, env: NodeJS.ProcessEnv): LiveCapture {
    // select emits the first frame immediately, unlike an fps filter that waits for a future frame.
    // Keep compositor damage tracking; a static screen does not need to be captured repeatedly.
    const filter = `select='isnan(prev_selected_t)+gte(t-prev_selected_t,${1 / fps})',scale=${width}:-2`;
    const child = spawnProcess(binary, ["-o", output, "--no-dmabuf", "-c", "mjpeg", "-m", "mjpeg", "-F", filter,
      "-x", "yuvj420p", "-p", `qmin=${quantizer}`, "-p", `qmax=${quantizer}`, "-f", "pipe:1"], { env, stdio: "pipe" });
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void ready.catch(() => {});
    const stream: LiveCapture = { child, frames: new FrameCache(), ready, fail: (error) => { clearTimeout(timeout); reject(error); }, idle: null, closed: false };
    const timeout = setTimeout(() => stream.fail(new Error("First native frame timed out")), 2500);
    const reader = new MjpegReader();
    let detail = "";
    child.stderr.on("data", (data: Buffer) => { detail = (detail + data.toString()).slice(-2000); });
    child.stdin.on("error", () => {});
    child.stdin.end();
    child.stdout.on("data", (data: Buffer) => {
      if (stream.closed) return;
      try {
        const frames = reader.push(data);
        if (frames.length) { stream.frames.publish(frames[frames.length - 1]!); clearTimeout(timeout); resolve(); }
      } catch (error) { stream.fail(error as Error); this.retire(stream); }
    });
    child.on("error", (error: Error) => { stream.closed = true; stream.fail(error); });
    child.on("exit", () => { stream.closed = true; stream.fail(new Error(`Native capture exited: ${detail}`)); });
    return stream;
  }

  private retire(stream: LiveCapture): void {
    if (stream.idle) clearTimeout(stream.idle);
    stream.closed = true;
    stream.frames.close();
    stream.fail(new Error("Native capture stopped"));
    const closing = terminateProcess(stream.child).catch(() => {}).then(() => { this.retiring.delete(closing); });
    this.retiring.add(closing);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const stream of this.streams.values()) this.retire(stream);
    this.streams.clear();
    await Promise.all(this.retiring);
  }
}
