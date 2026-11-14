import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createHeldTracker } from "./held";
import { HelperProcess, linuxBackend, NO_SESSION } from "./helper";
import type { NiriHelper } from "./niri";
import type { ControlCoordinator } from "../control/coordinator";
import type { WindowsDisplayManager } from "../host/windows-display";
import { readPreferredDisplay, writePreferredDisplay } from "./preferences";
import { readVideoIceConfiguration } from "./video-config";
import { chooseDisplayRpc, clipboardRpc, controlStateRpc, setControlPausedRpc, frameRpc, inputRpc, releaseInputRpc, requestPermissionsRpc, statusRpc, videoConfigRpc, videoOfferRpc, videoPingRpc, videoStopRpc, type ScreenStatus } from "../../shared/screen/rpc";

type ScreenHelper = Pick<HelperProcess, "request" | "stop">;
export default function contribute(server: PluginServerContext, control: ControlCoordinator, niri?: NiriHelper, helpers?: { capture: ScreenHelper; input: ScreenHelper }, displayManager?: Promise<WindowsDisplayManager | undefined>) {
  const log = (message: string) => console.error(`[paseo-screen] ${message}`);
  // Separate processes so clicks and keys never queue behind a frame capture. On Wayland each
  // process would need its own portal session and approval, so one helper serves both and answers
  // frames on a thread of their own.
  const capture = helpers?.capture ?? new HelperProcess(log, niri);
  const input = helpers?.input ?? new HelperProcess(log, niri);
  const inputHelper = async () => (process.platform === "linux" && (await linuxBackend()) === "wayland" ? capture : input);

  async function readStatus(command: "status" | "request"): Promise<ScreenStatus> {
    const failed = { platform: process.platform, screenRecording: false, accessibility: false, locked: false, displays: [], preferredDisplay: null };
    const unsupported = await unsupportedReason();
    if (unsupported) return { ...failed, supported: false, error: unsupported };
    try {
      const status = await capture.request<
        Pick<ScreenStatus, "screenRecording" | "accessibility" | "locked" | "displays" | "backend" | "captureMode" | "webrtc" | "frameWait" | "awaitingApproval" | "permissionError"> & {
          activeDisplay?: number;
          windowsTopology?: ScreenStatus["windowsTopology"];
        }
      >(command);
      let preferred = await readPreferredDisplay();
      const connected = (id: number | null) => status.displays.some((display) => display.id === id);
      // With no choice saved yet, start where the focused window is (Linux helpers report it), and save
      // that, so the viewer does not follow focus around afterwards.
      if (preferred === null && status.activeDisplay !== undefined && connected(status.activeDisplay)) {
        preferred = status.activeDisplay;
        await writePreferredDisplay(preferred).catch(() => undefined);
      }
      return {
        supported: true,
        error: null,
        platform: process.platform,
        screenRecording: status.screenRecording,
        accessibility: status.accessibility,
        locked: status.locked,
        displays: status.displays,
        preferredDisplay: connected(preferred) ? preferred : null,
        // Wayland hosts: approval happens in the desktop's own dialog, which may still be open.
        ...(status.backend ? { backend: status.backend } : {}),
        ...(status.captureMode ? { captureMode: status.captureMode } : {}),
        ...(status.webrtc !== undefined ? { webrtc: status.webrtc } : {}),
        ...(status.frameWait !== undefined ? { frameWait: status.frameWait } : {}),
        ...(status.awaitingApproval !== undefined ? { awaitingApproval: status.awaitingApproval } : {}),
        ...(status.permissionError ? { permissionError: status.permissionError } : {}),
        ...(status.windowsTopology ? { windowsTopology: status.windowsTopology, displayFallback: (await displayManager)?.snapshot() } : {}),
      };
    } catch (error) {
      return { ...failed, supported: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  server.handle(statusRpc, () => readStatus("status"));
  server.handle(requestPermissionsRpc, () => readStatus("request"));
  server.handle(frameRpc, (request) => capture.request("frame", request));
  server.handle(videoConfigRpc, () => readVideoIceConfiguration());
  server.handle(videoOfferRpc, (request) => capture.request("rtc-offer", request));
  server.handle(videoPingRpc, (request) => capture.request("rtc-ping", request));
  server.handle(videoStopRpc, (request) => capture.request("rtc-stop", request));
  /** Refuses remote input and clipboard access while control is paused on the host. */
  async function assertControlAllowed(): Promise<void> {
    if (control.snapshot().paused || control.snapshot().mode === "agent") throw new Error("Take over remote control before using the clipboard.");
  }
  const held = createHeldTracker();
  let lastDisplay: number | undefined;
  let point = { x: 0.5, y: 0.5 };
  async function releaseInput(): Promise<void> {
    const events = held.releases(point);
    try {
      if (process.platform === "win32") {
        if (events.length) await input.request("release");
      } else if (events.length) await (await inputHelper()).request("input", { display: lastDisplay, events });
    } finally { held.clear(); }
  }
  server.handle(releaseInputRpc, async () => {
    await control.releaseHumanInput(releaseInput);
    return {};
  });
  server.handle(inputRpc, async (request) => {
    if ((await displayManager)?.snapshot().state === "starting") throw new Error("Display is switching. Wait for a fresh frame before sending input.");
    return control.runHuman(async () => {
      lastDisplay = request.display;
      for (const event of request.events) if ("x" in event && typeof event.x === "number" && "y" in event && typeof event.y === "number") point = { x: event.x, y: event.y };
      held.beforeSend(request.events);
      const result = await (await inputHelper()).request<{ handled: number; pointerDisplay?: number }>("input", request);
      held.confirmed(request.events);
      return result;
    }, request.viewerId);
  });
  // Read on the input helper so it runs after any copy shortcut queued before it.
  server.handle(clipboardRpc, async ({ viewerId }) => {
    await assertControlAllowed();
    return control.runHuman(async () => (await inputHelper()).request("clipboard"), viewerId);
  });
  server.handle(controlStateRpc, () => ({ paused: control.snapshot().paused }));
  server.handle(setControlPausedRpc, async ({ paused }) => {
    await control.pause(paused);
    return { paused: control.snapshot().paused };
  });
  server.handle(chooseDisplayRpc, async ({ display }) => {
    const manager = await displayManager;
    if (manager) await manager.choose(display);
    else await writePreferredDisplay(display);
    return {};
  });

  return {
    releaseInput,
    async stop(): Promise<void> { await Promise.all([capture.stop(), input.stop()]); },
  };
}

/** Why this host cannot share its screen, or null when it can. */
async function unsupportedReason(): Promise<string | null> {
  // Windows support is experimental: tested on one PC so far.
  if (process.platform === "darwin" || process.platform === "win32") return null;
  if (process.platform !== "linux") return "Screen sharing is only available on macOS, Linux and Windows hosts.";
  // X11 sessions are read directly; Wayland sessions go through the desktop portals.
  if (await linuxBackend()) return null;
  return NO_SESSION;
}
