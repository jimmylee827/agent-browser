// Just enough PNG decoding to read a pixel: 8-bit RGB/RGBA, not interlaced —
// what Chrome's captures and the extension's canvas produce.
import { inflateSync } from "node:zlib";

export function decodePng(base64) {
  const buf = Buffer.from(base64, "base64");
  let pos = 8;
  let width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colour = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported PNG");
      channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
      if (!channels) throw new Error(`unsupported PNG colour type ${colour}`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      px[y * stride + x] = (line[x] + pred) & 0xff;
    }
  }
  return {
    width,
    height,
    /** [r, g, b] at a pixel. */
    at(x, y) {
      const i = Math.round(y) * stride + Math.round(x) * channels;
      return [px[i], px[i + 1], px[i + 2]];
    },
  };
}
