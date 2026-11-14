# Paseo Remote Control

One Paseo plugin for human remote desktop control, agent computer use, and live
supervision. It combines the viewer from paseo-screen with the agent tools from
paseo-computer-use, with a shared input backend and human-priority control authority.

## How it works

- Open **Remote Control** in the host sidebar to view and control your computer.
- Use touchscreen or trackpad mode, pinch to zoom, and let the zoomed trackpad view
  follow the pointer. Local click feedback can be disabled in Screen settings.
- Enable agent tools under **Settings > Remote Control / Agents**. Supported agent
  providers are Claude, Codex and Oh My Pi. New agents receive the `paseo-computer`
  MCP server; existing sessions may need a new agent or an MCP reconnect.
- During agent control, a compact viewer strip shows the agent identity and
  **Take over** without covering the picture, even with the toolbar hidden. On
  Linux/Niri and Windows, a local notice also offers **Take over** and **Pause all**,
  without taking keyboard focus.
- Watching does not claim control. While an agent owns control, viewer input is
  refused at the server, not just disabled visually. Choose **Take over** first.
- Taking over cancels active agent tools, invalidates queued actions, waits for
  actual input cleanup and releases held buttons/keys. Human priority remains
  latched while a Remote Control page remains open. A small toolbar shield indicates
  human priority without a persistent overlay. Leaving the last page automatically
  drains input, releases held keys and returns agent access. **Pause all** remains
  latched and another open page prevents automatic return. A rapid reopen cancels
  the handoff. **Screen settings > Control ownership > Allow agents** remains a
  manual override; an interrupted agent still needs a new turn before retrying.
  Opening settings, changing language or hiding controls never grants access.
  If an exit cannot be confirmed (for example, force-quitting the app or losing the
  connection), the host fails closed and retains human priority; the manual override
  remains available. Merely going into the background does not close the page.
- Your first ordinary viewer input also reserves human control. Multiple paired
  human viewers share this human-priority state; they are not separate exclusive
  per-device leases.

This controls a real computer, not a sandbox. Agents can move focus, type into
apps and affect the user's files. Only install it on computers you own or are
explicitly authorized to administer.

## Language

Remote Control follows the language selected in the presenting Paseo app. Chinese
locales use the Chinese interface; all other languages fall back to English.
Changing the app language updates the viewer, navigation, settings and known status
messages without resetting clipboard drafts, picture quality or control state.
There is no separate plugin language setting. Device/app names, keyboard shortcut
names and unknown backend diagnostics remain unchanged. Native host control notices
are host-side safety UI and currently retain their English labels.

## Compatibility

Requires Paseo daemon and client **0.13 or later**, and Node **22.18 or later** for
the development tests. The installer runs the preparation commands in the manifest.

| Host | Human viewer | Agent tools | Verification |
| --- | --- | --- | --- |
| Linux / Niri | Persistent JPEG, optional direct H.264, touch/trackpad | Focused-window visual tools | Combined live tests on Niri |
| macOS 14+ | Original screen helper | Original accessibility tools and native stop/overlay | Inherited backends; combined path not tested on a Mac |
| Other Linux desktops | Original X11/portal viewer | Not implemented | Combined path not tested |
| Windows 10/11 | GDI JPEG, optional H.264 WebRTC, touch/trackpad | Focused-window visual tools | Combined live tests on a Windows service host |

Mobile/browser UI is React Native-compatible. Android can receive direct H.264
video by reusing the WebView already compiled into Paseo, without an additional
native dependency or APK update. The plugin detects that view at runtime and
falls back to Paseo-carried JPEGs if it is absent, decoding is unsupported, or the
direct connection fails. iOS retains the JPEG path. The production Android video
component has received H.264 from a live Niri host inside a Paseo-based emulator
test app; the user's installed APK and physical phone have not been tested end
to end. Phone feedback depends on
the client and device. The browser viewer has been checked at desktop, phone,
landscape and 320-pixel widths, with light/dark panels.

## Install and migrate

If using the old plugins, disable them before running the merged plugin. Leaving
either old input service active bypasses the merged control authority.

