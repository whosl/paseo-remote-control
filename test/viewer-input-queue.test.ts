import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { ScreenInputEvent } from "../shared/screen/rpc";
import type { useInputQueue } from "../client/viewer/use-screen";

// Execute the production hook with deterministic hooks/RPCs, without loading React Native,
// a browser, or native modules. Transpilation is in memory and creates no generated files.
const source = readFileSync(new URL("../client/viewer/use-screen.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type RpcName = "input" | "release";
type InputArgs = { display?: number; expectedDisplayKey?: string; events?: ScreenInputEvent[] };
type Reply = { handled?: number; pointerDisplay?: number };
type EffectSlot = { deps: readonly unknown[]; cleanup?: () => void };

function setup() {
  const slots: unknown[] = [];
  const effects: (() => void)[] = [];
  const cleanups = new Map<number, () => void>();
  const calls: { name: RpcName; args: InputArgs }[] = [];
  const pending: { name: RpcName; resolve(value: Reply): void; reject(error: Error): void }[] = [];
  const errors: (string | null)[] = [];
  const pointerDisplays: number[] = [];
  let cursor = 0;
  const sameDeps = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useRef<T>(value: T): { current: T } {
      const index = cursor++;
      return (slots[index] ??= { current: value }) as { current: T };
    },
    useCallback<T>(callback: T, deps: readonly unknown[]): T {
      const index = cursor++;
      const old = slots[index] as { callback: T; deps: readonly unknown[] } | undefined;
      if (!old || !sameDeps(deps, old.deps)) slots[index] = { callback, deps };
      return (slots[index] as { callback: T }).callback;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = cursor++;
      const old = slots[index] as EffectSlot | undefined;
      if (!old || !sameDeps(deps, old.deps)) effects.push(() => {
        old?.cleanup?.();
        const cleanup = effect() || undefined;
        slots[index] = { deps, cleanup } satisfies EffectSlot;
        if (cleanup) cleanups.set(index, cleanup);
        else cleanups.delete(index);
      });
    },
  };
  const rpc = (name: RpcName) => (args: InputArgs) => {
    calls.push({ name, args });
    return new Promise<Reply>((resolve, reject) => pending.push({ name, resolve, reject }));
  };
  const rpcs = { input: rpc("input"), release: rpc("release") };
  const api = {} as { useInputQueue: typeof useInputQueue };
  const modules: Record<string, unknown> = {
    react,
    "react-native": {},
    "@getpaseo/plugin/client": { useRpc: (name: RpcName) => rpcs[name] },
    "../../shared/screen/rpc": { inputRpc: "input", releaseInputRpc: "release" },
    "../../shared/screen/capture-policy": {},
  };
  runInNewContext(code, {
    exports: api,
    require(name: string) {
      if (!(name in modules)) throw new Error(`Unexpected hook dependency: ${name}`);
      return modules[name];
    },
    setTimeout, clearTimeout,
  });
  return {
    calls, errors, pointerDisplays,
    names: () => calls.map((call) => call.name),
    render(key = "physical-A", enabled = true, displayId = 7) {
      cursor = 0;
      const send = api.useInputQueue(displayId, (error) => errors.push(error), (id) => pointerDisplays.push(id), key, enabled);
      while (effects.length) effects.shift()!();
      return send;
    },
    unmount() {
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
    },
    async resolve(name: RpcName, reply: Reply = {}) {
      expect(pending[0]?.name).toBe(name);
      pending.shift()!.resolve(reply);
      await settle();
    },
    async reject(name: RpcName, message = "RPC failed") {
      expect(pending[0]?.name).toBe(name);
      pending.shift()!.reject(new Error(message));
      await settle();
    },
  };
}

const down: ScreenInputEvent = { type: "down", x: 0.5, y: 0.5, button: "left" };
const up: ScreenInputEvent = { type: "up", x: 0.5, y: 0.5, button: "left" };

describe("viewer input queue release ordering", () => {
  it("does not release during initial setup or unchanged renders", () => {
    const h = setup();
    h.render();
    h.render();
    expect(h.calls).toEqual([]);
  });

  it("releases an acknowledged down when control becomes disabled", async () => {
    const h = setup();
    const send = h.render();
    send(down);
    await h.resolve("input", { handled: 1 });
    h.render("physical-A", false);
    send(up);
    expect(h.names()).toEqual(["input", "release"]);
    expect(h.calls[1]!.args).toEqual({}); // No display remapping or arbitrary input in release.
    await h.resolve("release");
    expect(h.names()).toEqual(["input", "release"]);
  });

  it("drops queued up after invalidation and releases only after pending down settles", async () => {
    const h = setup();
    const send = h.render();
    send(down);
    send(up);
    h.render("physical-A", false);
    expect(h.names()).toEqual(["input"]);
    await h.resolve("input", { handled: 1 });
    expect(h.names()).toEqual(["input", "release"]);
    await h.resolve("release");
    expect(h.names()).toEqual(["input", "release"]);
    expect(h.calls[0]!.args.events).toEqual([down]);
  });

  it("releases before new input when hotplug reuses a numeric display ID", async () => {
    const h = setup();
    h.render()(down);
    const send = h.render("virtual-B");
    send(down);
    expect(h.names()).toEqual(["input"]);
    expect(h.calls[0]!.args.expectedDisplayKey).toBe("physical-A");
    await h.resolve("input", { handled: 1 });
    expect(h.names()).toEqual(["input", "release"]);
    await h.resolve("release");
    expect(h.names()).toEqual(["input", "release", "input"]);
    expect(h.calls[2]!.args).toEqual({ display: 7, expectedDisplayKey: "virtual-B", events: [down] });
    await h.resolve("input", { handled: 1 });
  });

  it("also releases when only the numeric display ID changes", async () => {
    const h = setup();
    h.render();
    h.render("physical-A", true, 8);
    expect(h.names()).toEqual(["release"]);
    await h.resolve("release");
  });

  it("ignores a stale drag reply instead of remapping the new display", async () => {
    const h = setup();
    h.render()(up);
    h.render("virtual-B");
    await h.resolve("input", { handled: 1, pointerDisplay: 99 });
    expect(h.pointerDisplays).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.names()).toEqual(["input", "release"]);
    await h.resolve("release");
  });

  it("releases again if another generation starts during a release", async () => {
    const h = setup();
    h.render();
    h.render("physical-A", false);
    h.render("physical-A", true)(down);
    expect(h.names()).toEqual(["release"]);
    await h.resolve("release");
    expect(h.names()).toEqual(["release", "release"]);
    await h.resolve("release");
    expect(h.names()).toEqual(["release", "release", "input"]);
    await h.resolve("input", { handled: 1 });
  });

  it("releases on idle unmount", async () => {
    const h = setup();
    h.render();
    h.unmount();
    expect(h.names()).toEqual(["release"]);
    await h.resolve("release");
  });

  it("waits for in-flight input on unmount and never sends queued or subsequent input", async () => {
    const h = setup();
    const send = h.render();
    send(down);
    send(up);
    h.unmount();
    send(down);
    expect(h.names()).toEqual(["input"]);
    await h.resolve("input", { handled: 1 });
    expect(h.names()).toEqual(["input", "release"]);
    await h.resolve("release");
    expect(h.names()).toEqual(["input", "release"]);
    expect(h.errors).toEqual([]);
  });

  it("still releases when the invalidated in-flight input rejects", async () => {
    const h = setup();
    h.render()(down);
    h.render("physical-A", false);
    await h.reject("input");
    expect(h.names()).toEqual(["input", "release"]);
    await h.resolve("release");
  });

  it("blocks input after release failure and retries release before accepting new input", async () => {
    const h = setup();
    h.render();
    const send = h.render("virtual-B");
    send(up);
    await h.reject("release", "release failed");
    expect(h.names()).toEqual(["release"]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("release failed");
    send(down);
    expect(h.names()).toEqual(["release", "release"]);
    await h.resolve("release");
    expect(h.names()).toEqual(["release", "release", "input"]);
    expect(h.calls[2]!.args.events).toEqual([down]); // Failed-release queued up is discarded.
    expect(h.calls[2]!.args.expectedDisplayKey).toBe("virtual-B");
    await h.resolve("input", { handled: 1 });
  });
});
