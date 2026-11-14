import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlCoordinator } from "../server/control/coordinator";
import { startViewerSession } from "../client/viewer/viewer-session";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  vi.useFakeTimers();
  const deps = { stopAgent: vi.fn(async () => {}), releaseInput: vi.fn(async () => {}), showNotice: vi.fn(async () => {}), updateNotice: vi.fn(), persist: vi.fn(async (_value: { paused: boolean; humanPriority: boolean }) => {}) };
  return { control: new ControlCoordinator(deps), deps };
}
afterEach(() => vi.useRealTimers());

describe("automatic permission return on confirmed viewer exit", () => {
  it("watching alone does not claim or revoke agent control", async () => {
    const { control, deps } = setup();
    const page = control.openViewer();
    expect(control.snapshot().humanPriority).toBe(false);
    await control.closeViewer(page.viewerId);
    expect(deps.persist).not.toHaveBeenCalled();
  });
  it("last page exit drains input and persists agent access", async () => {
    const { control, deps } = setup(); const page = control.openViewer();
    await control.runHuman(async () => {}, page.viewerId);
    const closing = control.closeViewer(page.viewerId);
    expect(control.snapshot().humanPriority).toBe(true);
    await vi.advanceTimersByTimeAsync(200); await closing;
    expect(control.snapshot()).toMatchObject({ mode: "idle", humanPriority: false });
    expect(deps.persist).toHaveBeenLastCalledWith({ paused: false, humanPriority: false });
    await control.beforeAgent({ callerId: "agent", toolName: "click", mutating: true });
    expect(control.snapshot().mode).toBe("agent");
  });
  it("one page cannot grant access while another page is open", async () => {
    const { control } = setup(); const a = control.openViewer(), b = control.openViewer();
    await control.takeOver(); await control.closeViewer(a.viewerId);
    await vi.advanceTimersByTimeAsync(1000);
    expect(control.snapshot().humanPriority).toBe(true);
    const closing = control.closeViewer(b.viewerId); await vi.advanceTimersByTimeAsync(200); await closing;
    expect(control.snapshot().humanPriority).toBe(false);
  });
  it("never resumes a manually paused host", async () => {
    const { control } = setup(); const page = control.openViewer(); await control.pause(true);
    await control.closeViewer(page.viewerId); await vi.advanceTimersByTimeAsync(1000);
    expect(control.snapshot()).toMatchObject({ paused: true, humanPriority: true });
  });
  it("a spectator exit does not stop an active agent", async () => {
    const { control, deps } = setup(); const page = control.openViewer();
    await control.beforeAgent({ callerId: "agent", toolName: "click", mutating: true });
    await control.closeViewer(page.viewerId);
    expect(control.snapshot().mode).toBe("agent"); expect(deps.stopAgent).not.toHaveBeenCalled();
  });
  it("rejects late input and takeover from a departed page", async () => {
    const { control } = setup(); const page = control.openViewer(); await control.takeOver();
    const closing = control.closeViewer(page.viewerId);
    const input = vi.fn(async () => {});
    await expect(control.runHuman(input, page.viewerId)).rejects.toThrow("session ended");
    await expect(control.takeOver(page.viewerId)).rejects.toThrow("session ended");
    expect(input).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(200); await closing;
  });
  it("waits for an in-flight input and discards its departed page's queued input", async () => {
    const { control } = setup(); const page = control.openViewer(); const busy = deferred(), started = deferred();
    const active = control.runHuman(async () => { started.resolve(); await busy.promise; }, page.viewerId); await started.promise;
    const old = control.runHuman(async () => { throw Error("must not run"); }, page.viewerId);
    const refused = expect(old).rejects.toThrow("session ended");
    const closing = control.closeViewer(page.viewerId); await vi.advanceTimersByTimeAsync(200);
    expect(control.snapshot().humanPriority).toBe(true);
    busy.resolve(); await Promise.all([active, closing, refused]);
    expect(control.snapshot().humanPriority).toBe(false);
  });
  it("a rapid reopen cancels automatic permission return", async () => {
    const { control } = setup(); const a = control.openViewer(); await control.takeOver();
    const closing = control.closeViewer(a.viewerId); const b = control.openViewer();
    await vi.advanceTimersByTimeAsync(200); await closing;
    expect(control.snapshot().humanPriority).toBe(true);
    const last = control.closeViewer(b.viewerId); await vi.advanceTimersByTimeAsync(200); await last;
    expect(control.snapshot().humanPriority).toBe(false);
  });
  it("a new local takeover during the exit grace period remains latched", async () => {
    const { control } = setup(); const page = control.openViewer(); await control.takeOver();
    const closing = control.closeViewer(page.viewerId); await control.takeOver();
    await vi.advanceTimersByTimeAsync(200); await closing;
    expect(control.snapshot().humanPriority).toBe(true);
  });
  it("a viewer arriving during permission persistence restores the saved human policy", async () => {
    const { control, deps } = setup(); const page = control.openViewer(); await control.takeOver();
    const saving = deferred(), saved = deferred();
    deps.persist.mockImplementation(async value => { if (!value.humanPriority) { saving.resolve(); await saved.promise; } });
    const closing = control.closeViewer(page.viewerId); const rejected = expect(closing).rejects.toThrow("Control changed");
    await vi.advanceTimersByTimeAsync(200); await saving.promise; control.openViewer(); saved.resolve(); await rejected;
    expect(control.snapshot().humanPriority).toBe(true);
    expect(deps.persist).toHaveBeenLastCalledWith({ paused: false, humanPriority: true });
  });
  it("pause during permission persistence cannot be undone by closing a page", async () => {
    const { control, deps } = setup(); const page = control.openViewer(); await control.takeOver();
    const saving = deferred(), saved = deferred();
    deps.persist.mockImplementation(async value => { if (!value.humanPriority) { saving.resolve(); await saved.promise; } });
    const closing = control.closeViewer(page.viewerId); const rejected = expect(closing).rejects.toThrow("Control changed");
    await vi.advanceTimersByTimeAsync(200); await saving.promise; const pause = control.pause(true); saved.resolve(); await Promise.all([pause, rejected]);
    expect(control.snapshot()).toMatchObject({ paused: true, humanPriority: true });
    expect(deps.persist).toHaveBeenLastCalledWith({ paused: true, humanPriority: true });
  });
  it("unknown and repeated close requests never grant permission", async () => {
    const { control } = setup(); const page = control.openViewer(); await control.takeOver();
    await control.closeViewer("not-an-open-page"); expect(control.snapshot().humanPriority).toBe(true);
    await control.pause(true); await control.closeViewer(page.viewerId); await control.pause(false);
    await control.closeViewer(page.viewerId); expect(control.snapshot().humanPriority).toBe(true);
  });
  it("a persistence failure leaves agents blocked", async () => {
    const { control, deps } = setup(); const page = control.openViewer(); await control.takeOver();
    deps.persist.mockRejectedValueOnce(Error("disk full"));
    const closing = control.closeViewer(page.viewerId); const rejected = expect(closing).rejects.toThrow("disk full");
    await vi.advanceTimersByTimeAsync(200); await rejected; expect(control.snapshot().humanPriority).toBe(true);
  });
  it("plugin shutdown cannot auto-grant a pending page exit", async () => {
    const { control, deps } = setup(); const page = control.openViewer(); await control.takeOver();
    const closing = control.closeViewer(page.viewerId); await control.stop();
    await vi.advanceTimersByTimeAsync(200); await closing;
    expect(control.snapshot().humanPriority).toBe(true);
    expect(deps.persist).toHaveBeenLastCalledWith({ paused: false, humanPriority: true });
  });
});

