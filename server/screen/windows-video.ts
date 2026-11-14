import type { ScreenStatus } from "../../shared/screen/rpc";
import { WebRtcWorker } from "./webrtc";

type Capture = { request<T extends Record<string, unknown>>(command: string, payload?: Record<string, unknown>): Promise<T> };

/** Media stays bound to the selected monitor; input still uses the existing coordinator and helper. */
export class WindowsVideo {
  constructor(private readonly capture: Capture, private readonly worker = new WebRtcWorker(message => console.error(`[paseo-screen] ${message}`))) {}
  available() { return this.worker.available(); }

  async offer(request: { display?: number; expectedDisplayKey?: string; maxWidth: number; fps: number; sdp: string }) {
    const status = await this.capture.request<Pick<ScreenStatus, "displays" | "locked" | "windowsTopology">>("status");
    const display = status.displays.find(item => item.id === request.display);
    if (!display?.stableKey || display.stableKey !== request.expectedDisplayKey)
      throw new Error("Display changed; wait for a fresh frame");
    if (status.locked || !status.windowsTopology?.reliable) throw new Error("Unlock a stable display before starting video");
    const width = Math.max(2, Math.floor(Math.min(display.pixelWidth, request.maxWidth) / 2) * 2);
    const height = Math.max(2, Math.floor(display.pixelHeight * width / display.pixelWidth / 2) * 2);
    const result = await this.worker.offerWindows({ sdp: request.sdp, width, height, fps: request.fps }, feed =>
      this.capture.request("video-start", { ...feed, stableKey: display.stableKey }));
    return { ...result, displayKey: display.stableKey };
  }
  async command(method: "ping" | "stop", session: string) { await this.worker.command(method, session); return {}; }
  stop() { return this.worker.stop(); }
}
