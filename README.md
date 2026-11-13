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
- During an agent action, the viewer shows its identity, target app and tool. On
  Linux/Niri, a layer-shell notice on the host also offers **Take over** and
  **Pause all**, without taking keyboard focus.
- Watching does not claim control. While an agent owns control, viewer input is
  refused at the server, not just disabled visually. Choose **Take over** first.
- Taking over cancels active agent tools, invalidates queued actions, waits for
  actual input cleanup and releases held buttons/keys. Human priority remains
  latched, including after plugin reload. **Allow agents** explicitly grants
  access again; an interrupted agent needs a new turn before retrying.
- Your first ordinary viewer input also reserves human control. Multiple paired
  human viewers share this human-priority state; they are not separate exclusive
  per-device leases.

This controls a real computer, not a sandbox. Agents can move focus, type into
apps and affect the user's files. Only install it on computers you own or are
explicitly authorized to administer.

## Compatibility

Requires Paseo daemon and client **0.13 or later**, and Node **22.18 or later** for
the development tests. The installer runs the preparation commands in the manifest.

| Host | Human viewer | Agent tools | Verification |
| --- | --- | --- | --- |
| Linux / Niri | Persistent JPEG, optional direct H.264, touch/trackpad | Focused-window visual tools | Combined live tests on Niri |
| macOS 14+ | Original screen helper | Original accessibility tools and native stop/overlay | Inherited backends; combined path not tested on a Mac |
| Other Linux desktops | Original X11/portal viewer | Not implemented | Combined path not tested |
| Windows | Experimental original viewer | Not implemented | Combined path not tested |

Mobile/browser UI is React Native-compatible. Native iOS/Android retain the JPEG
path. Native phone rendering and vibration motors have not been tested end to
end; feedback depends on the client and device. The browser viewer has been
checked at desktop, phone, landscape and 320-pixel widths, with light/dark panels.

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
stay on Paseo. Direct media is encrypted and attempts LAN/routable VPN connectivity;
there is no configured STUN/TURN service, public screen URL or guaranteed Internet
NAT traversal. Failed direct video automatically falls back to JPEG.

## Agent safety and privacy

Agent policy retains the host enable switch, provider approval mode, blocked-app
rules, browser opt-in, focus/lock checks and turn-end cleanup. Niri tools are
visual-coordinate tools, not an accessibility tree. Captures cover a whole display;
other visible apps may be included, and blocked apps on that workspace refuse the
capture. Images and tool results reach the agent's configured model provider.
There is no automatic screenshot recording or upload by this plugin.

Niri has no global physical Escape/shake interception or automatic same-window
human-activity detector. Use the host notice, viewer takeover/pause controls, or
Paseo Stop. macOS retains its native helper's existing stop and overlay behavior.
Human priority prevents future agents from acquiring input until explicitly allowed.

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

See [architecture](docs/ARCHITECTURE.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
