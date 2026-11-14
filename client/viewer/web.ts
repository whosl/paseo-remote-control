import { AppState, Platform } from "react-native";
import { useEffect, useRef, useState } from "react";

declare const navigator: { platform?: string; userAgent?: string; vibrate?(duration: number): boolean; clipboard?: { writeText(text: string): Promise<void>; readText(): Promise<string> } };
export function vibrateBrowser(): void {
  if (Platform.OS !== "web" || typeof navigator === "undefined") return;
  try { navigator.vibrate?.(8); } catch { /* Unsupported or denied by browser policy. */ }
}
export const hasBrowserClipboard = () => Platform.OS === "web" && typeof navigator !== "undefined" && !!navigator.clipboard;
export const isAppleBrowser = () => Platform.OS === "web" && typeof navigator !== "undefined" && (/^(Mac|iPhone|iPad)/.test(navigator.platform ?? "") || /Macintosh|iPhone|iPad/.test(navigator.userAgent ?? ""));
export async function readBrowserClipboard(): Promise<string | null> {
  if (!hasBrowserClipboard()) return null;
  try { return await navigator.clipboard!.readText(); } catch { return null; }
}
export async function writeBrowserClipboard(text: string): Promise<void> {
  if (!hasBrowserClipboard()) throw new Error("This client does not expose its clipboard");
  await navigator.clipboard!.writeText(text);
}

