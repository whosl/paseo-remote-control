const SOI = Buffer.from([0xff, 0xd8]);
const LIMIT = 16 * 1024 * 1024;

/** Reads JPEG boundaries without mistaking marker-looking bytes in metadata for end-of-image. */
export class MjpegReader {
  private bytes: Buffer = Buffer.alloc(0);
  private offset = 0;
  private scanning = false;

  push(chunk: Buffer): Buffer[] {
    if (this.bytes.length + chunk.length > LIMIT) throw new Error("Native capture frame exceeds its memory limit");
    this.bytes = Buffer.concat([this.bytes, chunk]);
    const frames: Buffer[] = [];
    while (true) {
      if (!this.offset) {
        const start = this.bytes.indexOf(SOI);
        if (start < 0) { this.bytes = this.bytes.subarray(Math.max(0, this.bytes.length - 1)); break; }
        this.bytes = this.bytes.subarray(start);
        this.offset = 2;
      }
      if (this.offset + 1 >= this.bytes.length) break;
      if (this.scanning) {
        const marker = this.bytes.indexOf(0xff, this.offset);
        if (marker < 0) { this.offset = this.bytes.length; break; }
        if (marker + 1 >= this.bytes.length) { this.offset = marker; break; }
        const code = this.bytes[marker + 1]!;
        if (code === 0 || (code >= 0xd0 && code <= 0xd7)) { this.offset = marker + 2; continue; }
        if (code === 0xff) { this.offset = marker + 1; continue; }
        this.offset = marker;
        this.scanning = false;
      }
      const code = this.bytes[this.offset + 1]!;
      if (this.bytes[this.offset] !== 0xff) throw new Error("Invalid native JPEG stream");
      if (code === 0xff) { this.offset++; continue; }
      if (code === 0xd9) {
        frames.push(Buffer.from(this.bytes.subarray(0, this.offset + 2)));
        this.bytes = this.bytes.subarray(this.offset + 2);
        this.offset = 0;
        continue;
      }
      if (this.offset + 3 >= this.bytes.length) break;
      const size = this.bytes.readUInt16BE(this.offset + 2);
      if (size < 2) throw new Error("Invalid native JPEG segment");
      if (this.offset + 2 + size > this.bytes.length) break;
      this.offset += 2 + size;
      if (code === 0xda) this.scanning = true;
    }
    return frames;
  }
}