```sh
paseo plugin disable computer-use
paseo plugin disable paseo-screen
```

Then install the merged plugin (or just run this on a fresh host):

```sh
paseo plugin install github:whosl/paseo-remote-control
paseo plugin ls
```

Keep their source directories for rollback. The merged runtime ID is
`remote-control`; the original plugin IDs are not removed. Agent settings are
per-plugin, so review the new settings before enabling agent input. Browser
access remains a separate explicit opt-in.

The MCP key, shim and identity-state directory retain their existing
`paseo-computer` / `paseo-computer-use` names for compatibility with old agent
bindings. Screen preferences are imported once from the old location and written
to the new `paseo-remote-control` preferences. Turning off the agent settings does
not turn off the human viewer.

### Linux / Niri dependencies

Needs an unlocked Niri session, `grim`, `wayvnc`, `wayvncctl`, `wl-copy`, `wl-paste`,
Python 3, GTK 3 / PyGObject, and GtkLayerShell. Publish `NIRI_SOCKET`,
`WAYLAND_DISPLAY`, `XDG_CURRENT_DESKTOP` and `XDG_RUNTIME_DIR` in the systemd user
environment. A missing local notice refuses agent mutations rather than allowing
invisible control. Losing the notice during control pauses both input paths.

On Debian/Ubuntu, install the GTK/GI dependencies using the distribution packages.
If `libgtk-layer-shell0` and the GTK Python bindings already exist but only the
GtkLayerShell typelib is missing, this installs that typelib into a user directory:

```sh
sh scripts/setup-niri-overlay.sh
```

The capture path uses `~/.local/share/paseo-screen/bin/wf-recorder` or the system
`/usr/bin/wf-recorder`, falling back to grim. No persistent VNC TCP listener is
created: Niri input uses one private UNIX-socket WayVNC shared by viewer and agent.

Optional direct video uses the existing local aiortc environment:

```sh
python3 -m venv ~/.local/share/paseo-screen/rtc-venv
~/.local/share/paseo-screen/rtc-venv/bin/pip install -r helper/screen/webrtc-requirements.txt
```

Without it, viewing stays on Paseo-carried JPEGs. WebRTC signalling and all input
stay on Paseo. Direct media is encrypted and attempts LAN/routable VPN connectivity.
Outside-network viewing can use host-configured STUN and authenticated TURN;
without that configuration there is no guaranteed Internet NAT traversal. Failed
video automatically falls back to JPEG.

WebRTC Fast, Balanced and Sharp request up to 1280, 1920 and 2560 pixels wide,
all at up to 30 FPS. The screen encoder starts conservatively at 1 Mbps and probes
upward gradually, with ceilings of 4, 8 and 12 Mbps for 720p, 1080p and 1440p frames.
Probing stops when receiver bandwidth estimates drop or packet loss rises. RTP
packet pacing and a loss-based cap protect slower relay paths. Static desktops naturally use less bandwidth
and fewer newly captured frames; the numbers in picture settings report actual
received video rather than the configured ceiling.

The Android receiver loads a local, receive-only video document inside Paseo's
existing WebView. Signalling and session heartbeats use authenticated plugin RPCs;
touch, keyboard, clipboard and ownership continue through the existing control
coordinator. Playback stops on exit or backgrounding. The connection mode, frame
rate and bandwidth appear under picture settings. Tap the connection mode to
switch to Paseo-only transport or retry WebRTC. No camera or microphone is used.

### STUN and TURN

The host administrator can create `~/.config/paseo-remote-control/webrtc.json`
(or set `PASEO_REMOTE_CONTROL_RTC_CONFIG` to another file). Keep it private with
mode `0600`. For Coturn REST authentication, the file has this shape:

```json
{
  "stunUrls": ["stun:turn.example.com:3478"],
  "turnUrls": [
    "turn:turn.example.com:3478?transport=udp",
    "turn:turn.example.com:3478?transport=tcp",
    "turns:turn.example.com:443?transport=tcp"
  ],
  "hostTurnUrl": "turns:turn.example.com:443?transport=tcp",
  "sharedSecret": "REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS",
  "ttlSeconds": 3600
}
```

