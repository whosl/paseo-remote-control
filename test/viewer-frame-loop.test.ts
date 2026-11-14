import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useFrames } from "../client/viewer/use-screen";
import type { ScreenFrame } from "../shared/screen/rpc";
import { captureFps } from "../shared/screen/capture-policy";
import { FrameMetrics } from "../client/viewer/frame-metrics";

const source = readFileSync(new URL("../client/viewer/use-screen.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function setup(reply?: () => Promise<ScreenFrame>) {
  const slots: unknown[] = [];
  const effects: (() => void)[] = [];
  let cursor = 0;
  let sequence = 0;
  let appChange = (_state: string) => {};
  const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useRef<T>(value: T) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState<T>(initial: T) {
      const i = cursor++;
      slots[i] ??= initial;
      return [slots[i], (value: T | ((old: T) => T)) => { slots[i] = typeof value === "function" ? (value as (old: T) => T)(slots[i] as T) : value; }];
    },
    useCallback<T>(callback: T, _deps: readonly unknown[]) { cursor++; return callback; },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const i = cursor++;
      const old = slots[i] as { deps: readonly unknown[]; cleanup?: () => void } | undefined;
      if (!old || !same(old.deps, deps)) effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
    },
  };
  const rpc = vi.fn(reply ?? (() => new Promise<ScreenFrame>(resolve => {
    const hash = String(sequence++);
    setTimeout(() => resolve({ locked: false, hash, jpeg: hash, bytes: 100 }), 10);
  })));
  const modules: Record<string, unknown> = {
    react,
    "react-native": { AppState: { currentState: "active", addEventListener: (_: string, callback: typeof appChange) => { appChange = callback; return { remove() {} }; } }, PixelRatio: { get: () => 1 } },
    "@getpaseo/plugin/client": { useRpc: () => rpc },
    "../../shared/screen/rpc": { frameRpc: "frame" },
    "../../shared/screen/capture-policy": { captureFps },
    "./frame-metrics": { FrameMetrics },
  };
  const api = {} as { useFrames: typeof useFrames; QUALITIES: Parameters<typeof useFrames>[2][] };
  runInNewContext(code, { exports: api, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
    return modules[name];
  }, setTimeout, clearTimeout, Date, Error });
  return {
    rpc, background: () => { appChange("background"); expect(slots[0]).toBe("background"); },
    render(platform = "win32", quality = 1, active = true, key = "display-A") {
      cursor = 0;
      const result = api.useFrames(active, 6, api.QUALITIES[quality]!, 1728, false, key, platform);
      while (effects.length) effects.shift()!();
      return result;
    },
    unmount() {
      for (const slot of slots) (slot as { cleanup?: () => void } | undefined)?.cleanup?.();
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());

describe("viewer capture pacing", () => {
  it.each([[0, 30], [1, 24], [2, 15]])("paces Windows quality %s at %s requests/second across both lanes", async (quality, fps) => {
    const h = setup(); h.render("win32", quality);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.rpc.mock.calls.length).toBeGreaterThanOrEqual(fps);
    expect(h.rpc.mock.calls.length).toBeLessThanOrEqual(fps + 1);
    h.unmount();
  });

  it("preserves the existing non-Windows request cadence", async () => {
    const h = setup(); h.render("linux");
    await vi.advanceTimersByTimeAsync(999);
    expect(h.rpc).toHaveBeenCalledTimes(10);
    h.unmount();
  });

  it("keeps at most two requests outstanding on a slow host", async () => {
    const pending: ((value: ScreenFrame) => void)[] = [];
    const h = setup(() => new Promise(resolve => pending.push(resolve)));
    h.render(); await vi.advanceTimersByTimeAsync(3000);
    expect(h.rpc).toHaveBeenCalledTimes(2);
    h.unmount();
    pending.forEach(resolve => resolve({ locked: false, jpeg: "late", hash: "late" }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it("does not inflate the displayed FPS when the desktop is unchanged", async () => {
    const h = setup(async () => ({ locked: false, jpeg: "same", hash: "same" }));
    h.render(); await vi.advanceTimersByTimeAsync(4000);
    expect(h.render().fps).toBe(0);
    h.unmount();
  });

  it("stops polling when the app backgrounds", async () => {
    const h = setup(); h.render(); await vi.advanceTimersByTimeAsync(100);
    h.background(); h.render();
    const count = h.rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.rpc).toHaveBeenCalledTimes(count);
    expect(h.render().fps).toBe(0);
    h.unmount();
  });

  it("backs off failed captures instead of retrying at the faster rate", async () => {
    const h = setup(async () => { throw new Error("Desktop unavailable"); });
    h.render(); await vi.advanceTimersByTimeAsync(1999);
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(h.render().error).toBe("Desktop unavailable");
    h.unmount();
  });
});
