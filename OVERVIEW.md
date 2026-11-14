# Remote Control

View and control a Paseo host yourself, or let a coding agent operate it while you
watch. The viewer supports multiple displays, touchscreen/trackpad input, zoomed
cursor-follow, an on-demand keyboard and clipboard, and local click feedback.

One control authority governs viewer and MCP input. Agent control shows a live
identity/action notice. Take over cancels agent work and queued input, releases
held keys and reserves control for humans until the last viewer exits or explicitly
allows agents again. A paused host remains paused; unconfirmed exits fail closed. Watching
alone does not claim control. Linux/Niri and Windows additionally display a local
notice with takeover and pause buttons; if that notice cannot be shown, agent input
is refused. The agent tools retain application restrictions and browser opt-in.

Paseo 0.13 or later is required. The combined input path is tested on Linux/Niri and Windows.
Other viewer platforms and macOS accessibility tools are inherited and not tested
as a combined system. Windows uses focused-window visual tools, requires an unlocked
logged-in desktop, .NET Framework, PowerShell and Task Scheduler, and can bridge a
Session 0 daemon using temporary limited-token tasks. Agent captures render only
the target window; some GPU apps may return blank. Human viewing uses full-desktop
JPEGs. UAC/lock screens and elevated application input are not bypassed. Niri requires GTK /
GtkLayerShell, grim, WayVNC, wl-clipboard and an unlocked graphical session. Native
phone haptics depend on device support and are not physically verified.

Windows optionally supports physical-first headless fallback after an administrator
separately provisions a signed virtual display driver. When physical displays
disconnect, a virtual 1080p screen can keep the same desktop usable. Reconnection
offers an explicit switch back rather than silently changing the viewed screen.
Display changes reserve human control. Unknown monitor states do not trigger
automatic changes, and disabling automation keeps the only working screen alive.

Viewing uses the existing Paseo connection with optional encrypted direct H.264
video in supported browsers and Android clients that include Paseo's WebView.
Android reuses that installed component; unavailable or failed video falls back
to JPEG. iOS uses JPEG. A host administrator can configure STUN and authenticated
TURN for outside-network viewing. Direct paths are preferred, and the picture
settings distinguish direct and relayed video. Without a reachable path, viewing
falls back to JPEG. Agent screenshots and tool results reach the
configured model provider. Clipboard paste can replace host text. This controls
real apps and is a trusted-code coordination mechanism, not an operating-system
sandbox. Niri and Windows do not have a global physical Escape stop hook.
