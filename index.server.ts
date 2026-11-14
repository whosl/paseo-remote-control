import type { PluginServerContext } from "@getpaseo/plugin/server";
import contributeAgent from "./server/agent/contribute";
import { ControlCoordinator } from "./server/control/coordinator";
import { ControlOverlay } from "./server/control/overlay";
import type { ComputerUseService } from "./server/computer-use-mcp";
import { NiriPort } from "./server/computer-use-mcp/linux/niri-port";
import { NiriIO } from "./server/host/niri-io";
import { WindowsHost } from "./server/host/windows";
import { createWindowsDisplayManager } from "./server/host/windows-display";
import { WindowsPort } from "./server/computer-use-mcp/windows/port";
import contributeScreen from "./server/screen/contribute";
import { NiriHelper } from "./server/screen/niri";
import { readControlPolicy, writeControlPolicy } from "./server/screen/preferences";
import { allowAgentsRpc, ownershipRpc, takeoverRpc } from "./shared/control";
import { displayFallbackRpc } from "./shared/screen/rpc";

export default function contribute(server: PluginServerContext) {
  const io = process.platform === "linux" ? new NiriIO() : null;
  const windows = process.platform === "win32" ? { input: new WindowsHost(), capture: new WindowsHost() } : null;
  let service: ComputerUseService | undefined;
  let screen: ReturnType<typeof contributeScreen> | undefined;
  const report = (error: unknown) => console.error(`[remote-control] ${String(error)}`);
  const control = new ControlCoordinator({
    stopAgent: async () => service?.stopControl(),
    releaseInput: async () => { await screen?.releaseInput(); io?.release(); await windows?.input.request("release"); },
    showNotice: async (state) => { await overlay?.show(state); },
    updateNotice: (state) => overlay?.update(state),
    persist: writeControlPolicy,
  }, { paused: true, humanPriority: true });
  const overlay = io ? new ControlOverlay(() => io.environment(),
    (action) => { void (action === "pause" ? control.pause(true) : control.takeOver()).catch(report); },
    () => { if (control.snapshot().mode === "agent") void control.pause(true).catch(report); }) : windows ? {
      async show(state: import("./shared/control").RemoteControlState) {
        const reply = await windows.input.request("notice", state);
        if (!reply.shown) throw new Error("Windows control notice was not visible");
      },
      update(state: import("./shared/control").RemoteControlState) {
        if (windows.input.connected) void windows.input.request("notice", state).catch(report);
      },
      async stop() {},
    } : null;
  const unsubscribeWindows = windows?.input.onEvent((event) => {
    if (event.event === "control") {
      console.info(`[remote-control] Local ${event.action === "pause" ? "pause" : "takeover"}`);
      void (event.action === "pause" ? control.pause(true) : control.takeOver()).catch(report);
    }
    if (event.event === "notice-lost" && control.snapshot().mode === "agent") void control.pause(true).catch(report);
  });
  const ready = readControlPolicy().then((initial) => control.initialize(initial));
  void ready.catch(report);
  const displayReady = windows ? ready.then(async () => {
    const manager = await createWindowsDisplayManager(windows.capture, control);
    manager.start(); return manager;
  }) : Promise.resolve(undefined);
  void displayReady.catch(report);
  const guardedServer: PluginServerContext = { ...server, handle: (contract, handler) => server.handle(contract, async (input, context) => { await ready; await displayReady; return handler(input, context); }) };
  screen = contributeScreen(guardedServer, control, io ? new NiriHelper(report, io) : undefined, windows ?? undefined, displayReady);
  server.handle(displayFallbackRpc, async ({ action }) => {
    const manager = await displayReady;
    if (!manager) throw new Error("Virtual display fallback is available only on Windows hosts.");
    return manager.action(action);
  });
  const cleanupAgent = contributeAgent(server, {
    ...(io ? { helperPort: new NiriPort(io) } : {}),
    ...(windows ? { helperPort: new WindowsPort(windows.input, windows.capture) } : {}),
    onService: (current) => { service = current; },
    beforeAction: async (action) => { await ready; await control.beforeAgent(action); },
    runAction: (action, signal, run) => control.runAgent(action, signal, run),
    onOwnerChanged: (owner) => { if (owner.callerId === null) control.releaseAgent(); },
    stopControl: async () => { await ready; await control.takeOver(); return { stopped: true }; },
  });
  server.handle(ownershipRpc, async () => { await ready; return control.snapshot(); });
  server.handle(takeoverRpc, async () => { await ready; return control.takeOver(); });
  server.handle(allowAgentsRpc, async () => { await ready; return control.allowAgents(); });
  return async () => {
    await ready.catch(() => {});
    await (await displayReady.catch(() => undefined))?.stop();
    await control.stop();
    await Promise.all([cleanupAgent(), screen?.stop()]);
    await overlay?.stop();
    unsubscribeWindows?.();
    await io?.stop();
  };
}
