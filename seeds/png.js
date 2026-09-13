'use strict';

const zlib = require('zlib');

/**
 * A tiny PNG encoder, used only by the seed script so development data has
 * real image files (avatars, headers, photo Tweets) without shipping any
 * third-party assets.
 */

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number]} shader
 */
function encodePng(width, height, shader) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = shader(x, y);
      raw[offset] = r & 255;
      raw[offset + 1] = g & 255;
      raw[offset + 2] = b & 255;
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** A soft diagonal gradient with a subtle grid, good enough to look real. */
function gradient(width, height, from, to) {
  return encodePng(width, height, (x, y) => {
    const t = (x / width) * 0.65 + (y / height) * 0.35;
    const base = mix(from, to, t);
    const grid = (x % 64 === 0 || y % 64 === 0) ? 10 : 0;
    return [base[0] + grid, base[1] + grid, base[2] + grid];
  });
}

/** A flat avatar tile with an initial-shaped block, so faces are distinct. */
function avatar(size, color, seed) {
  const light = mix(color, [255, 255, 255], 0.55);
  return encodePng(size, size, (x, y) => {
    const cx = size / 2;
    const cy = size * 0.38;
    const head = Math.hypot(x - cx, y - cy) < size * 0.17;
    const shoulders = y > size * 0.62 && Math.abs(x - cx) < size * (0.17 + (y - size * 0.62) / size);
    const speck = ((x * 7 + y * 13 + seed * 31) % 97) < 3 ? 6 : 0;
    if (head || shoulders) return [light[0] + speck, light[1] + speck, light[2] + speck];
    return [color[0] + speck, color[1] + speck, color[2] + speck];
  });
}

/**
 * The default-avatar placeholder: a plain egg on a flat blue ground.
 *
 * Drawn here rather than copied from anywhere. The outline is an ellipse
 * whose half-width is modulated by a linear taper - sqrt(1 - u^2) gives the
 * ellipse, (1 - k*u) narrows the top and fattens the bottom - which is the
 * usual way to get an egg without hand-plotting a curve. The edge is
 * feathered across one pixel so it does not read as a staircase at 48px.
 */
function egg(size, ground = [91, 155, 201], shell = [247, 249, 250]) {
  const top = size * 0.13;
  const bottom = size * 0.88;
  const height = bottom - top;
  const cx = size / 2;
  const widest = size * 0.275;
  const taper = 0.16;

  return encodePng(size, size, (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;
    if (py < top || py > bottom) return ground;
    // u runs +1 at the narrow top to -1 at the broad bottom.
    const u = 1 - (2 * (py - top)) / height;
    const halfWidth = widest * Math.sqrt(Math.max(0, 1 - u * u)) * (1 - taper * u);
    const over = Math.abs(px - cx) - halfWidth;
    if (over <= -0.5) return shell;
    if (over >= 0.5) return ground;
    return mix(shell, ground, over + 0.5);
  });
}

module.exports = { encodePng, gradient, avatar, egg, mix };
