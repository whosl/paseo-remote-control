# Windows physical-first display fallback

This feature keeps the existing logged-in desktop usable when Windows detects no
physical monitor. A virtual monitor is an extra display in that session, not a
separate login, independent keyboard/mouse, or automatic physical-screen mirror.

## Policy

The limited interactive helper queries live Windows display paths. Connected but
inactive physical monitors prevent automatic activation too. Failed queries,
unidentified displays and unmanaged virtual screens block automation. Cached EDID
and a small resolution are not proof of disconnection. A narrow, verified NVIDIA
forced-without-monitor case is recognized; other ambiguous cases are left alone.

Physical absence is debounced. Activation reserves human control, drains agent
input, enables only the recorded device, and verifies its 1920 x 1080 picture.
An agent must be allowed again explicitly afterwards. A reconnected physical
monitor produces a persistent **Switch back** prompt. The physical display must
already be active in Windows; this feature does not change global display topology
or disable a physical GPU to force activation.

Explicit return verifies physical capture, moves normal windows without changing
focus, selects the physical target and verifies it before disabling the virtual
adapter. Windows that cannot be safely moved, including some minimized/maximized
or elevated windows, keep the virtual screen enabled. Move them manually and retry.
Turning automation off or reloading the plugin leaves the only working screen alive.

## Administrator provisioning

Use native 64-bit Windows PowerShell 5.1 on AMD64 Windows. The plugin does not
download or install a driver. Its current provisioner pins the official
[VirtualDrivers 25.7.23 release](https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/tag/25.7.23).
The archive named `x86` actually contains the AMD64 display driver.

Download and extract these official assets into a temporary staging directory:

- `VirtualDisplayDriver-x86.Driver.Only.zip`, SHA256
  `e24210692b442b39af763536330ce78b423f19342b7a7792c26de3944e418b3a`.
- `VDD.Control.25.7.23.zip`, SHA256
  `a701f2272e9fcf382849b24f913c6dd07597b3b1116525f2e90182f019609154`.

Only `Dependencies/devcon.exe` is used from the second archive. Do not launch VDD
Control or install its audio driver. The provisioner separately pins the exact
INF/DLL/CAT/DevCon file hashes and validates Windows signatures. The VDD signer is
SignPath Foundation, not Microsoft/WHQL; DevCon is Microsoft-signed. An invalid or
policy-blocked signature is a failed installation, not a reason to change boot or
signing policy. The verified signer leaf may be added to LocalMachine
TrustedPublisher for unattended installation; Root trust is never changed.

From this checkout in a dedicated elevated PowerShell process:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-provision-display.ps1 `
  -PackageDirectory C:\staging\VirtualDisplayDriver `
  -DevconPath C:\staging\Dependencies\devcon.exe
```

`-ExecutionPolicy Bypass` applies only to that process, not the machine policy.
Existing VDD installations, staged packages, configuration or earlier transactions
are refused instead of adopted. Provisioning briefly activates the new adapter,
then disables only its exact instance. It publishes an `installed` authorization
file under `%ProgramData%\PaseoRemoteControl` and arms an independent SYSTEM
rollback task **before** driver staging. The task runs after ten minutes or at
startup if the transaction was not explicitly committed. Normal runtime toggles
and rollback share an exclusive file lock and revalidate authorization inside it.

Reload only the plugin, enable **Screen settings > Windows headless > Automatic
fallback**, and verify the live display identity, 1920 x 1080 picture, input,
ownership, and unchanged physical-display configuration. Then explicitly commit:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-provision-display.ps1 -Commit
```

On some headless GPUs, disabling the newly installed VDD leaves a `WinDisc`
desktop with no queryable display paths instead of restoring the old GPU fallback.
The plugin deliberately reports unknown topology and does not guess that this
means no physical monitor. During the unexpired installation transaction, an
administrator who has confirmed the monitor situation can explicitly enable only
the owned adapter for validation, without disarming the watchdog:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-provision-display.ps1 -EnableForValidation
```

Then enable automatic fallback, verify the real picture and input, and commit as
described above. This is an explicit setup/recovery action, not an automatic
exception to the unknown-topology guard. Physical reconnect/disconnect behavior
still needs an actual monitor test on each host.

Commit disarms the transaction watchdog; it does not change a display. Production
fallback still fails safe on unknown topology. No daemon restart or reboot is
performed by these scripts.

## Rollback

First turn automatic fallback off or stop only the plugin so it does not schedule
another transition. With no physical display attached, removing the virtual
monitor can return Windows to its previous low-resolution headless desktop.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-rollback-display.ps1 -PolicyStopped
```

Rollback revokes runtime authorization, removes only the owned device and its
newly added unused driver package, and restores its own registry/publisher changes.
It preserves evidence in `display-fallback-transaction.json` and retains the
watchdog if cleanup is incomplete. It never sweeps Display-class devices or removes
the physical GPU. A failed or rolled-back transaction requires administrator review
before another installation.

The driver project warns of black screens/display-priority changes around major
GPU or chipset upgrades: uninstall VDD before those upgrades. Keep SSH access and
a physical recovery option available. A watchdog cannot recover a kernel hang or
guarantee that Windows never flickers during a display change.
