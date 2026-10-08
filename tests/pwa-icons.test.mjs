import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
function decodePng(bytes) {
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), depth = bytes[24], type = bytes[25];
  assert.equal(depth, 8); assert.ok([2, 6].includes(type));
  const channels = type === 6 ? 4 : 3, chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), name = bytes.subarray(offset + 4, offset + 8).toString();
    if (name === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const corner = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter];
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}
test('PWA icon sizes and site links resolve to the new generated artwork at nested Pages paths', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', root), 'utf8'));
  assert.equal(manifest.scope, './'); assert.equal(manifest.start_url, './'); assert.equal(manifest.id, './');
  for (const icon of manifest.icons) {
    const decoded = decodePng(await readFile(new URL(icon.src, root)));
    assert.equal(icon.sizes, `${decoded.width}x${decoded.height}`);
    assert.match(icon.src, /v2\.png$/);
  }
  const html = await readFile(new URL('index.html', root), 'utf8');
  assert.match(html, /registry-favicon-32-v2\.png/); assert.match(html, /registry-apple-touch-v2\.png/);
});
test('Maskable icon is opaque and its white symbol stays inside the standard central safe circle', async () => {
  const { width, height, channels, pixels } = decodePng(await readFile(new URL('icons/registry-maskable-512-v2.png', root)));
  let light = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    if (channels === 4) assert.equal(pixels[i + 3], 255);
    if (pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200) {
      light++; assert.ok(Math.hypot(x - width / 2, y - height / 2) <= width * 0.4 + 2, 'Symbol may be clipped by an install mask');
    }
  }
  assert.ok(light > width * height * 0.1);
});
