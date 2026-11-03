// Screenshot decoding. The radio sends only the screen tiles that changed, packed into one QOI image.
// See "Screenshots" in ethos-tools/simulation/radio_remote.md.

/** Decodes a QOI image (https://qoiformat.org) to RGBA. Returns null when the data is malformed. */
export function decodeQoi(data) {
  if (data.length < 22 || data[0] !== 0x71 || data[1] !== 0x6F || data[2] !== 0x69 || data[3] !== 0x66) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(4);
  const height = view.getUint32(8);
  const channels = data[12];
  if (channels !== 3 && channels !== 4) return null;
  const count = width * height;
  if (!count || count > 16_000_000) return null;

  const rgba = new Uint8ClampedArray(count * 4);
  const index = new Uint8Array(256);
  let r = 0, g = 0, b = 0, a = 255, run = 0;
  let p = 14;
  const end = data.length - 8;
  for (let o = 0; o < rgba.length; o += 4) {
    if (run > 0) {
      run--;
    } else {
      if (p >= end) return null;
      const s = data[p++];
      if (s === 0xFE) {
        r = data[p]; g = data[p + 1]; b = data[p + 2];
        p += 3;
      } else if (s === 0xFF) {
        r = data[p]; g = data[p + 1]; b = data[p + 2]; a = data[p + 3];
        p += 4;
      } else {
        const tag = s & 0xC0;
        if (tag === 0x00) {
          const k = s * 4;
          r = index[k]; g = index[k + 1]; b = index[k + 2]; a = index[k + 3];
        } else if (tag === 0x40) {
          r = (r + ((s >> 4) & 3) - 2) & 255;
          g = (g + ((s >> 2) & 3) - 2) & 255;
          b = (b + (s & 3) - 2) & 255;
        } else if (tag === 0x80) {
          const q = data[p++];
          const v = (s & 0x3F) - 32;
          r = (r + v - 8 + ((q >> 4) & 15)) & 255;
          g = (g + v) & 255;
          b = (b + v - 8 + (q & 15)) & 255;
        } else {
          run = s & 0x3F;
        }
      }
      const k = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
      index[k] = r; index[k + 1] = g; index[k + 2] = b; index[k + 3] = a;
    }
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
  }
  return { width, height, rgba };
}

/**
 * SCREENSHOT payload: width (2), height (2), tile size (1), bitmap with one bit per tile
 * (row-major, LSB first), then one QOI image holding the changed tiles stacked vertically.
 *
 * Pastes the changed tiles into `previous` (updated in place) or a new frame.
 * Returns { width, height, rgba, changed, total }, or null when the frame cannot be decoded.
 */
export function decodeTiles(data, previous) {
  if (data.length < 5) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint16(0, true);
  const height = view.getUint16(2, true);
  const tile = data[4];
  if (!tile || !width || !height) return null;
  const tilesX = Math.ceil(width / tile);
  const tilesY = Math.ceil(height / tile);
  const total = tilesX * tilesY;
  const bitmapLength = Math.ceil(total / 8);
  if (data.length < 5 + bitmapLength) return null;

  const changed = [];
  for (let i = 0; i < total; i++) if (data[5 + (i >> 3)] & (1 << (i & 7))) changed.push(i);

  const reuse = previous && previous.width === width && previous.height === height;
  if (changed.length < total && !reuse) return null;
  const frame = reuse ? previous : { width, height, rgba: new Uint8ClampedArray(width * height * 4) };

  if (changed.length) {
    const image = decodeQoi(data.subarray(5 + bitmapLength));
    if (!image || image.width !== tile || image.height !== tile * changed.length) return null;
    const src = image.rgba;
    const dst = frame.rgba;
    changed.forEach((i, n) => {
      const x = (i % tilesX) * tile;
      const y = Math.floor(i / tilesX) * tile;
      const w = Math.min(tile, width - x) * 4;
      for (let row = 0; row < tile && y + row < height; row++) {
        const from = (n * tile + row) * tile * 4;
        dst.set(src.subarray(from, from + w), ((y + row) * width + x) * 4);
      }
    });
  }
  return { ...frame, changed: changed.length, total };
}
