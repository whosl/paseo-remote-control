import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { MjpegReader } = await import(new URL("../server/screen/mjpeg.ts", import.meta.url));
// Metadata may contain FFD9; only an EOI outside a length-delimited segment ends a JPEG.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 6, 1, 0xff, 0xd9, 2, 0xff, 0xda, 0, 2, 10, 0xff, 0, 2, 0xff, 0xd0, 3, 0xff, 0xd9]);
for (const size of [1, 2, 3, 7, 1024]) {
  const reader = new MjpegReader();
  const stream = Buffer.concat([Buffer.from("recorder diagnostic\n"), jpeg, jpeg]);
  const frames = [];
  for (let offset = 0; offset < stream.length; offset += size) frames.push(...reader.push(stream.subarray(offset, offset + size)));
  assert.deepEqual(frames, [jpeg, jpeg]);
}
assert.throws(() => new MjpegReader().push(Buffer.alloc(17 * 1024 * 1024)), /memory limit/);
if (process.argv[2]) {
  const frames = new MjpegReader().push(await readFile(process.argv[2]));
  assert.ok(frames.length > 2);
  for (const frame of frames) { assert.equal(frame.readUInt16BE(), 0xffd8); assert.equal(frame.readUInt16BE(frame.length - 2), 0xffd9); }
  console.log(`Real native stream: ${frames.length} JPEGs parsed`);
}
console.log("MJPEG split-marker, metadata, multi-frame and memory-limit checks passed");
