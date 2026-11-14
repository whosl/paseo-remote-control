import { describe, it, expect, vi } from "vitest";
import { WindowsVideo } from "../server/screen/windows-video";
import type { WebRtcWorker } from "../server/screen/webrtc";

function fixture() {
  const status = { locked: false, windowsTopology: { reliable: true }, displays: [{ id: 2, stableKey: "vdd-monitor", pixelWidth: 1920, pixelHeight: 1080 }] };
  const capture = { request: vi.fn(async (command: string) => command === "status" ? status : { started: true }) };
  const worker = { available: vi.fn(async () => true), offerWindows: vi.fn(async (_request: unknown, start: (feed: Record<string, unknown>) => Promise<unknown>) => { await start({ port: 1234, token: "private" }); return { session: "session", sdp: "answer" }; }), command: vi.fn(async () => ({})), stop: vi.fn(async () => {}) };
  const video = new WindowsVideo(capture as never, worker as unknown as WebRtcWorker);
  const request = { display: 2, expectedDisplayKey: "vdd-monitor", maxWidth: 2560, fps: 30, sdp: "offer" };
  return { status, capture, worker, video, request };
}

describe("Windows identity-bound WebRTC", () => {
  it("captures the actual display at even dimensions without upscaling or leaking the feed capability", async () => {
    const f = fixture();
    expect(await f.video.offer(f.request)).toEqual({ session: "session", sdp: "answer", displayKey: "vdd-monitor" });
    expect(f.worker.offerWindows.mock.calls[0]![0]).toEqual({ width: 1920, height: 1080, fps: 30, sdp: "offer" });
    expect(f.capture.request.mock.calls.at(-1)).toEqual(["video-start", { port: 1234, token: "private", stableKey: "vdd-monitor" }]);
  });
  it.each([undefined, "old-monitor"])("refuses a stale or absent media identity %s before starting capture", async expectedDisplayKey => {
    const f = fixture();
    await expect(f.video.offer({ ...f.request, expectedDisplayKey })).rejects.toThrow("Display changed");
    expect(f.worker.offerWindows).not.toHaveBeenCalled();
  });
  it.each(["locked", "unreliable"])("refuses %s desktops", async cause => {
    const f = fixture(); if (cause === "locked") f.status.locked = true; else f.status.windowsTopology.reliable = false;
    await expect(f.video.offer(f.request)).rejects.toThrow("Unlock a stable display");
    expect(f.worker.offerWindows).not.toHaveBeenCalled();
  });
  it("does not select another display when the requested one disappears", async () => {
    const f = fixture(); f.status.displays[0]!.id = 3;
    await expect(f.video.offer(f.request)).rejects.toThrow("Display changed");
  });
});
