import { describe, expect, it } from "vitest";
import { formatBandwidth, FrameMetrics } from "../client/viewer/frame-metrics";

describe("viewer image statistics", () => {
  it("measures received bytes instead of multiplying the last image size by polling rate", () => {
    const metrics = new FrameMetrics();
    metrics.record(0, 3000, true);
    expect(metrics.record(1000, 0, false)).toEqual({ fps: 1 / 3, kbps: 8 });
    expect(metrics.record(2000, 6000, true)).toEqual({ fps: 2 / 3, kbps: 24 });
  });

  it("includes duplicate or stale image traffic without counting it as a presented frame", () => {
    const metrics = new FrameMetrics();
    metrics.record(0, 3000, true);
    expect(metrics.record(100, 3000, false)).toEqual({ fps: 1 / 3, kbps: 16 });
  });

  it("ages traffic and frames out on metadata-only replies", () => {
    const metrics = new FrameMetrics();
    metrics.record(0, 3000, true);
    expect(metrics.record(3000, 0, false)).toEqual({ fps: 0, kbps: 0 });
  });

  it("starts each capture session with independent counters", () => {
    new FrameMetrics().record(0, 9000, true);
    expect(new FrameMetrics().record(1000, 0, false)).toEqual({ fps: 0, kbps: 0 });
  });

  it.each([[0, "0 kbps"], [128.4, "128 kbps"], [1000, "1.0 Mbps"], [12600, "12.6 Mbps"]])("formats %s kbps as %s", (kbps, expected) => {
    expect(formatBandwidth(Number(kbps))).toBe(expected);
  });
});
