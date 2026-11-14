const WINDOW_MS = 3000;

/** Image payload throughput, excluding RPC envelopes and transport overhead. */
export class FrameMetrics {
  private samples: { at: number; bytes: number; rendered: boolean }[] = [];

  record(now: number, bytes: number, rendered: boolean) {
    this.samples.push({ at: now, bytes, rendered });
    while (this.samples.length && this.samples[0]!.at <= now - WINDOW_MS) this.samples.shift();
    return {
      fps: this.samples.filter(sample => sample.rendered).length * 1000 / WINDOW_MS,
      kbps: Math.round(this.samples.reduce((total, sample) => total + sample.bytes, 0) * 8 / WINDOW_MS),
    };
  }
}

export function formatBandwidth(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}
