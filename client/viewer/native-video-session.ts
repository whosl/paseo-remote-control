import type { DirectVideoSignalling } from "./web";
import type { VideoClientEvent } from "../../shared/screen/rpc";

export const initialNativeVideo = { active: false, connecting: false, fps: 0, kbps: 0, relay: null as boolean | null, rttMs: null as number | null, reason: null as string | null, still: null as string | null };
export type NativeVideoState = typeof initialNativeVideo;
export type NativeVideoCommand = { nonce: string; answer?: string; stop?: boolean; ack?: number };

/** RNCWebView embeds this property inside a JavaScript template literal on Android. */
export function nativeVideoCommandJson(command: NativeVideoCommand): string {
  return JSON.stringify(command).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** A view-scoped protocol. Other navigations and stale/replayed history events are ignored. */
export function nativeVideoEvent(url: string, nonce: string): Record<string, unknown> | null {
  const prefix = "https://paseo-rtc.invalid/#paseo-rtc=";
  if (!url.startsWith(prefix) || url.length > 200_000) return null;
  try {
    const value = JSON.parse(decodeURIComponent(url.slice(prefix.length)));
    return value && typeof value === "object" && value.nonce === nonce && Number.isSafeInteger(value.sequence) && value.sequence > 0 ? value : null;
  } catch { return null; }
}

/** Owns one native video attempt, including replies that arrive after unmount/pause. */
export class NativeVideoSession {
  private closed = false;
  private offered = false;
  private ready = false;
  private sequence = 0;
  private session: string | null = null;
  private lastCommand: NativeVideoCommand;
  private packet = 0;
  private chunks: { id: number; total: number; parts: string[] } | null = null;
  private timeout: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  get stopped(): boolean { return this.closed; }

  constructor(
    private readonly nonce: string,
    private readonly request: { display?: number; expectedDisplayKey?: string; maxWidth: number; fps: number },
    private readonly signalling: DirectVideoSignalling,
    private readonly command: (command: NativeVideoCommand) => void,
    private readonly update: (state: NativeVideoState) => void,
  ) {
    this.lastCommand = { nonce };
    this.event("starting");
    update({ ...initialNativeVideo, connecting: true });
    this.timeout = setTimeout(() => this.stop("Direct video did not arrive; using Paseo frames."), 25_000);
  }

  private send(command: Partial<NativeVideoCommand>): void {
    this.lastCommand = { ...this.lastCommand, ...command };
    this.command(this.lastCommand);
  }

  private event(phase: VideoClientEvent["phase"], code?: VideoClientEvent["code"]): void {
    try { void this.signalling.report?.({ attempt: this.nonce, phase, ...(code ? { code } : {}) }).catch(() => {}); }
    catch { /* Diagnostics never interrupt video. */ }
  }

  receive(url: string, title?: string): void {
    if (this.closed) return;
    let event: Record<string, unknown> | null;
    const prefix = `paseo-rtc:${this.nonce}:`;
    if (title?.startsWith(prefix)) {
      if (title.length > 1600) return;
      const fields = title.slice(prefix.length).split(":");
      if (fields.length !== 5) return;
      const [packet, id, index, total] = fields.slice(0, 4).map(Number);
      const part = fields[4]!;
      if (![packet, id, index, total].every(Number.isSafeInteger) || packet! <= 0 || id! <= 0 || index! < 0 || total! < 1 || total! > 200 || index! >= total! || part.length > 1000) return;
      if (packet! <= this.packet) { if (packet === this.packet) this.send({ ack: packet }); return; }
      if (index === 0) this.chunks = { id: id!, total: total!, parts: [] };
      const chunks = this.chunks;
      if (!chunks || chunks.id !== id || chunks.total !== total || chunks.parts.length !== index) return;
      chunks.parts.push(part); this.packet = packet!; this.send({ ack: packet });
      if (chunks.parts.length !== chunks.total) return;
      this.chunks = null;
      event = nativeVideoEvent(`https://paseo-rtc.invalid/#paseo-rtc=${chunks.parts.join("")}`, this.nonce);
    } else event = nativeVideoEvent(url, this.nonce);
    if (!event || Number(event.sequence) <= this.sequence) return;
    this.sequence = Number(event.sequence);
    if (event.type === "offer" && !this.offered && typeof event.sdp === "string" && event.sdp.length > 0 && event.sdp.length <= 65536) {
      this.offered = true;
      void this.offer(event.sdp);
    } else if (event.type === "ready" && this.session && Number(event.width) > 0 && Number(event.height) > 0) {
      this.ready = true;
      this.event("ready");
      clearTimeout(this.timeout);
      this.update({ ...initialNativeVideo, active: true });
    } else if (event.type === "stats" && this.ready) {
      const fps = Number(event.fps), kbps = Number(event.kbps);
      if (Number.isFinite(fps) && fps >= 0 && Number.isFinite(kbps) && kbps >= 0)
        this.update({ ...initialNativeVideo, active: true, fps, kbps, relay: typeof event.relay === "boolean" ? event.relay : null, rttMs: typeof event.rttMs === "number" && Number.isFinite(event.rttMs) ? event.rttMs : null });
    } else if (event.type === "answer-applied") this.event("answer-applied");
    else if (event.type === "connection" && (event.state === "connecting" || event.state === "connected")) this.event(event.state);
    else if (event.type === "error" && typeof event.message === "string") this.stop(event.message.slice(0, 500));
  }

  private async offer(sdp: string): Promise<void> {
    try {
      this.event("offer");
      const answer = await this.signalling.offer({ ...this.request, sdp });
      if (this.closed) { void this.signalling.stop({ session: answer.session }).catch(() => {}); return; }
      this.session = answer.session;
      if (this.request.expectedDisplayKey && answer.displayKey !== this.request.expectedDisplayKey) throw new Error("Display changed; wait for a fresh frame");
      this.event("answer");
      this.send({ answer: answer.sdp });
      this.heartbeat = setInterval(() => {
        void this.signalling.ping({ session: answer.session }).catch(() => this.stop("Video session ended; using Paseo frames."));
      }, 3000);
    } catch (error) { this.stop(`${error instanceof Error ? error.message : "Direct video unavailable"}; using Paseo frames.`); }
  }

  stop(reason: string | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.event(reason ? "failed" : "closed", reason ? /did not arrive|timed out/i.test(reason) ? "timeout" : /disconnect|connection|session ended/i.test(reason) ? "transport" : /decod/i.test(reason) ? "decoder" : /unavailable|not available/i.test(reason) ? "unavailable" : "other" : undefined);
    clearTimeout(this.timeout); clearInterval(this.heartbeat);
    this.send({ stop: true });
    if (this.session) void this.signalling.stop({ session: this.session }).catch(() => {});
    this.update({ ...initialNativeVideo, reason });
  }
}