Use the same private key as Coturn's `static-auth-secret` with `use-auth-secret`.
The daemon issues individual expiring credentials through an authenticated RPC;
the signing key is never returned to the viewer. Both Android and browser receivers
use that configuration. Direct paths remain enabled. Picture settings identify
**WebRTC direct**, **WebRTC relay**, or **Paseo / JPEG** using the selected ICE pair.

`hostTurnUrl` selects one tested transport for aiortc, which uses a single TURN
endpoint; browsers can gather candidates from all entries in `turnUrls`. TLS
requires a publicly trusted certificate matching the configured hostname or IP.
The TURN server needs its listener ports and its configured UDP relay port range
allowed by both the system and cloud firewall. An HTTP-01 certificate renewal also
needs port 80/TCP. Relay bandwidth and traffic are consumed only when relaying.

## Agent safety and privacy

Agent policy retains the host enable switch, provider approval mode, blocked-app
rules, browser opt-in, focus/lock checks and turn-end cleanup. Niri tools are
visual-coordinate tools, not an accessibility tree. Niri captures cover a whole display;
other visible apps may be included, and blocked apps on that workspace refuse the
capture. Images and tool results reach the agent's configured model provider.
There is no automatic screenshot recording or upload by this plugin.

### Windows hosts

Windows needs .NET Framework 4.x, Windows PowerShell, Task Scheduler and the Paseo
user logged in to an unlocked desktop. The helper is compiled on the host with
the existing Framework C# compiler. JPEG viewing needs no Python or VNC server.
Optional WebRTC uses the same pinned Python media environment as Linux:

```powershell
py -3 -m venv "$env:LOCALAPPDATA\paseo-remote-control\rtc-venv"
& "$env:LOCALAPPDATA\paseo-remote-control\rtc-venv\Scripts\python.exe" -m pip install -r helper/screen/webrtc-requirements.txt
```

Create the environment in the desktop profile used by the daemon. Tested with
Python 3.14 on the Windows service host. The interactive helper streams raw BGRA
pixels over a short-lived, nonce-authenticated loopback socket to the H.264 worker;
no JPEG encode/decode round trip or public capture listener is involved. Each feed
is bound to a stable display identity and geometry, checked around every capture.
Locking, hotplug, capture failure or connection failure ends video and restores
JPEG viewing. Input carries the viewed identity and geometry and continues through
the existing human/agent coordinator. Managed virtual displays support this path.
The same private STUN/TURN configuration supports outside-network viewing.
Changed-frame JPEG long polling is not implemented on Windows.

Windows JPEG viewing targets 30 FPS in Fast, 24 in Balanced and 15 in Sharp,
subject to screen capture time, connection speed and client decoding. Fast and
Balanced use faster bilinear resizing; Sharp retains the detailed resize filter.
At most two frame requests are outstanding, and backgrounding the app stops
polling. The FPS counter counts new pictures, so a static desktop can show zero
while the connection remains healthy.

The on-demand bridge also works when Paseo runs in Session 0 as a service. It
creates temporary `Paseo-Remote-Control-*` tasks with an interactive **limited**
user token, not Highest privileges. It does not restart or move the daemon.
The tasks/helpers are removed on graceful plugin stop. A hard process/OS crash
can leave an orphan task registration; after a restart, idle old registrations
can be removed from Task Scheduler. No logon/startup trigger is registered.

The desktop profile defaults to the daemon's home directory. A SYSTEM service
without the user's profile environment can set `PASEO_RC_WINDOWS_PROFILE` to
that user's profile path. The bridge refuses a different profile unless the
service is SYSTEM, and requires that exact user to have an interactive Explorer
session. It does not choose an arbitrary other logged-in user. Local IPC uses
per-launch bridge nonces and a persistent private MCP token. Bridge secrets are
passed over stdin into files with explicit desktop-user/SYSTEM ACLs, not task XML
or command lines. Protect the Paseo user's profile and plugin state from other accounts.

