'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { order, standingFor } = require('../fairshare');

// Helper: build a played-count lookup from a plain object.
const played = (counts) => (fp) => counts[fp] || 0;
// Helper: pull just the ids out of an ordering for terse assertions.
const ids = (arr) => arr.map((e) => e.id);

test('empty queue returns empty array', () => {
  assert.deepEqual(order([], played({}), 1.0), []);
});

test('single singer keeps FIFO order', () => {
  const pending = [
    { id: 1, fp: 'a', seq: 1, title: 's1', singerName: 'A' },
    { id: 2, fp: 'a', seq: 2, title: 's2', singerName: 'A' },
    { id: 3, fp: 'a', seq: 3, title: 's3', singerName: 'A' },
  ];
  assert.deepEqual(ids(order(pending, played({}), 1.0)), [1, 2, 3]);
});

test('lower lifetime play count goes first', () => {
  const pending = [
    { id: 1, fp: 'a', seq: 1, title: 'sa', singerName: 'A' },
    { id: 2, fp: 'b', seq: 2, title: 'sb', singerName: 'B' },
  ];
  // A has sung 5 times, B has sung 0 -> B should jump ahead despite later seq.
  assert.deepEqual(ids(order(pending, played({ a: 5, b: 0 }), 1.0)), [2, 1]);
});

test('weight penalizes a singer stacking multiple songs', () => {
  // A and B both at 0 plays. A adds two, B adds one in between.
  // Expected fair-share: A, B, A  (A's 2nd song self-throttles behind B).
  const pending = [
    { id: 1, fp: 'a', seq: 1, title: 'a1', singerName: 'A' },
    { id: 2, fp: 'a', seq: 2, title: 'a2', singerName: 'A' },
    { id: 3, fp: 'b', seq: 3, title: 'b1', singerName: 'B' },
  ];
  assert.deepEqual(ids(order(pending, played({}), 1.0)), [1, 3, 2]);
});

test('weight=0 disables the stacking penalty (pure FIFO among equals)', () => {
  const pending = [
    { id: 1, fp: 'a', seq: 1, title: 'a1', singerName: 'A' },
    { id: 2, fp: 'a', seq: 2, title: 'a2', singerName: 'A' },
    { id: 3, fp: 'b', seq: 3, title: 'b1', singerName: 'B' },
  ];
  // With no penalty and equal plays, only seq breaks ties -> original order.
  assert.deepEqual(ids(order(pending, played({}), 0)), [1, 2, 3]);
});

test('seq breaks ties FIFO across singers', () => {
  const pending = [
    { id: 10, fp: 'b', seq: 2, title: 'b', singerName: 'B' },
    { id: 11, fp: 'a', seq: 1, title: 'a', singerName: 'A' },
  ];
  // Equal scores (both 0 plays, 0 ahead) -> earlier seq (a) first.
  assert.deepEqual(ids(order(pending, played({}), 1.0)), [11, 10]);
});

test('does not mutate the input array', () => {
  const pending = [
    { id: 1, fp: 'a', seq: 1, title: 'a', singerName: 'A' },
    { id: 2, fp: 'b', seq: 2, title: 'b', singerName: 'B' },
  ];
  const before = ids(pending);
  order(pending, played({ a: 9 }), 1.0);
  assert.deepEqual(ids(pending), before);
});

test('a late single-song singer interleaves ahead of a stacker', () => {
  // Two singers at 0 plays; A stacks three, C adds one (latest seq).
  const pending = [
    { id: 1, fp: 'a', seq: 1, title: 'a1', singerName: 'A' },
    { id: 2, fp: 'a', seq: 2, title: 'a2', singerName: 'A' },
    { id: 3, fp: 'a', seq: 3, title: 'a3', singerName: 'A' },
    { id: 4, fp: 'c', seq: 4, title: 'c1', singerName: 'C' },
  ];
  // weight=1: a1=0 (tie, earliest seq) first; then c1=0 beats a2=1; then a2, a3.
  assert.deepEqual(ids(order(pending, played({}), 1.0)), [1, 4, 2, 3]);
});

test('standingFor reports 1-based position and songs ahead', () => {
  const pending = [
    { id: 1, fp: 'a', seq: 1, title: 'a', singerName: 'A' },
    { id: 2, fp: 'b', seq: 2, title: 'b', singerName: 'B' },
  ];
  const s = standingFor(pending, played({ a: 3 }), 1.0, 1);
  assert.deepEqual(s, { position: 2, ahead: 1, total: 2 });
  assert.equal(standingFor(pending, played({}), 1.0, 999), null);
});
