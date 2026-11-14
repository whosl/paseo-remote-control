# Architecture

`index.server.ts` composes an agent service and a viewer in one plugin subprocess.
`server/control/coordinator.ts` owns a generation counter, human-priority latch,
visible-notice gate and shared execution queue. MCP policy calls beforeAgent and
runAgent; viewer input/clipboard calls runHuman. Every queued action rechecks the
generation immediately before running. Actual operations, rather than just their
caller-facing cancellation race, retain their queue slot until cleanup completes.

Takeover and pause synchronously revoke access, abort the agent's active commands,
wait for the execution queue and release held input. Human priority survives plugin
reload and remains after an agent's turn ends. Allowing agents drains human input
and saves the new policy before opening access; a newer takeover wins that race.
Unreadable/corrupt policy preferences fail toward paused human priority.

On Niri both adapters use the same `server/host/niri-io.ts` instance: session
validation, native queries, key symbols, UNIX-only RFB connection and clipboard
transport. There is one WayVNC process, not independent human/agent input servers.
The agent adapter keeps its focus/window/blocked-app checks and fresh screenshots
for verification. It does not blindly use an older cached viewer frame as evidence
that an action succeeded.

Viewer media lives under `server/screen/`: a bounded persistent MJPEG capture pool,
latest-frame hash/base64 cache, changed-frame long polls and optional H.264 WebRTC.
Input does not wait behind capture. Capture rate ceilings are 30/24/15 fps;
unchanged pictures omit payloads. Old screenshot helpers remain for other desktops.
Agent accessibility logic remains in `server/computer-use-mcp/`, independent of
Paseo imports. Root entry points handle SDK wiring and lifecycle cleanup.

`helper/control-overlay.py` provides a GTK layer-shell notice without keyboard
focus. It acknowledges mapping before the first Niri mutation can proceed.
Unexpected notice loss pauses control. `client/ownership.ts` polls the inexpensive
ownership RPC, shared by the sidebar and viewer. The live notice survives hidden
viewer controls. Server guards remain authoritative during polling/network delays.

Human devices share one human-priority group; individual viewer leases are not
implemented. Agent identity comes from the existing persisted MCP-client bindings
where available; a local unbound MCP client is labelled by its caller ID instead.
The local UNIX socket and paired client API are trusted interfaces, not a boundary
against malicious same-user processes. No keys, pasted text or screenshot payloads
are added to the ownership state.

On Windows, `server/host/windows.ts` uses authenticated local named pipes and
on-demand limited-token interactive tasks to bridge a Session 0 daemon to its
configured user's desktop. The input bridge is shared by the viewer and agent;
a separate capture bridge serves human and agent images so input never queues
behind PrintWindow. Cancelling an agent capture relinquishes its queue slot without
waiting for that read-only operation; late images are discarded.
The C# helper provides native focus, hit-target and secure-desktop checks,
Unicode/scan-code input, held-key cleanup and a no-activate WinForms control notice.
Agent captures render only their target window using PrintWindow onto a blank
display canvas. Human captures use GDI for the composited screen. Coordinates
remain physical display-local pixels, with the screenshot's scale explicit.
Windows tool discovery excludes accessibility operations and does not require
the macOS Escape tap. MCP named pipes require the private persisted shim token;
bridge pipes require an independent per-launch nonce before any response is trusted.
Nonce files grant access only to the desktop user's SID and SYSTEM, with inherited
permissions removed. The secret is delivered to the launcher over stdin; task
arguments contain only its path. Same-user processes remain trusted, not isolated.

`server/host/windows-display.ts` coordinates optional physical-first headless fallback.
Presence is queried from the limited interactive helper using QueryDisplayConfig,
not inferred from Session 0, dimensions, or cached EDID. Stable monitor keys bind
JPEG identity and viewer input across DISPLAYn reuse. Unknown classifications stop
automation. Transitions are serialized and absence is debounced; first activation
revokes agent control and configures only a verified VirtualDrivers target.

Driver provisioning is an out-of-band administrator transaction with pinned hashes,
normal Windows signature validation, an owned device manifest and an independent
rollback task. Runtime PnP operations revalidate the exact instance and hardware ID,
and reread provisioning before every change so rollback can revoke cached controllers.
No physical GPU, global topology preset, Secure Boot or signing policy is changed.
Physical reconnection does not tear down the live virtual desktop: explicit human
return verifies physical capture and window migration first. Unmovable windows keep
the virtual display enabled. Plugin teardown deliberately leaves it alive.
