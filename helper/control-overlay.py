import json
import os
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("GtkLayerShell", "0.1")
from gi.repository import GLib, Gtk, GtkLayerShell, Pango

if not GtkLayerShell.is_supported():
    raise RuntimeError("The compositor does not support layer-shell")


def emit(value):
    print(json.dumps(value), flush=True)


window = Gtk.Window(title="Remote Control - agent activity")
GtkLayerShell.init_for_window(window)
GtkLayerShell.set_namespace(window, "paseo-remote-control")
GtkLayerShell.set_layer(window, GtkLayerShell.Layer.OVERLAY)
GtkLayerShell.set_exclusive_zone(window, -1)
GtkLayerShell.set_keyboard_mode(window, GtkLayerShell.KeyboardMode.NONE)
GtkLayerShell.set_anchor(window, GtkLayerShell.Edge.TOP, True)
GtkLayerShell.set_anchor(window, GtkLayerShell.Edge.RIGHT, True)
GtkLayerShell.set_margin(window, GtkLayerShell.Edge.TOP, 16)
GtkLayerShell.set_margin(window, GtkLayerShell.Edge.RIGHT, 16)
window.set_name("remote-control-notice")
box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=14)
box.set_border_width(12)
window.add(box)
labels = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
title = Gtk.Label(xalign=0)
detail = Gtk.Label(xalign=0)
for label in (title, detail):
    label.set_width_chars(34)
    label.set_max_width_chars(44)
    label.set_ellipsize(Pango.EllipsizeMode.END)
    labels.pack_start(label, False, False, 0)
box.pack_start(labels, True, True, 0)
takeover = Gtk.Button(label="Take over")
takeover.connect("clicked", lambda *_: emit({"action": "takeover"}))
box.pack_start(takeover, False, False, 0)
pause = Gtk.Button(label="Pause all")
pause.connect("clicked", lambda *_: emit({"action": "pause"}))
box.pack_start(pause, False, False, 0)
style = Gtk.CssProvider()
style.load_from_data(b"""
#remote-control-notice { background: #17232c; color: #eef3f7; border: 1px solid #80c5ef; border-radius: 12px; }
#remote-control-notice label { color: #eef3f7; }
#remote-control-notice button { background: #b5def5; color: #11232e; border: none; border-radius: 7px; padding: 8px 12px; text-shadow: none; }
#remote-control-notice button label { color: #11232e; }
""")
Gtk.StyleContext.add_provider_for_screen(window.get_screen(), style, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
buffer = b""
os.set_blocking(sys.stdin.fileno(), False)


def acknowledge(identifier):
    emit({"id": identifier, "shown": window.get_visible()})
    return False


def receive(_source, condition):
    global buffer
    chunk = os.read(sys.stdin.fileno(), 65536)
    if not chunk:
        Gtk.main_quit()
        return False
    buffer += chunk
    if len(buffer) > 131072:
        raise RuntimeError("Control notice input exceeded its limit")
    while b"\n" in buffer:
        line, buffer = buffer.split(b"\n", 1)
        state = json.loads(line)
        if state.get("mode") == "agent":
            title.set_text(state.get("label", "Agent") + " is controlling this computer")
            detail.set_text(" / ".join(filter(None, [state.get("app"), state.get("tool")])) or "You can take over at any time")
            window.show_all()
        else:
            window.hide()
        if "id" in state:
            GLib.timeout_add(80, acknowledge, state["id"])
    return True


GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, receive)
emit({"ready": True})
Gtk.main()