interface FullscreenDocument {
  fullscreenElement?: unknown;
  exitFullscreen?(): Promise<void>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
interface FullscreenElement {
  ownerDocument: FullscreenDocument;
  requestFullscreen?(): Promise<void>;
}

export function useFullscreen(node: unknown) {
  const [active, setActive] = useState(false);
  const element = Platform.OS === "web" && node && typeof node === "object" && "ownerDocument" in node ? node as FullscreenElement : null;
  const supported = !!element?.requestFullscreen;
  useEffect(() => {
    if (!element) return;
    const update = () => setActive(element.ownerDocument.fullscreenElement === element);
    element.ownerDocument.addEventListener("fullscreenchange", update);
    update();
    return () => element.ownerDocument.removeEventListener("fullscreenchange", update);
  }, [element]);
  const toggle = async () => {
    if (!element) return;
    if (element.ownerDocument.fullscreenElement) await element.ownerDocument.exitFullscreen?.();
    else await element.requestFullscreen?.();
  };
  return { active, supported, toggle };
}

import type { VideoClientEvent, VideoIceConfiguration } from "../../shared/screen/rpc";

interface Codec { mimeType: string }
interface Description { type: "offer" | "answer"; sdp: string }
interface Peer {
  localDescription: Description | null;
  iceGatheringState: string;
  connectionState: string;
  ontrack: ((event: { track: unknown }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  addTransceiver(kind: string, options: { direction: string }): { setCodecPreferences?(codecs: Codec[]): void };
  createOffer(): Promise<Description>;
  setLocalDescription(description: Description): Promise<void>;
  setRemoteDescription(description: Description): Promise<void>;
  setConfiguration(configuration: VideoIceConfiguration): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  getStats(): Promise<{ get(id: string): Record<string, unknown> | undefined; forEach(fn: (report: Record<string, unknown>) => void): void }>;
  close(): void;
}
interface Video {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  muted: boolean;
  autoplay: boolean;
  playsInline: boolean;
  srcObject: unknown;
  style: Record<string, string>;
  onloadeddata: (() => void) | null;
  onerror: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
  remove(): void;
}
interface VideoContainer { ownerDocument: { createElement(tag: "video"): Video; createElement(tag: "canvas"): SnapshotCanvas }; appendChild(video: Video): void }
interface SnapshotCanvas { width: number; height: number; getContext(kind: string): { drawImage(video: Video, x: number, y: number): void } | null; toDataURL(type: string, quality: number): string }
declare const RTCPeerConnection: new (configuration: VideoIceConfiguration) => Peer;
declare const RTCRtpReceiver: { getCapabilities(kind: string): { codecs: Codec[] } | null };
declare const MediaStream: new (tracks: unknown[]) => unknown;

export interface DirectVideoSignalling {
  config?(): Promise<VideoIceConfiguration>;
  report?(event: VideoClientEvent): Promise<unknown>;
  offer(input: { display?: number; expectedDisplayKey?: string; maxWidth: number; fps: number; sdp: string }): Promise<{ session: string; sdp: string; displayKey?: string }>;
  ping(input: { session: string }): Promise<unknown>;
  stop(input: { session: string }): Promise<unknown>;
}
const initialVideo = { active: false, connecting: false, fps: 0, rttMs: null as number | null, kbps: 0, relay: null as boolean | null, reason: null as string | null, still: null as string | null };

/** Browser media; Android uses native-video and both retain the portable JPEG fallback. */
export function useDirectVideo(node: unknown, enabled: boolean, display: number | undefined, maxWidth: number, fps: number, signalling: DirectVideoSignalling, retry: number | string = 0, expectedDisplayKey?: string) {
  const [state, setState] = useState(initialVideo);
  const profile = JSON.stringify([display, maxWidth, fps, retry, expectedDisplayKey]);
  const boundProfile = useRef(profile);
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  useEffect(() => AppState.addEventListener("change", (value) => setForeground(value !== "background")).remove, []);
  const rpc = useRef(signalling);
  rpc.current = signalling;
  const supported = Platform.OS === "web" && typeof RTCPeerConnection !== "undefined" && typeof RTCRtpReceiver !== "undefined" && typeof MediaStream !== "undefined";
  useEffect(() => {
    if (!supported || !enabled || !foreground || !node || typeof node !== "object" || !("appendChild" in node)) { setState((previous) => ({ ...initialVideo, still: previous.still })); return; }
    const container = node as VideoContainer;
    let pc: Peer;
    try { pc = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: "all" }); }
    catch { setState({ ...initialVideo, reason: "Direct video is disabled in this browser; using Paseo frames." }); return; }
    const video = container.ownerDocument.createElement("video");
    video.muted = true; video.autoplay = true; video.playsInline = true;
    Object.assign(video.style, { position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none", opacity: "0" });
    container.appendChild(video);
    let closed = false, session: string | null = null;
    let firstFrame: ReturnType<typeof setTimeout> | undefined;
    let disconnected: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let statsTimer: ReturnType<typeof setInterval> | undefined;
    let last: { at: number; frames: number; bytes: number } | null = null;
    const stop = rpc.current.stop;
    const end = (reason: string | null) => {
      if (closed) return;
      closed = true;
      clearTimeout(firstFrame); clearTimeout(disconnected); clearInterval(heartbeat); clearInterval(statsTimer);
      let still: string | null = null;
      if (video.readyState >= 2 && video.videoWidth) try {
        const canvas = container.ownerDocument.createElement("canvas");
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext("2d");
        if (context) { context.drawImage(video, 0, 0); still = canvas.toDataURL("image/jpeg", 0.82); }
      } catch { /* Pausing still works if this browser cannot snapshot a video. */ }
      pc.ontrack = null; pc.onconnectionstatechange = null;
      pc.close(); video.onloadeddata = null; video.onerror = null; video.pause(); video.srcObject = null; video.remove();
      if (session) void stop({ session }).catch(() => {});
      setState({ ...initialVideo, reason, still });
    };
    boundProfile.current = profile;
    setState({ ...initialVideo, connecting: true });
    video.onloadeddata = () => {
      if (closed) return;
      clearTimeout(firstFrame);
      video.style.opacity = "1";
      setState((previous) => ({ ...previous, active: true, connecting: false, reason: null }));
    };
    video.onerror = () => end("Video decoding failed; using Paseo frames.");
    pc.ontrack = (event) => { video.srcObject = new MediaStream([event.track]); void video.play().catch(() => end("Video playback unavailable; using Paseo frames.")); };
    pc.onconnectionstatechange = () => {
      clearTimeout(disconnected);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") end("Direct connection unavailable; using Paseo frames.");
      else if (pc.connectionState === "disconnected") disconnected = setTimeout(() => end("Direct video disconnected; using Paseo frames."), 2500);
    };
    const start = async () => {
      if (rpc.current.config) {
        const configuration = await rpc.current.config();
        if (closed) return;
        pc.setConfiguration(configuration);
      }
      const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
      const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs.filter((codec) => codec.mimeType.toLowerCase() === "video/h264") ?? [];
      if (!codecs.length) throw new Error("H.264 decoding is unavailable");
      transceiver.setCodecPreferences?.(codecs);
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceGatheringState !== "complete") await new Promise<void>((resolve) => {
        // Send usable candidates even if a blocked ICE server is still being probed.
        const timer = setTimeout(() => { pc.removeEventListener("icegatheringstatechange", gathered); resolve(); }, 5000);
        const gathered = () => { if (pc.iceGatheringState === "complete") { clearTimeout(timer); pc.removeEventListener("icegatheringstatechange", gathered); resolve(); } };
        pc.addEventListener("icegatheringstatechange", gathered); gathered();
      });
      if (closed) return;
      const answer = await rpc.current.offer({ display, expectedDisplayKey, maxWidth, fps, sdp: pc.localDescription!.sdp });
      session = answer.session;
      if (closed) { void stop({ session }).catch(() => {}); return; }
      if (expectedDisplayKey && answer.displayKey !== expectedDisplayKey) throw new Error("Display changed; wait for a fresh frame");
      firstFrame = setTimeout(() => end("Direct video did not arrive; using Paseo frames."), 8000);
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      heartbeat = setInterval(() => { if (session) void rpc.current.ping({ session }).catch(() => end("Video session ended; using Paseo frames.")); }, 3000);
      statsTimer = setInterval(() => { void pc.getStats().then((reports) => {
        if (closed) return;
        let frames = 0, bytes = 0, rttMs: number | null = null, relay: boolean | null = null;
        let selected: unknown;
        reports.forEach(report => { if (report.type === "transport" && report.selectedCandidatePairId) selected = report.selectedCandidatePairId; });
        reports.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "video") { frames += Number(report.framesDecoded ?? 0); bytes += Number(report.bytesReceived ?? 0); }
          if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated && typeof report.currentRoundTripTime === "number") rttMs = Math.round(report.currentRoundTripTime * 1000);
          if (report.type === "candidate-pair" && (selected ? report.id === selected : report.state === "succeeded" && report.nominated)) {
            const local = reports.get(String(report.localCandidateId)), remote = reports.get(String(report.remoteCandidateId));
            if (local || remote) relay = local?.candidateType === "relay" || remote?.candidateType === "relay";
          }
        });
        const at = Date.now();
        if (last) { const seconds = Math.max(0.001, (at - last.at) / 1000); const previous = last; setState((current) => ({ ...current, fps: Math.max(0, (frames - previous.frames) / seconds), kbps: Math.max(0, Math.round((bytes - previous.bytes) * 8 / seconds / 1000)), rttMs, relay })); }
        last = { at, frames, bytes };
      }).catch(() => {}); }, 1000);
    };
    void start().catch((error) => end(`${error instanceof Error ? error.message : "Direct video unavailable"}; using Paseo frames.`));
    return () => end(null);
  }, [node, enabled, display, maxWidth, fps, supported, foreground, retry, expectedDisplayKey, profile]);
  return { ...state, active: state.active && boundProfile.current === profile, supported };
}

