# Changelog

## 0.2.0

- Add shared Windows desktop input and focused-window visual agent tools.
- Bridge Session 0 services to the configured user's logged-in desktop with limited-token, on-demand tasks.
- Use authenticated local named pipes without exposing a VNC/TCP input listener.
- Add a no-focus native Windows agent notice with takeover and pause controls.
- Render only the intended agent window on a blank display canvas; keep full-desktop viewing for humans.
- Add Unicode input, native target checks, plain-text clipboard preservation and Windows handoff tests.
- Retain lock/UAC/integrity restrictions; no elevation or global Escape hook.

## 0.1.0

- Combine the remote viewer and agent computer-use services in one plugin.
- Share Niri input transport and enforce human/agent control arbitration.
- Add visible ownership, local takeover/pause notice and persistent human priority.
- Keep low-latency capture, WebRTC fallback, touch/trackpad, haptics and cursor-follow.
- Preserve agent restrictions, identity bindings, provider injection and cleanup.
- Add handoff race tests and an opt-in end-to-end MCP/viewer takeover fixture.

Earlier agent changes are recorded in docs/UPSTREAM-COMPUTER-USE-CHANGELOG.md.
