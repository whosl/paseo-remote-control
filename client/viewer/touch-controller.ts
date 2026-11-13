import type { ScreenInputEvent } from "../../shared/screen/rpc";
import { clampPan, followPointer, MAX_ZOOM, toContentDelta, toScreenPoint, type Size, type View2D } from "./geometry.ts";

export type InputMode = "touchscreen" | "trackpad";
export interface TouchPoint { x: number; y: number }
type Point = TouchPoint;
interface Options {
  mode: InputMode; stage: Size; view: View2D; controlling: boolean;
  send(event: ScreenInputEvent): void;
  feedback(): void;
  onView(view: View2D): void;
  onPointer(point: Point): void;
}
type Gesture = { kind: "idle" | "done" }
  | { kind: "tap"; start: Point; view: View2D }
  | { kind: "pan"; start: Point; view: View2D }
  | { kind: "move" | "drag"; last: Point }
  | { kind: "two"; start: Point; last: Point; moved: boolean; distance: number; view: View2D }
  | { kind: "pinch"; distance: number; midpoint: Point; view: View2D };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Shared by native PanResponder and web touch events; physical mouse input remains absolute. */
export class TouchController {
  private gesture: Gesture = { kind: "idle" };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pointer = { x: 0.5, y: 0.5 };
  private dragging = false;
  private lastTap: { at: number; touch: Point; point: Point } | null = null;
  private readonly options: () => Options;
  constructor(options: () => Options) { this.options = options; }

  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private release(): void {
    if (this.dragging) this.options().send({ type: "up", ...this.pointer, button: "left" });
    this.dragging = false;
  }
  cancel(): void { this.clearTimer(); this.release(); this.gesture = { kind: "idle" }; this.lastTap = null; }

  reveal(): void {
    const o = this.options();
    if (o.mode !== "trackpad" || !o.controlling) return;
    const next = followPointer(o.view, o.stage, this.pointer);
    if (next.panX !== o.view.panX || next.panY !== o.view.panY) o.onView(next);
  }

  private click(touch: Point, button: "left" | "right"): void {
    const o = this.options();
    if (!o.controlling) return;
    const point = o.mode === "trackpad" ? this.pointer : toScreenPoint(touch.x, touch.y, o.stage, o.view);
    if (!point) return;
    this.pointer = { ...point }; o.onPointer(this.pointer); o.feedback();
    const previous = this.lastTap;
    if (button === "left" && previous && Date.now() - previous.at < 350 && distance(touch, previous.touch) < 24) {
      this.pointer = { ...previous.point }; o.onPointer(this.pointer);
      o.send({ type: "down", ...this.pointer, button, clickCount: 2 });
      o.send({ type: "up", ...this.pointer, button, clickCount: 2 });
      this.lastTap = null;
    } else {
      o.send({ type: "click", ...point, button });
      this.lastTap = button === "left" ? { at: Date.now(), touch, point: { ...point } } : null;
    }
  }

  start(touches: Point[]): void {
    if (!touches.length) return;
    this.clearTimer();
    const o = this.options();
    if (touches.length >= 2) {
      this.release(); this.lastTap = null;
      const a = touches[0]!, b = touches[1]!, mid = midpoint(a, b);
      this.gesture = o.mode === "trackpad" ? { kind: "two", start: mid, last: mid, moved: false, distance: Math.max(1, distance(a, b)), view: o.view }
        : { kind: "pinch", distance: Math.max(1, distance(a, b)), midpoint: mid, view: o.view };
      return;
    }
    const start = touches[0]!;
    this.gesture = { kind: "tap", start, view: o.view };
    this.timer = setTimeout(() => {
      if (this.gesture.kind !== "tap") return;
      const current = this.options();
      if (current.mode === "trackpad" && current.controlling) {
        this.dragging = true; current.send({ type: "down", ...this.pointer, button: "left" }); current.feedback();
        this.gesture = { kind: "drag", last: start }; this.lastTap = null;
      } else { this.click(start, "right"); this.gesture = { kind: "done" }; }
    }, o.mode === "trackpad" ? 380 : 500);
  }

