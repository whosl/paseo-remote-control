import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { ensureHelperBinary } from "../screen/helper";

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
export const windowsPipePath = (name: string) => `\\\\.\\pipe\\${name}`;

export function parseWindowsBridgeMessage(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function interactiveTaskScript(task: string, binary: string, pipe: string, nonceFile: string, profile = process.env.PASEO_RC_WINDOWS_PROFILE || homedir()): string {
  return `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$profile=Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -eq ${quote(profile)} } | Select-Object -First 1
if(!$profile){throw 'The Paseo desktop user profile was not found'}
$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($current -ne 'S-1-5-18' -and $current -ne $profile.SID){throw 'The desktop profile must match the Paseo user'}
$loggedIn=Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object { $_.SessionId -gt 0 -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $profile.SID }
if(!$loggedIn){throw 'Log in to the configured Paseo user desktop first'}
$user=$profile.SID
$acl=[System.Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @($user,'S-1-5-18')) {
  $rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
$file=[System.IO.File]::Create(${quote(nonceFile)},4096,[System.IO.FileOptions]::None,$acl)
try { $bytes=[System.Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $file.Write($bytes,0,$bytes.Length) } finally { $file.Dispose() }
$a=New-ScheduledTaskAction -Execute ${quote(binary)} -Argument ${quote(`--pipe ${pipe} "${nonceFile}"`)}
$p=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Principal $p -Settings $s | Out-Null
Start-ScheduledTask -TaskName ${quote(task)}`;
}

async function powershell(script: string, input = ""): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }, error => error ? reject(error) : resolve());
    child.stdin?.on("error", () => {}); child.stdin?.end(input);
  });
}

/** A limited-token helper in this user's interactive session, even when Paseo runs in Session 0. */
export class WindowsHost {
  private socket: net.Socket | null = null;
  private server: net.Server | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private sequence = 0;
  private task: string | null = null;
  private authFiles = new Map<string, string>();
  private pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(value: Record<string, unknown>) => void>();

  onEvent(listener: (value: Record<string, unknown>) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get connected(): boolean { return this.socket !== null; }
  private emit(value: Record<string, unknown>): void { for (const listener of this.listeners) listener(value); }
  private fail(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }

  private async start(): Promise<void> {
    if (this.stopped) throw new Error("Windows desktop bridge stopped");
    if (this.socket) return;
    this.starting ??= this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async launch(): Promise<void> {
    const binary = await ensureHelperBinary();
    if (this.stopped) throw new Error("Windows desktop bridge stopped");
    const name = `paseo-rc-${randomBytes(18).toString("hex")}`;
    const nonce = randomBytes(32).toString("hex");
    const task = this.task = `Paseo-Remote-Control-${name}`;
    const nonceFile = path.join(path.dirname(binary), `${name}.auth`);
    this.authFiles.set(task, nonceFile);
    const server = this.server = net.createServer();
    let finish!: () => void; let fail!: (error: Error) => void;
    const connected = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    // Attach a rejection handler before Task Scheduler can fail or time out.
    void connected.catch(() => {});
    const deadline = setTimeout(() => fail(new Error("No interactive Windows desktop connected. Log in as the Paseo user and unlock the PC.")), 25_000);
    server.on("connection", socket => {
      socket.setEncoding("utf8"); let buffer = ""; let authenticated = false;
      const helloTimer = setTimeout(() => socket.destroy(), 3000);
      socket.on("error", () => {});
      socket.on("data", chunk => {
        buffer += chunk;
        if (buffer.length > 48 * 1024 * 1024) { socket.destroy(); return; }
        for (;;) {
          const end = buffer.indexOf("\n"); if (end < 0) break;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          const value = parseWindowsBridgeMessage(line);
          if (!value) { socket.destroy(); return; }
          if (!authenticated) {
            clearTimeout(helloTimer);
            if (value.hello !== nonce || typeof value.sessionId !== "number" || !Number.isSafeInteger(value.sessionId) || value.sessionId <= 0 || this.socket || this.stopped) { socket.destroy(); return; }
            authenticated = true; this.socket = socket; clearTimeout(deadline); finish(); continue;
          }
          if (value.event) { this.emit(value); continue; }
          const item = this.pending.get(Number(value.id));
          if (item) { clearTimeout(item.timer); this.pending.delete(Number(value.id)); if (value.ok) item.resolve(value); else item.reject(new Error(String(value.error ?? "Windows helper refused the operation"))); }
        }
      });
      socket.on("close", () => {
        clearTimeout(helloTimer);
        if (this.socket === socket) {
          this.socket = null; this.fail(new Error("Windows interactive desktop disconnected"));
          if (!this.stopped) this.emit({ event: "notice-lost" });
          void this.cleanupTask(task);
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ path: windowsPipePath(name), readableAll: true, writableAll: true }, () => { server.off("error", reject); resolve(); }); });
      // The secret travels over stdin to an ACL-protected file, never in task XML or process arguments.
      await powershell(interactiveTaskScript(task, binary, name, nonceFile), nonce);
      await connected;
    } catch (error) {
      fail(error as Error); await this.cleanupTask(task); throw error;
    } finally {
      clearTimeout(deadline);
      if (server.listening) server.close(); if (this.server === server) this.server = null;
    }
  }

  async request<T extends Record<string, unknown>>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (command === "release" && !this.socket && !this.starting) return {} as T;
    await this.start();
    if (!this.socket || this.stopped) throw new Error("Windows desktop bridge unavailable");
    return this.send<T>(command, payload);
  }

  private send<T extends Record<string, unknown>>(command: string, payload: Record<string, unknown>, timeout = 15_000): Promise<T> {
    if (!this.socket) return Promise.reject(new Error("Windows desktop bridge unavailable"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.socket?.destroy(); reject(new Error(`Windows helper timed out on ${command}`)); }, timeout);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.socket!.write(JSON.stringify({ ...payload, id, cmd: command }) + "\n");
    });
  }

  private async cleanupTask(task: string): Promise<void> {
    await powershell(`$ErrorActionPreference='SilentlyContinue'; Stop-ScheduledTask -TaskName ${quote(task)}; Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false`).catch(() => {});
    const nonceFile = this.authFiles.get(task);
    if (nonceFile) { await unlink(nonceFile).catch(() => {}); this.authFiles.delete(task); }
    if (this.task === task) this.task = null;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.socket) {
      // Release before EOF, then give the native finally block time to run before terminating its task.
      await this.send("release", {}, 1000).catch(() => {});
      const socket = this.socket;
      if (socket) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { socket.destroy(); resolve(); }, 1000);
        socket.once("close", () => { clearTimeout(timer); resolve(); }); socket.end();
      });
    }
    this.socket = null;
    this.server?.close(); this.fail(new Error("Windows desktop bridge stopped"));
    await this.starting?.catch(() => {});
    if (this.task) await this.cleanupTask(this.task);
    this.listeners.clear();
  }
}