Agent screenshots use `PrintWindow` to render only the intended window onto a
blank display-sized canvas. They do not capture adjacent applications, while
human viewing still shows the whole desktop. Agent coordinates remain display-local
physical pixels; image scaling is reported. Native input checks the window/app,
foreground focus and pointer hit target before delivery. Some GPU/DRM applications
cannot be rendered this way or return a blank image. Window-only rendering is not
equivalent to the composited human screen and may omit overlays/occlusion.

The native top-right notice offers **Take over** and **Pause all** without taking
keyboard focus. Agent input waits for its visible acknowledgement. The lock screen,
sign-in/UAC secure desktop and higher-integrity applications are not bypassed.
Windows, like Niri, has no global Escape/shake or physical-input auto-takeover hook.

#### Physical-first headless fallback

Windows can expose a low-resolution synthetic desktop when its physical monitor
disconnects. Remote Control can use a separately provisioned, signed VirtualDrivers
virtual display as a 1920 x 1080 fallback. It is an additional monitor in the same
login session, not a separate session or a guarantee of independent human/agent input.

- Physical displays have priority. With a physical monitor available, fallback does
  not activate another screen. Unknown or failed topology queries never mean headless.
- Verified absence is debounced before enabling only the provisioned virtual device.
  Switching reserves human control and releases agent input. Agent access returns
  when the last viewer exits, or via the explicit permission action.
- When a physical display returns, the viewer offers **Switch back** and keeps the
  current virtual picture until you confirm. The physical display must already be
  active in Windows. Window movement and capture are verified before disabling the
  virtual adapter; a window that cannot be moved keeps that screen enabled.
- Turning automation off or reloading the plugin does not remove the only working
  screen. Driver installation/removal is a separate administrator operation, never a
  background download or an action available to an agent through its MCP tools.

The viewer settings expose **Windows headless > Automatic fallback** after an
administrator provisions the driver. See [Windows display setup](docs/WINDOWS-DISPLAY.md)
for the pinned driver, installation transaction, rollback and GPU-update cautions.

Niri has no global physical Escape/shake interception or automatic same-window
human-activity detector. Use the host notice, viewer takeover/pause controls, or
Paseo Stop. macOS retains its native helper's existing stop and overlay behavior.
Human priority prevents future agents from acquiring input until the last viewer
confirms exit or the user explicitly allows agents. Unconfirmed exits fail closed.

This is coordination for trusted plugins/agents, not a security boundary against
code running as the desktop user. Such code can invoke operating-system input tools
or the user's authenticated Paseo API independently of this plugin.

Agent text paste preserves existing plain text when possible. It refuses non-text
clipboard data and does not preserve rich formats or clipboard-manager history.
The human viewer's Paste action intentionally replaces the host text clipboard.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
npm audit
```

`npm test` includes the agent policy/MCP suite, control handoff races, held-input
cleanup, viewer geometry/rotation/cursor-follow, touch gestures, mocked haptic
drivers and changed-frame cache behavior. Mock haptic tests do not verify a motor.

Live tests are opt-in, require an empty Niri workspace and an unlocked session,
open an offline GTK fixture, then restore focus. Do not interact with the desktop
while running them. The full handoff test requires the merged plugin enabled,
agent tools enabled, remote input unpaused and agent access explicitly allowed:

```sh
PASEO_RC_RUN_LIVE=1 \
PASEO_CLI_UTILS=/path/to/installed/cli/dist/utils \
npm run test:handoff
```

It verifies real MCP input, live screen capture, in-flight cancellation, human
input after cleanup, refusal of a second agent and the host takeover button.
It leaves human priority enabled. Fixture images/config backups under `build/`
and `artifacts/` are ignored and must not be committed.

On Windows use the same explicit opt-in and CLI-utils environment with
`npm run test:windows-handoff`. It opens a disposable offline WinForms fixture,
checks real MCP Unicode input, watching, takeover/cancellation, sticky human
priority and the native notice button, then closes the fixture and restores focus.

See [architecture](docs/ARCHITECTURE.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
