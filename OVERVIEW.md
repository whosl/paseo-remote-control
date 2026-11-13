# Remote Control

View and control a Paseo host yourself, or let a coding agent operate it while you
watch. The viewer supports multiple displays, touchscreen/trackpad input, zoomed
cursor-follow, an on-demand keyboard and clipboard, and local click feedback.

One control authority governs viewer and MCP input. Agent control shows a live
identity/action notice. Take over cancels agent work and queued input, releases
held keys and reserves control for humans until explicitly allowed again. Watching
alone does not claim control. Linux/Niri additionally displays a local layer-shell
notice with takeover and pause buttons; if that notice cannot be shown, agent input
is refused. The agent tools retain application restrictions and browser opt-in.

Paseo 0.13 or later is required. The combined input path is tested on Linux/Niri.
Other viewer platforms and macOS accessibility tools are inherited and not tested
as a combined system. Windows agent tools are not available. Niri requires GTK /
GtkLayerShell, grim, WayVNC, wl-clipboard and an unlocked graphical session. Native
phone haptics depend on device support and are not physically verified.

Viewing uses the existing Paseo connection with optional encrypted direct H.264
video in supported browsers. Direct connections have no configured TURN service;
unreachable video falls back to JPEG. Agent screenshots and tool results reach the
configured model provider. Clipboard paste can replace host text. This controls
real apps and is a trusted-code coordination mechanism, not an operating-system
sandbox. Niri does not have a global physical Escape stop hook.
