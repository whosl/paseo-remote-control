import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WindowsDisplayManager, managedDriverScript, readManagedDisplayDriver, type WindowsDisplaySnapshot } from "../server/host/windows-display";
import type { ScreenDisplay } from "../shared/screen/rpc";
import { ControlCoordinator } from "../server/control/coordinator";

const screen = (id: number, kind: ScreenDisplay["kind"], main = true): ScreenDisplay => ({ id, kind, main, builtin: false, name: `${kind} ${id}`, x: 0, y: 0, width: 1920, height: 1080, pixelWidth: 1920, pixelHeight: 1080, stableKey: `${kind}-${id}`, managedVirtual: kind === "virtual" });
const physical = screen(1, "physical"), virtual = screen(2, "virtual"), fallback = screen(1, "fallback");
function fixture(options: { enabled?: boolean; driver?: boolean; selectedKey?: string | null } = {}) {
  let current: WindowsDisplaySnapshot = { locked: false, displays: [fallback], windowsTopology: { reliable: true, physicalConnected: 0, physicalActive: 0 } };
  const driver = { setEnabled: vi.fn(async (enabled: boolean) => { current.displays = enabled ? [...current.displays.filter(d => d.kind !== "fallback"), virtual] : current.displays.filter(d => !d.managedVirtual); }) };
  const deps = {
    read: vi.fn(async () => current),
    configure: vi.fn(async () => {}), verify: vi.fn(async (_display: ScreenDisplay) => {}), migrate: vi.fn(async () => ({ failed: 0 })),
    takeOver: vi.fn(async () => {}), paused: vi.fn(() => false),
    saveEnabled: vi.fn(async () => {}), select: vi.fn(async (_d: ScreenDisplay) => {}),
    driver: options.driver === false ? null : driver,
    transition: async <T>(run: (check: () => void) => Promise<T>): Promise<T> => {
      await deps.takeOver();
      return run(() => { if (deps.paused()) throw new Error("Display transition cancelled"); });
    },
  };
  const manager = new WindowsDisplayManager(deps, { enabled: options.enabled ?? true, selectedKey: options.selectedKey ?? null });
  return { manager, deps, driver, get current() { return current; }, set current(value) { current = value; } };
}
async function startFallback(f: ReturnType<typeof fixture>) {
  await f.manager.refresh(); vi.advanceTimersByTime(3100);
  const done = f.manager.refresh(); await vi.advanceTimersByTimeAsync(500); return done;
}
afterEach(() => vi.useRealTimers());

