import type { PluginServerContext } from "@getpaseo/plugin/server";
import contributeAgent from "./server/agent/contribute";
import { ControlCoordinator } from "./server/control/coordinator";
import { ControlOverlay } from "./server/control/overlay";
import type { ComputerUseService } from "./server/computer-use-mcp";
import { NiriPort } from "./server/computer-use-mcp/linux/niri-port";
import { NiriIO } from "./server/host/niri-io";
import contributeScreen from "./server/screen/contribute";
import { NiriHelper } from "./server/screen/niri";
import { readControlPolicy, writeControlPolicy } from "./server/screen/preferences";
import { allowAgentsRpc, ownershipRpc, takeoverRpc } from "./shared/control";

export default function contribute(server: PluginServerContext) {
  const io = process.platform === "linux" ? new NiriIO() : null;
  let service: ComputerUseService | undefined;
  let screen: ReturnType<typeof contributeScreen> | undefined;
  const report = (error: unknown) => console.error(`[remote-control] ${String(error)}`);
  const control = new ControlCoordinator({
    stopAgent: async () => service?.stopControl(),
    releaseInput: async () => { await screen?.releaseInput(); io?.release(); },
    showNotice: async (state) => { await overlay?.show(state); },
    updateNotice: (state) => overlay?.update(state),
    persist: writeControlPolicy,
  }, { paused: true, humanPriority: true });
  const overlay = io ? new ControlOverlay(() => io.environment(),
    (action) => { void (action === "pause" ? control.pause(true) : control.takeOver()).catch(report); },
    () => { if (control.snapshot().mode === "agent") void control.pause(true).catch(report); }) : null;
  const ready = readControlPolicy().then((initial) => control.initialize(initial));
  void ready.catch(report);
  const guardedServer: PluginServerContext = { ...server, handle: (contract, handler) => server.handle(contract, async (input, context) => { await ready; return handler(input, context); }) };
  screen = contributeScreen(guardedServer, control, io ? new NiriHelper(report, io) : undefined);
  const cleanupAgent = contributeAgent(server, {
    ...(io ? { helperPort: new NiriPort(io) } : {}),
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
    await control.stop();
    await Promise.all([cleanupAgent(), screen?.stop()]);
    await overlay?.stop();
    await io?.stop();
  };
}
