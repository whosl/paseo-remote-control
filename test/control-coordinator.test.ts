import { describe, expect, it, vi } from "vitest";
import { ControlCoordinator } from "../server/control/coordinator";

const action = (callerId = "agent-one", mutating = true) => ({ callerId, agentId: callerId, toolName: "click", app: "fixture", mutating });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function setup(overrides = {}) {
  const deps = { stopAgent: vi.fn(async () => {}), releaseInput: vi.fn(async () => {}), showNotice: vi.fn(async () => {}), updateNotice: vi.fn(), persist: vi.fn(async () => {}), ...overrides };
  return { control: new ControlCoordinator(deps), deps };
}
describe("Shared control authority", () => {
  it("shows a notice before allowing a mutation; observers do not claim control", async () => {
    const { control, deps } = setup();
    await control.beforeAgent(action("reader", false));
    expect(control.snapshot().mode).toBe("idle"); expect(deps.showNotice).not.toHaveBeenCalled();
    const notice = deferred(); deps.showNotice.mockImplementation(() => notice.promise);
    const claiming = control.beforeAgent(action());
    expect(control.snapshot()).toMatchObject({ mode: "agent", agentId: "agent-one", tool: "click", app: "fixture" });
    let ready = false; void claiming.then(() => { ready = true; });
    await Promise.resolve(); expect(ready).toBe(false);
    notice.resolve(); await claiming; expect(ready).toBe(true);
  });
  it("same-agent concurrent claims cannot skip notice acknowledgement", async () => {
    const notice = deferred(); const { control } = setup({ showNotice: () => notice.promise });
    const a = control.beforeAgent(action()), b = control.beforeAgent(action());
    let ready = false; void b.then(() => { ready = true; }); await Promise.resolve(); expect(ready).toBe(false);
    notice.resolve(); await Promise.all([a,b]);
  });
  it("refuses input if the visible notice fails", async () => {
    const { control } = setup({ showNotice: async () => { throw Error("missing layer-shell"); } });
    await expect(control.beforeAgent(action())).rejects.toThrow("visible control notice");
    expect(control.snapshot()).toMatchObject({ mode: "idle", agentId: null });
  });
  it("allows one agent; human input must explicitly take over", async () => {
    const { control } = setup(); await control.beforeAgent(action());
    await expect(control.allowAgents()).rejects.toThrow("Take over");
    await expect(control.beforeAgent(action("agent-two"))).rejects.toThrow("Another agent");
    const input = vi.fn(async () => {}); await expect(control.runHuman(input)).rejects.toThrow("Take over"); expect(input).not.toHaveBeenCalled();
    await control.takeOver(); await control.runHuman(input); expect(input).toHaveBeenCalledOnce();
  });
  it("does not unlock agents while an allow policy is still being saved", async () => {
    const { control, deps } = setup(); await control.takeOver();
    const saved = deferred(); deps.persist.mockImplementation(() => saved.promise);
    const allowing = control.allowAgents(); await Promise.resolve();
    expect(control.snapshot().humanPriority).toBe(true);
    await expect(control.beforeAgent(action())).rejects.toThrow("priority");
    saved.resolve(); await allowing; expect(control.snapshot().humanPriority).toBe(false);
  });
  it("keeps human priority if saving agent access fails", async () => {
    const { control, deps } = setup(); await control.takeOver();
    deps.persist.mockRejectedValueOnce(Error("disk full"));
    await expect(control.allowAgents()).rejects.toThrow("disk full");
    expect(control.snapshot().humanPriority).toBe(true);
    await expect(control.beforeAgent(action())).rejects.toThrow("priority");
  });
  it("human takeover revokes immediately, drains actual I/O, then releases keys", async () => {
    const io = deferred(), started = deferred(); const order: string[] = [];
    const signal = new AbortController();
    const { control } = setup({ stopAgent: async () => { signal.abort(); }, releaseInput: async () => { order.push("released"); } });
    await control.beforeAgent(action());
    const active = control.runAgent(action(), signal.signal, async () => { started.resolve(); await io.promise; order.push("agent cleanup"); });
    await started.promise;
    const stale = control.runAgent(action(), new AbortController().signal, async () => { order.push("stale agent"); });
    const staleResult = expect(stale).rejects.toThrow("priority");
    const taking = control.takeOver(); expect(control.snapshot().humanPriority).toBe(true);
    const human = control.runHuman(async () => { order.push("human input"); });
    await Promise.resolve(); expect(order).toEqual([]);
    io.resolve(); await Promise.all([active, taking, human, staleResult]);
    expect(order).toEqual(["agent cleanup", "released", "human input"]);
    await expect(control.beforeAgent(action())).rejects.toThrow("priority");
  });
  it("blocks an acquire that was awaiting notice when the human took over", async () => {
    const notice = deferred(); const { control } = setup({ showNotice: () => notice.promise });
    const pending = control.beforeAgent(action()); const result = expect(pending).rejects.toThrow("priority");
    await control.takeOver(); notice.resolve(); await result;
    expect(control.snapshot().mode).toBe("human");
  });
  it("first human input reserves control until explicit allow; turn end cannot clear the latch", async () => {
    const { control } = setup(); await control.runHuman(async () => {});
    control.releaseAgent(); expect(control.snapshot()).toMatchObject({ mode: "human", humanPriority: true });
    await expect(control.beforeAgent(action())).rejects.toThrow("priority");
    await control.allowAgents(); await control.beforeAgent(action()); expect(control.snapshot().mode).toBe("agent");
  });
  it("pause stops both entry points; resuming keeps human priority", async () => {
    const { control, deps } = setup(); await control.beforeAgent(action()); await control.pause(true);
    await expect(control.beforeAgent(action())).rejects.toThrow("priority"); await expect(control.runHuman(async () => {})).rejects.toThrow("paused");
    await expect(control.allowAgents()).rejects.toThrow("Resume"); await control.pause(false);
    expect(control.snapshot()).toMatchObject({ paused: false, mode: "human", humanPriority: true }); expect(deps.stopAgent).toHaveBeenCalledTimes(2);
  });
  it("allow cannot win over a newer human takeover while draining input", async () => {
    const { control } = setup(); await control.takeOver();
    const io = deferred(), started = deferred(); const input = control.runHuman(async () => { started.resolve(); await io.promise; }); await started.promise;
    const allowing = control.allowAgents(); const refused = expect(allowing).rejects.toThrow("Control changed");
    const taking = control.takeOver(); io.resolve(); await Promise.all([input, taking, refused]); expect(control.snapshot().humanPriority).toBe(true);
  });
  it("revokes queued human input on pause", async () => {
    const { control } = setup(); await control.takeOver(); const io = deferred(), started = deferred();
    const active = control.runHuman(async () => { started.resolve(); await io.promise; }); await started.promise;
    const stale = control.runHuman(async () => { throw Error("should not execute"); }); const result = expect(stale).rejects.toThrow("revoked");
    await Promise.resolve(); const pausing = control.pause(true); io.resolve(); await Promise.all([active, pausing, result]);
  });
  it("restores persisted human priority and refuses input after stop", async () => {
    const { control } = setup(); control.initialize({ paused: false, humanPriority: true });
    await expect(control.beforeAgent(action())).rejects.toThrow("priority"); await control.stop();
    await expect(control.runHuman(async () => {})).rejects.toThrow("paused");
  });
  it("releases an agent after its turn without granting another agent human-held control", async () => {
    const { control } = setup(); await control.beforeAgent(action()); control.releaseAgent("unrelated"); expect(control.snapshot().mode).toBe("agent");
    control.releaseAgent("agent-one"); expect(control.snapshot().mode).toBe("idle"); await control.beforeAgent(action("agent-two"));
    await control.takeOver(); control.releaseAgent("agent-two"); expect(control.snapshot().mode).toBe("human");
  });
});