describe("Physical-first Windows display fallback", () => {
  it("selects the active physical display without enabling a driver", async () => {
    const f = fixture(); f.current = { locked: false, displays: [physical], windowsTopology: { reliable: true, physicalConnected: 1, physicalActive: 1 } };
    expect((await f.manager.refresh()).state).toBe("physical");
    expect(f.deps.select).toHaveBeenCalledWith(physical); expect(f.driver.setEnabled).not.toHaveBeenCalled();
  });
  it("debounces headless detection, takes human control, enables and configures only managed virtual", async () => {
    vi.useFakeTimers(); const f = fixture();
    const state = await startFallback(f);
    expect(state.state).toBe("virtual"); expect(state.selectedKey).toBe(virtual.stableKey);
    expect(f.deps.takeOver).toHaveBeenCalledOnce(); expect(f.driver.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.deps.configure).toHaveBeenCalledExactlyOnceWith(virtual.stableKey);
  });
  it("a transient physical target resets the headless debounce", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.manager.refresh(); vi.advanceTimersByTime(2000);
    f.current.windowsTopology!.physicalConnected = 1; await f.manager.refresh();
    f.current.windowsTopology!.physicalConnected = 0; vi.advanceTimersByTime(3000); await f.manager.refresh();
    expect(f.driver.setEnabled).not.toHaveBeenCalled();
  });
  it("never treats a failed topology query as a disconnected monitor", async () => {
    vi.useFakeTimers(); const f = fixture(); f.current.windowsTopology = { reliable: false, physicalConnected: 0, physicalActive: 0, error: "access denied" };
    await f.manager.refresh(); vi.advanceTimersByTime(10000); expect((await f.manager.refresh()).state).toBe("unknown");
    expect(f.driver.setEnabled).not.toHaveBeenCalled();
  });
  it.each(["unknown", "virtual"] as const)("does not override an unmanaged %s display", async kind => {
    vi.useFakeTimers(); const f = fixture(); f.current.displays = [{ ...screen(3, kind), managedVirtual: false }];
    await f.manager.refresh(); vi.advanceTimersByTime(10000); await f.manager.refresh(); expect(f.driver.setEnabled).not.toHaveBeenCalled();
  });
  it("refuses automatic changes while locked or paused", async () => {
    vi.useFakeTimers(); const f = fixture(); f.current.locked = true; await startFallback(f);
    f.current.locked = false; f.deps.paused.mockReturnValue(true); await startFallback(f);
    expect(f.driver.setEnabled).not.toHaveBeenCalled();
  });
  it("does not install or enable a driver that was not provisioned", async () => {
    const f = fixture({ driver: false }); expect((await f.manager.refresh()).state).toBe("headless");
    await expect(f.manager.action("enable")).rejects.toThrow("administrator");
  });
  it("does not silently switch away or disable fallback on physical reconnection", async () => {
    const f = fixture({ selectedKey: virtual.stableKey }); f.current = { locked: false, displays: [virtual, physical], windowsTopology: { reliable: true, physicalConnected: 1, physicalActive: 1 } };
    const state = await f.manager.refresh(); expect(state.state).toBe("return-available"); expect(state.selectedKey).toBe(virtual.stableKey);
    expect(state.returnDisplay).toBe(physical.id); expect(f.driver.setEnabled).not.toHaveBeenCalled(); expect(f.deps.select).not.toHaveBeenCalled();
  });
  it("only explicit return takes over, migrates windows, and disables the owned virtual adapter", async () => {
    const f = fixture({ selectedKey: virtual.stableKey }); f.current = { locked: false, displays: [virtual, physical], windowsTopology: { reliable: true, physicalConnected: 1, physicalActive: 1 } };
    const state = await f.manager.action("return-physical");
    expect(state.state).toBe("physical"); expect(f.deps.takeOver).toHaveBeenCalledOnce();
    expect(f.deps.migrate).toHaveBeenCalledWith(virtual.stableKey, physical.stableKey); expect(f.driver.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("keeps virtual display if physical is connected but not active", async () => {
    const f = fixture(); f.current.windowsTopology!.physicalConnected = 1; f.current.displays = [virtual];
    await expect(f.manager.action("return-physical")).rejects.toThrow("No active physical"); expect(f.driver.setEnabled).not.toHaveBeenCalled();
  });
  it("keeps virtual display when window migration fails", async () => {
    const f = fixture(); f.current = { locked: false, displays: [virtual, physical], windowsTopology: { reliable: true, physicalConnected: 1, physicalActive: 1 } };
    f.deps.migrate.mockResolvedValue({ failed: 1 }); await expect(f.manager.action("return-physical")).rejects.toThrow("could not move");
    expect(f.driver.setEnabled).not.toHaveBeenCalled();
  });
  it("re-enables virtual display if physical verification fails after disable", async () => {
    const f = fixture(); f.current = { locked: false, displays: [virtual, physical], windowsTopology: { reliable: true, physicalConnected: 1, physicalActive: 1 } };
    f.driver.setEnabled.mockImplementation(async enabled => { if (!enabled) f.current.displays = []; });
    await expect(f.manager.action("return-physical")).rejects.toThrow("verification failed");
    expect(f.driver.setEnabled.mock.calls).toEqual([[false], [true]]);
  });
  it("turning automation off never removes the only working screen", async () => {
    const f = fixture(); f.current.displays = [virtual]; const state = await f.manager.action("disable");
    expect(state.enabled).toBe(false); expect(state.state).toBe("virtual"); expect(f.driver.setEnabled).not.toHaveBeenCalled();
  });
  it("does not retry device failures in a background loop", async () => {
    vi.useFakeTimers(); const f = fixture(); f.driver.setEnabled.mockRejectedValue(new Error("driver error"));
    expect((await startFallback(f)).state).toBe("error"); vi.advanceTimersByTime(10000); await f.manager.refresh();
    expect(f.driver.setEnabled).toHaveBeenCalledOnce();
  });
  it("keeps failed capture verification latched until an explicit retry", async () => {
    vi.useFakeTimers(); const f = fixture(); f.deps.verify.mockRejectedValueOnce(new Error("capture failed"));
    expect((await startFallback(f)).state).toBe("error");
    expect((await f.manager.refresh()).state).toBe("error");
    expect(f.deps.verify).toHaveBeenCalledOnce();
    expect((await f.manager.action("enable")).state).toBe("virtual"); expect(f.deps.verify).toHaveBeenCalledTimes(2);
  });
  it("recovers from a transient detection error without requiring a settings toggle", async () => {
    vi.useFakeTimers(); const f = fixture(); f.deps.read.mockRejectedValueOnce(new Error("bridge starting"));
    expect((await f.manager.refresh()).state).toBe("error"); expect((await startFallback(f)).state).toBe("virtual");
  });
  it("rechecks unmanaged displays after taking human control and before enabling", async () => {
    vi.useFakeTimers(); const f = fixture(); f.deps.takeOver.mockImplementation(async () => { f.current.displays = [{ ...virtual, managedVirtual: false }]; });
    expect((await startFallback(f)).state).toBe("unknown"); expect(f.driver.setEnabled).not.toHaveBeenCalled();
  });
  it("pause during physical verification stops migration and device removal", async () => {
    const f = fixture(); f.current = { locked: false, displays: [virtual, physical], windowsTopology: { reliable: true, physicalConnected: 1, physicalActive: 1 } };
    f.deps.verify.mockImplementation(async () => { f.deps.paused.mockReturnValue(true); });
    await expect(f.manager.action("return-physical")).rejects.toThrow("cancelled"); expect(f.deps.migrate).not.toHaveBeenCalled(); expect(f.driver.setEnabled).not.toHaveBeenCalled();
  });
  it("selects and verifies the physical capture target before disabling virtual", async () => {
    const f = fixture({ selectedKey: virtual.stableKey }); f.current = { locked: false, displays: [virtual, physical], windowsTopology: { reliable: true, physicalConnected: 1, physicalActive: 1 } };
    await f.manager.action("return-physical");
    expect(f.deps.select.mock.invocationCallOrder[0]).toBeLessThan(f.driver.setEnabled.mock.invocationCallOrder[0]!);
    expect(f.deps.verify.mock.invocationCallOrder[1]).toBeLessThan(f.driver.setEnabled.mock.invocationCallOrder[0]!);
  });
  it("rollback after a physical disconnect never recursively acquires its coordinator lease", async () => {
    const f = fixture({ selectedKey: virtual.stableKey });
    f.current = { locked: false, displays: [virtual, physical], windowsTopology: { reliable: true, physicalConnected: 1, physicalActive: 1 } };
    const control = new ControlCoordinator({ stopAgent: async () => {}, releaseInput: async () => {}, showNotice: async () => {}, updateNotice: () => {}, persist: async () => {} });
    const manager = new WindowsDisplayManager({ ...f.deps, transition: run => control.runDisplayTransition(run) }, { enabled: true, selectedKey: virtual.stableKey! });
    f.driver.setEnabled.mockImplementation(async enabled => {
      f.current = { locked: false, displays: enabled ? [virtual] : [], windowsTopology: { reliable: true, physicalConnected: 0, physicalActive: 0 } };
    });
    await expect(manager.action("return-physical")).rejects.toThrow("verification failed");
    await control.pause(true); expect(control.snapshot().paused).toBe(true);
    expect(f.driver.setEnabled.mock.calls).toEqual([[false], [true]]);
  });
  it("plugin shutdown never disables the headless screen", async () => {
    const f = fixture(); await f.manager.stop(); await f.manager.refresh(); expect(f.deps.read).not.toHaveBeenCalled(); expect(f.driver.setEnabled).not.toHaveBeenCalled();
  });
});

describe("Managed driver ownership", () => {
  it("validates exact hardware identity before changing only the provisioned instance", () => {
    const script = managedDriverScript("ROOT\\DISPLAY\\0002", false);
    expect(script).toContain("Root\\MttVDD"); expect(script).toContain("-ieq 'MttVDD'");
    expect(script).toContain("Disable-PnpDevice -InstanceId $id"); expect(script).not.toContain("NVIDIA");
    expect(script).toContain("display-fallback.lock"); expect(script).toContain("$lock.Dispose()");
    expect(script).not.toContain("-Class Display | Disable");
  });
  it("refuses missing or invalid provisioning", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rc-display-")), file = path.join(dir, "config.json");
    try {
      expect(await readManagedDisplayDriver(file)).toBeNull();
      await writeFile(file, JSON.stringify({ version: 1, owner: "paseo-remote-control", deviceInstance: "PCI\\GPU\\0000" }));
      expect(await readManagedDisplayDriver(file)).toBeNull();
      await writeFile(file, JSON.stringify({ version: 1, owner: "paseo-remote-control", deviceInstance: "ROOT\\DISPLAY\\0002", driverInf: "oem99.inf" }));
      expect(await readManagedDisplayDriver(file)).not.toBeNull();
      const driver = (await readManagedDisplayDriver(file))!;
      await writeFile(file, JSON.stringify({ version: 1, owner: "paseo-remote-control", deviceInstance: "ROOT\\DISPLAY\\0002", driverInf: "oem99.inf", state: "aborted" }));
      await expect(driver.setEnabled(true)).rejects.toThrow("revoked");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