describe("viewer page lifecycle", () => {
  it("does not close until unmount, and closes only once", async () => {
    const api = { open: vi.fn(async () => ({ viewerId: "page" })), close: vi.fn(async () => {}), report: vi.fn() }, update = vi.fn();
    const page = startViewerSession(api, update); await Promise.resolve(); expect(api.close).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith("page", null); await page.close(); await page.close();
    expect(api.close).toHaveBeenCalledExactlyOnceWith({ viewerId: "page" });
  });
  it("a late registration after unmount is still closed without setting React state", async () => {
    const pending = deferred<{ viewerId: string }>(); const update = vi.fn();
    const api = { open: () => pending.promise, close: vi.fn(async () => {}), report: vi.fn() };
    const page = startViewerSession(api, update); const closing = page.close(); pending.resolve({ viewerId: "late" }); await closing;
    expect(api.close).toHaveBeenCalledExactlyOnceWith({ viewerId: "late" }); expect(update).not.toHaveBeenCalled();
  });
  it("independent mounts cannot close each other's registration", async () => {
    const close = vi.fn(async () => {}), report = vi.fn();
    const a = startViewerSession({ open: async () => ({ viewerId: "A" }), close, report }, vi.fn());
    const b = startViewerSession({ open: async () => ({ viewerId: "B" }), close, report }, vi.fn());
    await a.close(); expect(close.mock.calls).toEqual([[{ viewerId: "A" }]]); await b.close();
    expect(close.mock.calls).toEqual([[{ viewerId: "A" }], [{ viewerId: "B" }]]);
  });
  it("registration retries stop after unmount", async () => {
    vi.useFakeTimers();
    const api = { open: vi.fn(async () => { throw Error("offline"); }), close: vi.fn(async () => {}), report: vi.fn() };
    const page = startViewerSession(api, vi.fn()); await Promise.resolve(); await page.close(); await vi.advanceTimersByTimeAsync(3000);
    expect(api.open).toHaveBeenCalledOnce(); expect(api.close).not.toHaveBeenCalled();
  });
  it("a transient registration error can recover without remounting", async () => {
    vi.useFakeTimers();
    const open = vi.fn<() => Promise<{ viewerId: string }>>()
      .mockRejectedValueOnce(Error("offline")).mockResolvedValueOnce({ viewerId: "recovered" });
    const api = { open, close: vi.fn(async () => {}), report: vi.fn() }, update = vi.fn();
    const page = startViewerSession(api, update); await vi.advanceTimersByTimeAsync(2000);
    expect(update).toHaveBeenLastCalledWith("recovered", null); await page.close();
    expect(api.close).toHaveBeenCalledExactlyOnceWith({ viewerId: "recovered" });
  });
  it("a close transport failure is reported and never becomes an allow request", async () => {
    const api = { open: async () => ({ viewerId: "page" }), close: vi.fn(async () => { throw Error("offline"); }), report: vi.fn() };
    const page = startViewerSession(api, vi.fn()); await page.close(); expect(api.report).toHaveBeenCalledOnce();
  });
});
