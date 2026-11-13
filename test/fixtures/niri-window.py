"""A disposable, offline GTK window for the opt-in Niri integration check."""
import json
import os
import sys
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

GLib.set_prgname("paseo-cu-fixture")
state_path = sys.argv[1]
state = {"clicks": 0, "text": "", "drag_moves": 0, "scroll": 0}
app = Gtk.Application(application_id="io.github.whosl.ComputerUseFixture")


def activate(application):
    win = Gtk.ApplicationWindow(application=application)
    win.set_title("Paseo Computer Use integration fixture")
    win.set_default_size(1000, 700)
    win.set_decorated(False)
    layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
    layout.set_border_width(48)
    win.add(layout)
    heading = Gtk.Label(label="Computer Use · Linux/Niri test window")
    heading.set_markup('<span size="24000" weight="bold">Computer Use · Linux/Niri</span>')
    layout.pack_start(heading, False, False, 0)
    layout.pack_start(Gtk.Label(label="Temporary offline fixture: click, text, shortcuts, drag, scroll and Stop."), False, False, 0)
    entry = Gtk.Entry()
    entry.set_placeholder_text("Type ASCII or 中文 here")
    entry.set_size_request(-1, 60)
    layout.pack_start(entry, False, False, 0)
    button = Gtk.Button(label="Click test: 0")
    button.set_size_request(-1, 60)
    layout.pack_start(button, False, False, 0)
    canvas = Gtk.EventBox()
    drag_label = Gtk.Label(label="Drag test area")
    canvas.add(drag_label)
    canvas.set_size_request(-1, 180)
    canvas.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.POINTER_MOTION_MASK)
    layout.pack_start(canvas, False, False, 0)
    scrolling = Gtk.ScrolledWindow()
    scrolling.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
    rows = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    for i in range(100):
        rows.pack_start(Gtk.Label(label=f"Scroll verification row {i + 1}"), False, False, 4)
    scrolling.add(rows)
    layout.pack_start(scrolling, True, True, 0)
    dragging = {"down": False}

    def snapshot(*_):
        if not win.get_mapped():
            return True
        state["text"] = entry.get_text()
        state["scroll"] = scrolling.get_vadjustment().get_value()
        state["size"] = [win.get_allocated_width(), win.get_allocated_height()]
        state["positions"] = {}
        for name, widget in [("entry", entry), ("button", button), ("canvas", canvas), ("scroll", scrolling)]:
            x, y = widget.translate_coordinates(win, 0, 0)
            state["positions"][name] = [x, y, widget.get_allocated_width(), widget.get_allocated_height()]
        temporary = state_path + ".new"
        with open(temporary, "w", encoding="utf-8") as out:
            json.dump(state, out, ensure_ascii=False)
        os.replace(temporary, state_path)
        return True

    def clicked(_):
        state["clicks"] += 1
        button.set_label(f"Click test: {state['clicks']}")
        snapshot()

    def pointer(_, event):
        if event.type == Gdk.EventType.BUTTON_PRESS:
            dragging["down"] = True
        elif event.type == Gdk.EventType.BUTTON_RELEASE:
            dragging["down"] = False
        elif dragging["down"]:
            state["drag_moves"] += 1
            drag_label.set_label(f"Drag events: {state['drag_moves']}")
        snapshot()
        return True

    button.connect("clicked", clicked)
    entry.connect("changed", snapshot)
    canvas.connect("button-press-event", pointer)
    canvas.connect("button-release-event", pointer)
    canvas.connect("motion-notify-event", pointer)
    GLib.timeout_add(50, snapshot)
    win.show_all()
    win.fullscreen()


app.connect("activate", activate)
app.run([sys.argv[0]])
