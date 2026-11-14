import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DisplayFallbackStatus, ScreenDisplay } from "../../shared/screen/rpc";
import { readDisplayFallbackPolicy, writeDisplayFallbackEnabled, writePreferredDisplay } from "../screen/preferences";
import type { WindowsHost } from "./windows";

export interface WindowsDisplaySnapshot {
  displays: ScreenDisplay[];
  locked: boolean;
  windowsTopology?: { reliable: boolean; physicalConnected: number; physicalActive: number; error?: string };
}
export interface ManagedDisplayDriver { setEnabled(enabled: boolean): Promise<void> }
interface Dependencies {
  read(): Promise<WindowsDisplaySnapshot>;
  configure(key: string): Promise<void>;
  verify(display: ScreenDisplay): Promise<void>;
  migrate(from: string, to: string): Promise<{ failed: number }>;
  transition<T>(run: (assertCurrent: () => void) => Promise<T>): Promise<T>;
  paused(): boolean;
  saveEnabled(enabled: boolean): Promise<void>;
  select(display: ScreenDisplay): Promise<void>;
  driver: ManagedDisplayDriver | null;
}

/** Only a provisioned, exact driver instance can be changed; installation is deliberately out of band. */
export function managedDriverScript(instance: string, enabled: boolean, file = "C:\\ProgramData\\PaseoRemoteControl\\display-fallback.json", driverInf?: string): string {
  const quoted = `'${instance.replace(/'/g, "''")}'`;
  const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;
  return `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$id=${quoted}
$authorization=${quote(file)}
$lockFile=Join-Path ([IO.Path]::GetDirectoryName($authorization)) 'display-fallback.lock'
$deadline=[DateTime]::UtcNow.AddSeconds(10); $lock=$null
while(!$lock){try{$lock=[IO.File]::Open($lockFile,'OpenOrCreate','ReadWrite','None')}catch [IO.IOException]{if([DateTime]::UtcNow -ge $deadline){throw 'Display transaction lock timed out'};Start-Sleep -Milliseconds 100}}
try{
$policy=[IO.File]::ReadAllText($authorization) | ConvertFrom-Json
if($policy.version -ne 1 -or $policy.owner -ne 'paseo-remote-control' -or $policy.deviceInstance -ine $id -or $policy.state -notin @('installed','committed')){throw 'Display authorization revoked'}
$device=Get-PnpDevice -InstanceId $id -ErrorAction Stop
$hardware=@((Get-PnpDeviceProperty -InstanceId $id -KeyName 'DEVPKEY_Device_HardwareIds' -ErrorAction Stop).Data)
if($device.Class -ne 'Display' -or !($hardware | Where-Object { $_ -ieq 'Root\\MttVDD' -or $_ -ieq 'MttVDD' })){throw 'Refusing to change an unverified virtual display device'}
${driverInf ? `$inf=(Get-PnpDeviceProperty -InstanceId $id -KeyName 'DEVPKEY_Device_DriverInfPath' -ErrorAction Stop).Data
if($inf -ine ${quote(driverInf)} -or $policy.driverInf -ine $inf){throw 'Virtual display driver package changed'}` : ""}
${enabled ? "Enable" : "Disable"}-PnpDevice -InstanceId $id -Confirm:$false -ErrorAction Stop | Out-Null
}finally{$lock.Dispose()}`;
}

export async function readManagedDisplayDriver(file = path.join(process.env.ProgramData || "C:\\ProgramData", "PaseoRemoteControl", "display-fallback.json")): Promise<ManagedDisplayDriver | null> {
  try {
    const config = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    if (config.version !== 1 || config.owner !== "paseo-remote-control" || typeof config.deviceInstance !== "string" || !/^ROOT\\[A-Z0-9_&-]+\\[A-Z0-9_&-]+$/i.test(config.deviceInstance) || !/^oem\d+\.inf$/i.test(config.driverInf ?? "")) return null;
    const instance = config.deviceInstance;
    return { setEnabled: async enabled => {
      const current = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
      if (current.version !== 1 || current.owner !== "paseo-remote-control" || current.deviceInstance !== instance || !["installed", "committed"].includes(current.state)) throw new Error("Virtual display provisioning was revoked or rolled back.");
      return new Promise<void>((resolve, reject) => {
        execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(managedDriverScript(config.deviceInstance, enabled, file, config.driverInf), "utf16le").toString("base64")], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }, error => error ? reject(new Error("Virtual display device change failed; use the administrator rollback script.")) : resolve());
      });
    } };
  } catch { return null; }
}

