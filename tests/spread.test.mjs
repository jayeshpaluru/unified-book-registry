import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpreads, spreadIndexOf, visualOrder, wantsSpread } from '../js/spread.js';

test('wantsSpread: landscape and at least 800 wide', () => {
  assert.equal(wantsSpread(1210, 834), true); // iPad landscape
  assert.equal(wantsSpread(890, 626), true); // unfolded foldable, landscape
  assert.equal(wantsSpread(932, 430), true); // phone landscape is wide enough
  assert.equal(wantsSpread(780, 430), false);
  assert.equal(wantsSpread(834, 1210), false); // portrait
  assert.equal(wantsSpread(626, 890), false);
  assert.equal(wantsSpread(800, 800), false); // square is not landscape
});

test('single pages when spread is off', () => {
  assert.deepEqual(buildSpreads(3, { spread: false, coverSingle: true }), [[0], [1], [2]]);
});

test('spreads pair pages from the start without a cover offset', () => {
  assert.deepEqual(buildSpreads(5, { spread: true, coverSingle: false }), [[0, 1], [2, 3], [4]]);
});

test('cover offset shows page 0 alone, then pairs', () => {
  assert.deepEqual(buildSpreads(6, { spread: true, coverSingle: true }), [[0], [1, 2], [3, 4], [5]]);
  assert.deepEqual(buildSpreads(0, { spread: true, coverSingle: true }), []);
});

test('RTL reverses the visual order within a spread only', () => {
  assert.deepEqual(visualOrder([2, 3], false), [2, 3]);
  assert.deepEqual(visualOrder([2, 3], true), [3, 2]);
  assert.deepEqual(visualOrder([0], true), [0]);
});

test('spreadIndexOf keeps the current page across relayout', () => {
  const portrait = buildSpreads(8, { spread: false, coverSingle: true });
  const landscape = buildSpreads(8, { spread: true, coverSingle: true });
  assert.equal(spreadIndexOf(landscape, 4), 2); // [3,4]
  assert.equal(spreadIndexOf(portrait, 4), 4);
  assert.equal(landscape[spreadIndexOf(landscape, 4)].includes(4), true);
});