interface WebTouchEvent { touches: ArrayLike<{ clientX: number; clientY: number }>; preventDefault(): void }
interface WebTouchTarget {
  style: Record<string, string>;
  getBoundingClientRect(): { left: number; top: number };
  addEventListener(type: string, callback: (event: WebTouchEvent) => void, options: { passive: boolean }): void;
  removeEventListener(type: string, callback: (event: WebTouchEvent) => void): void;
}
interface TouchHandlers { start(points: { x: number; y: number }[]): void; move(points: { x: number; y: number }[]): void; end(remaining: number): void; cancel(): void }

export function useWebTouch(node: unknown, handlers: TouchHandlers): void {
  const current = useRef(handlers); current.current = handlers;
  useEffect(() => {
    if (Platform.OS !== "web" || !node || typeof node !== "object" || !("addEventListener" in node)) return;
    const element = node as WebTouchTarget;
    const before = { touchAction: element.style.touchAction, userSelect: element.style.userSelect, webkitTouchCallout: element.style.webkitTouchCallout };
    Object.assign(element.style, { touchAction: "none", userSelect: "none", webkitTouchCallout: "none" });
    const points = (event: WebTouchEvent) => { const rect = element.getBoundingClientRect(); return Array.from(event.touches, (touch) => ({ x: touch.clientX - rect.left, y: touch.clientY - rect.top })); };
    const start = (event: WebTouchEvent) => { event.preventDefault(); current.current.start(points(event)); };
    const move = (event: WebTouchEvent) => { event.preventDefault(); current.current.move(points(event)); };
    const end = (event: WebTouchEvent) => { event.preventDefault(); current.current.end(event.touches.length); };
    const cancel = () => current.current.cancel();
    const prevent = (event: WebTouchEvent) => event.preventDefault();
    const listeners: [string, (event: WebTouchEvent) => void][] = [["touchstart", start], ["touchmove", move], ["touchend", end], ["touchcancel", cancel], ["dragstart", prevent], ["contextmenu", prevent]];
    for (const [type, fn] of listeners) element.addEventListener(type, fn, { passive: false });
    return () => { for (const [type, fn] of listeners) element.removeEventListener(type, fn); Object.assign(element.style, before); current.current.cancel(); };
  }, [node]);
}