export class WindowsDisplayManager {
  private enabled: boolean;
  private selectedKey: string | null;
  private state: DisplayFallbackStatus;
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private failed = false;
  private verifiedKey: string | null = null;
  private missingSince: number | null = null;
  constructor(private readonly deps: Dependencies, policy = { enabled: false, selectedKey: null as string | null }) {
    this.enabled = policy.enabled; this.selectedKey = policy.selectedKey;
    this.state = { enabled: this.enabled, provisioned: !!deps.driver, state: "unknown", message: "Checking Windows displays", error: null, physicalConnected: 0, physicalActive: 0, selectedKey: this.selectedKey, returnDisplay: null };
  }
  snapshot(): DisplayFallbackStatus { return { ...this.state }; }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run); this.tail = next.catch(() => {}); return next;
  }
  private change(state: DisplayFallbackStatus["state"], message: string, error: string | null = null) {
    this.state = { ...this.state, enabled: this.enabled, selectedKey: this.selectedKey, state, message, error };
  }
  private async select(display: ScreenDisplay): Promise<void> {
    if (display.stableKey === this.selectedKey) return;
    this.selectedKey = display.stableKey ?? null;
    this.state.selectedKey = this.selectedKey;
    await this.deps.select(display);
  }
  async refresh(): Promise<DisplayFallbackStatus> {
    return this.serial(async () => {
      if (this.stopped) return this.snapshot();
      try { await this.inspect(await this.deps.read()); }
      catch (error) { this.change("error", "Display fallback could not be verified. Check the host, then retry in settings.", String(error)); }
      return this.snapshot();
    });
  }
  private async inspect(current: WindowsDisplaySnapshot): Promise<void> {
    const topology = current.windowsTopology;
    this.state.returnDisplay = null;
    if (!topology?.reliable) {
      this.missingSince = null;
      this.change("unknown", "Display detection is unavailable; no devices will be changed.", topology?.error ?? null); return;
    }
    this.state.physicalConnected = topology.physicalConnected; this.state.physicalActive = topology.physicalActive;
    const physical = current.displays.filter(d => d.kind === "physical");
    const virtual = current.displays.filter(d => d.managedVirtual && d.kind === "virtual");
    const selected = current.displays.find(d => d.stableKey === this.selectedKey);
    if (topology.physicalConnected > 0) {
      this.missingSince = null;
      const target = physical.find(d => d.main) ?? physical[0];
      this.state.returnDisplay = target?.id ?? null;
      if (virtual.length) {
        // Never switch away from a live virtual desktop just because a physical target reappeared.
        if (!selected && target) await this.select(target);
        this.change("return-available", target ? "Physical display reconnected. Switch back when you are ready." : "Physical display detected but not active. Enable it in Windows Display settings before switching back.");
      } else if (target) {
        if (!selected || selected.kind !== "physical") await this.select(target);
        this.change("physical", "Using the physical display. Virtual fallback is on standby.");
      } else this.change("unknown", "A physical display is connected but Windows has not activated it. No devices will be changed.");
      return;
    }
    if (current.displays.some(d => d.kind === "unknown" || (d.kind === "virtual" && !d.managedVirtual))) {
      this.missingSince = null; this.change("unknown", "An unmanaged display is active. Automatic fallback will not change this setup."); return;
    }
    if (virtual.length) {
      this.missingSince = null;
      if (this.failed) { this.change("error", "The virtual display was not verified. Retry by enabling fallback in settings.", this.state.error); return; }
      const candidate = virtual.find(d => d.stableKey === this.selectedKey) ?? virtual[0]!;
      if (this.enabled && candidate.stableKey !== this.verifiedKey) {
        if (current.locked || this.deps.paused()) { this.change("headless", "Unlock and resume before verifying virtual fallback"); return; }
        await this.activate(async check => {
          check(); await this.deps.configure(candidate.stableKey!);
          check(); const latest = await this.deps.read();
          const verified = latest.displays.find(d => d.stableKey === candidate.stableKey);
          if (!verified) throw new Error("Virtual display disappeared during verification");
          await this.deps.verify(verified); check(); this.verifiedKey = verified.stableKey!;
          await this.select(verified);
        });
      }
      if (!selected || !selected.managedVirtual) await this.select(virtual[0]!);
      this.change("virtual", this.enabled ? "Virtual fallback active. Waiting for a physical display." : "Automatic fallback is off. The current virtual screen stays active so you do not lose the desktop."); return;
    }
    if (!this.enabled || !this.deps.driver) {
      this.change(this.enabled ? "headless" : "disabled", this.deps.driver ? "No physical display detected. Automatic fallback is off." : "No physical display detected. An administrator must provision a signed virtual display driver first."); return;
    }
    if (this.failed || current.locked || this.deps.paused()) {
      if (!this.failed) this.change("headless", "No physical display detected. Unlock and resume host control before fallback starts."); return;
    }
    // Debounce hotplug transients; a query failure or an intervening physical target resets the timer.
    this.missingSince ??= Date.now();
    if (Date.now() - this.missingSince < 3000) { this.change("headless", "No physical display detected. Confirming before starting virtual fallback."); return; }
    this.change("starting", "Starting the managed 1920 x 1080 virtual display");
    await this.activate(async check => {
      const latest = await this.deps.read();
      if (!this.headless(latest) || latest.locked || this.deps.paused()) { this.missingSince = null; return; }
      check();
      await this.deps.driver!.setEnabled(true);
      let result: WindowsDisplaySnapshot = latest;
      for (let n = 0; n < 20; n++) {
        if (this.stopped) return;
        await new Promise(resolve => setTimeout(resolve, 400));
        result = await this.deps.read();
        if (result.displays.some(d => d.managedVirtual)) break;
      }
      const display = result.displays.find(d => d.managedVirtual && d.stableKey);
      if (!display) throw new Error("The managed virtual display did not become available. It was not disabled, to avoid losing a working desktop.");
      // A physical monitor can return during device startup. Do not change resolutions in that case.
      check();
      if (this.headless(result) && !result.locked && !this.deps.paused()) await this.deps.configure(display.stableKey!);
      result = await this.deps.read();
      const configured = result.displays.find(d => d.stableKey === display.stableKey);
      if (!configured) throw new Error("Virtual display changed during startup");
      await this.deps.verify(configured);
      check(); this.verifiedKey = configured.stableKey!;
      await this.select(configured);
    });
    await this.inspect(await this.deps.read());
  }
  private headless(current: WindowsDisplaySnapshot): boolean {
    return current.windowsTopology?.reliable === true && current.windowsTopology.physicalConnected === 0 &&
      current.displays.every(d => d.kind === "fallback" || (d.kind === "virtual" && d.managedVirtual));
  }
  private async activate(run: (assertCurrent: () => void) => Promise<void>): Promise<void> {
    try { await this.deps.transition(run); }
    catch (error) { this.failed = true; this.change("error", "Virtual display verification failed. Retry in settings after checking the host.", String(error)); throw error; }
  }
  async choose(id: number): Promise<void> {
    return this.serial(async () => {
      const current = await this.deps.read();
      const display = current.displays.find(d => d.id === id);
      if (!display) throw new Error("Display disconnected. Refresh before choosing another display.");
      await this.select(display); await this.inspect(current);
    });
  }
  async action(action: "enable" | "disable" | "return-physical"): Promise<DisplayFallbackStatus> {
    return this.serial(async () => {
      if (action !== "return-physical") {
        if (action === "enable" && !this.deps.driver) throw new Error("A signed virtual driver must be provisioned by an administrator first.");
        this.enabled = action === "enable"; this.failed = false; this.missingSince = null;
        if (this.enabled) this.verifiedKey = null;
        await this.deps.saveEnabled(this.enabled);
        await this.inspect(await this.deps.read()); return this.snapshot();
      }
      if (!this.deps.driver) throw new Error("No managed virtual display driver is provisioned.");
      await this.deps.transition(async checkCurrent => {
        const current = await this.deps.read();
        const previous = current.displays.find(d => d.stableKey === this.selectedKey);
        if (!current.windowsTopology?.reliable || current.locked || this.deps.paused()) throw new Error("Unlock and resume host control before switching displays.");
        const target = current.displays.find(d => d.kind === "physical" && d.main) ?? current.displays.find(d => d.kind === "physical");
        if (!target?.stableKey || !current.windowsTopology.physicalActive) throw new Error("No active physical display. Activate it in Windows Display settings first; the virtual screen was kept.");
        this.change("starting", "Verifying the physical display before switching back");
        await this.deps.verify(target);
        checkCurrent();
        for (const source of current.displays.filter(d => d.managedVirtual && d.stableKey)) {
          checkCurrent();
          const moved = await this.deps.migrate(source.stableKey!, target.stableKey);
          if (moved.failed) throw new Error("Some windows could not move. The virtual display remains active; move them manually before retrying.");
        }
        // Recheck immediately before disabling our adapter; never disable the last available display.
        const check = await this.deps.read();
        checkCurrent();
        if (check.locked || this.deps.paused() || !check.windowsTopology?.reliable || !check.displays.some(d => d.stableKey === target.stableKey && d.kind === "physical")) throw new Error("The physical display disappeared or control was paused. Virtual fallback was kept.");
        try {
          await this.select(target);
          await this.deps.verify(target);
          checkCurrent();
          await this.deps.driver!.setEnabled(false);
          const result = await this.deps.read();
          const returned = result.displays.find(d => d.stableKey === target.stableKey && d.kind === "physical");
          if (!returned) throw new Error("Physical display verification failed");
          await this.deps.verify(returned);
          await this.select(returned); this.failed = false;
        } catch (error) {
          await this.deps.driver!.setEnabled(true).catch(() => {});
          if (previous) await this.select(previous).catch(() => {});
          throw error;
        }
      });
      await this.inspect(await this.deps.read());
      return this.snapshot();
    });
  }
  start(): void {
    const tick = async () => {
      await this.refresh();
      if (!this.stopped) this.timer = setTimeout(() => { void tick(); }, 3000);
    };
    void tick();
  }
  async stop(): Promise<void> {
    this.stopped = true; if (this.timer) clearTimeout(this.timer);
    await this.tail;
    // Keep a headless desktop alive across plugin reloads. Never tear down the only display here.
  }
}

export async function createWindowsDisplayManager(host: WindowsHost, control: { runDisplayTransition<T>(run: (assertCurrent: () => void) => Promise<T>): Promise<T>; snapshot(): { paused: boolean } }): Promise<WindowsDisplayManager> {
  return new WindowsDisplayManager({
    read: () => host.request("status") as unknown as Promise<WindowsDisplaySnapshot>,
    configure: async stableKey => { await host.request("display-configure-virtual", { stableKey, width: 1920, height: 1080 }); },
    verify: async display => {
      const frame = await host.request("frame", { display: display.id, maxWidth: 320, quality: 0.4 });
      if (!frame.jpeg || (frame.display as ScreenDisplay | undefined)?.stableKey !== display.stableKey) throw new Error("The selected display did not produce a verified frame");
    },
    migrate: (from, to) => host.request("display-migrate-windows", { from, to }),
    transition: run => control.runDisplayTransition(run), paused: () => control.snapshot().paused,
    saveEnabled: writeDisplayFallbackEnabled,
    select: display => writePreferredDisplay(display.id, display.stableKey),
    driver: await readManagedDisplayDriver(),
  }, await readDisplayFallbackPolicy());
}
