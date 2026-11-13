// Checks the touch viewer's rotate/zoom/pan math in client/geometry.ts. Usage: npm test (Node 22.18+ runs .ts directly).
import assert from "node:assert/strict";
const g = await import(new URL("../client/viewer/geometry.ts", import.meta.url));
const stage = { width: 400, height: 700 };
const aspect = 1728 / 1117;

const flat = g.fitContent(stage, aspect, false);
assert.equal(flat.width, 400);
const turned = g.fitContent(stage, aspect, true);
assert.ok(turned.width > 600 && turned.height <= 400, JSON.stringify(turned));

const base = { content: turned, rotated: true, zoom: 1, panX: 0, panY: 0 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} != ${b}`);
// Center maps to center.
let p = g.toScreenPoint(200, 350, stage, base);
close(p.x, 0.5); close(p.y, 0.5);
// Rotated 90° clockwise: the picture's top-left sits at the stage's top-right.
p = g.toScreenPoint(200 + turned.height / 2 - 1, 350 - turned.width / 2 + 1, stage, base);
close(p.x, 0); close(p.y, 0);
// Bottom of the stage is the picture's right edge.
p = g.toScreenPoint(200, 350 + turned.width / 2 - 1, stage, base);
close(p.x, 1); close(p.y, 0.5);
// Outside the picture: null.
assert.equal(g.toScreenPoint(5, 5, stage, base), null);
// Zoom 2 about the center: a point a quarter-width down the stage is 1/8 into the picture from the center.
p = g.toScreenPoint(200, 350 + turned.width / 4, stage, { ...base, zoom: 2 });
close(p.x, 0.625); close(p.y, 0.5);
// Unrotated with pan: panning the picture right by 100 moves the stage center onto a point left of the picture center.
p = g.toScreenPoint(200, 350, stage, { content: flat, rotated: false, zoom: 2, panX: 100, panY: 0 });
close(p.x, 0.25); close(p.y, 0.5);
// Pan is clamped so the picture keeps covering the stage.
const clamped = g.clampPan({ ...base, zoom: 2, panX: 10000, panY: -10000 }, stage);
assert.ok(clamped.panX < 10000 && clamped.panY > -10000);
for (const rotated of [false, true]) {
  const content = g.fitContent(stage, aspect, rotated);
  let view = { content, rotated, zoom: 3, panX: 0, panY: 0 };
  assert.deepEqual(g.followPointer(view, stage, { x: 0.51, y: 0.51 }), view, "Small cursor moves should not shake the view");
  for (const pointer of [{ x: .9, y: .9 }, { x: 1, y: 1 }, { x: .1, y: .1 }, { x: 0, y: 0 }]) {
    view = g.followPointer(view, stage, pointer);
    assert.deepEqual(g.clampPan(view, stage), view);
    const x = ((pointer.x - .5) * content.width + view.panX) * view.zoom;
    const y = ((pointer.y - .5) * content.height + view.panY) * view.zoom;
    assert.ok(Math.abs(x) <= (rotated ? stage.height : stage.width) / 2 + .01);
    assert.ok(Math.abs(y) <= (rotated ? stage.width : stage.height) / 2 + .01);
  }
  assert.ok(view.panX > 0 && view.panY > 0, "Moving the cursor back left/up should pan the view back");
}
console.log("Geometry and zoomed cursor-follow checks passed (normal and rotated)");
