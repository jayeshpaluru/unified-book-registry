import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { torrentInfo } from '../server/torrent-metadata.mjs';
test('Torrent inspection hashes the original info dictionary and sums only metadata lengths', () => {
  const info = 'd6:lengthi12e4:name5:a.txt12:piece lengthi16e6:pieces20:12345678901234567890e';
  const torrent = Buffer.from(`d4:info${info}e`);
  const parsed = torrentInfo(torrent);
  assert.equal(parsed.hash, createHash('sha1').update(info).digest('hex'));
  assert.equal(parsed.size, 12); assert.equal(parsed.files[0].name, 'a.txt');
});
