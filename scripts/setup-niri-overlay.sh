#!/bin/sh
set -eu
root="${XDG_DATA_HOME:-$HOME/.local/share}/paseo-remote-control/overlay"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
mkdir -p "$root"
cd "$scratch"
apt-get download gir1.2-gtklayershell-0.1
for package in ./*.deb; do dpkg-deb -x "$package" "$root"; done
printf 'Installed local GtkLayerShell typelib under %s (no sudo).\n' "$root"