  move(touches: Point[]): void {
    if (!touches.length) return;
    const o = this.options();
    if (touches.length >= 2) {
      if (this.gesture.kind !== "two" && this.gesture.kind !== "pinch") { this.start(touches); return; }
      const a = touches[0]!, b = touches[1]!, mid = midpoint(a, b);
      let g = this.gesture;
      if (g.kind === "two") {
        const spread = Math.abs(distance(a, b) - g.distance);
        // Lock a two-finger gesture to either pinch or scroll, rather than sending both.
        if (!g.moved && spread > Math.max(10, g.distance * 0.08, distance(mid, g.start) * 1.5)) {
          g = { kind: "pinch", distance: g.distance, midpoint: g.start, view: g.view };
          this.gesture = g;
        } else {
          const moved = g.moved || distance(mid, g.start) > 6;
          if (moved && o.controlling) {
            const base = g.moved ? g.last : g.start;
            const delta = toContentDelta(mid.x - base.x, mid.y - base.y, o.view.rotated);
            o.send({ type: "scroll", ...this.pointer, dx: Math.max(-10000, Math.min(10000, -delta.dx * 2)), dy: Math.max(-10000, Math.min(10000, -delta.dy * 2)) });
          }
          this.gesture = { ...g, last: mid, moved }; return;
        }
      }
      const zoom = Math.min(MAX_ZOOM, Math.max(1, g.view.zoom * distance(a, b) / g.distance));
      const before = toContentDelta(g.midpoint.x - o.stage.width / 2, g.midpoint.y - o.stage.height / 2, g.view.rotated);
      const now = toContentDelta(mid.x - o.stage.width / 2, mid.y - o.stage.height / 2, g.view.rotated);
      o.onView(clampPan({ ...g.view, zoom, panX: now.dx / zoom - (before.dx / g.view.zoom - g.view.panX), panY: now.dy / zoom - (before.dy / g.view.zoom - g.view.panY) }, o.stage));
      return;
    }
    const touch = touches[0]!;
    if (this.gesture.kind === "two" || this.gesture.kind === "pinch") return;
    if (this.gesture.kind === "tap" && distance(touch, this.gesture.start) > 8) {
      this.clearTimer();
      this.gesture = o.mode === "trackpad" ? { kind: "move", last: this.gesture.start } : { kind: "pan", start: this.gesture.start, view: this.gesture.view };
      this.lastTap = null;
    }
    const g = this.gesture;
    if (g.kind === "pan") {
      const delta = toContentDelta(touch.x - g.start.x, touch.y - g.start.y, g.view.rotated);
      o.onView(clampPan({ ...g.view, panX: g.view.panX + delta.dx / g.view.zoom, panY: g.view.panY + delta.dy / g.view.zoom }, o.stage));
    } else if (g.kind === "move" || g.kind === "drag") {
      if (o.controlling) {
        const delta = toContentDelta(touch.x - g.last.x, touch.y - g.last.y, o.view.rotated);
        this.pointer = { x: clamp(this.pointer.x + delta.dx * 1.2 / Math.max(1, o.view.content.width * o.view.zoom)), y: clamp(this.pointer.y + delta.dy * 1.2 / Math.max(1, o.view.content.height * o.view.zoom)) };
        o.onPointer(this.pointer); o.send({ type: "move", ...this.pointer });
        this.reveal();
      }
      this.gesture = { ...g, last: touch };
    }
  }

  end(remaining = 0): void {
    this.clearTimer();
    const g = this.gesture;
    if (g.kind === "tap") this.click(g.start, "left");
    else if (g.kind === "two" && !g.moved) this.click(g.start, "right");
    this.release(); this.gesture = { kind: remaining ? "done" : "idle" };
  }
}
