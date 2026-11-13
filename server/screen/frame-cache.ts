import { createHash } from "node:crypto";

export interface CachedFrame { jpeg: Buffer; base64: string; hash: string; capturedAt: number }

/** Waits for a changed frame instead of making clients sleep between cheap cache reads. */
export class FrameCache {
  private current: CachedFrame | null = null;
  private waiters = new Set<() => void>();

  publish(jpeg: Buffer): void {
    const hash = createHash("sha256").update(jpeg).digest("hex");
    if (hash === this.current?.hash) return;
    this.current = { jpeg, base64: jpeg.toString("base64"), hash, capturedAt: Date.now() };
    for (const notify of this.waiters) notify();
  }

  async read(since: string | undefined, waitMs: number): Promise<{ frame: CachedFrame | null; waitedMs: number }> {
    const started = Date.now();
    if (this.current && this.current.hash === since && waitMs > 0 && this.waiters.size < 64) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
        const timer = setTimeout(done, Math.min(350, waitMs));
        this.waiters.add(done);
      });
    }
    return { frame: this.current, waitedMs: Date.now() - started };
  }

  close(): void {
    for (const notify of this.waiters) notify();
    this.current = null;
  }
}
