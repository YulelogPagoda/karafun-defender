'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Correlator } = require('../correlate');

test('matches a queue entry to the nearest-in-time add', () => {
  const c = new Correlator({ windowMs: 5000 });
  c.recordAdd('alice', 1000);
  c.recordAdd('bob', 2000);
  // entry appears at 2100 -> closest is bob (2000), not alice (1000)
  assert.equal(c.attachEntry('e1', 2100), 'bob');
});

test('matched adds are consumed so a second entry takes the other', () => {
  const c = new Correlator({ windowMs: 5000 });
  c.recordAdd('alice', 1000);
  c.recordAdd('bob', 1200);
  assert.equal(c.attachEntry('e1', 1100), 'alice'); // closest to 1100
  assert.equal(c.attachEntry('e2', 1100), 'bob');   // alice taken -> bob
});

test('returns null when no add is within the window', () => {
  const c = new Correlator({ windowMs: 3000 });
  c.recordAdd('alice', 1000);
  assert.equal(c.attachEntry('e1', 9000), null);
});

test('attachEntry is idempotent for a given entryId', () => {
  const c = new Correlator({ windowMs: 5000 });
  c.recordAdd('alice', 1000);
  c.recordAdd('bob', 1000);
  const first = c.attachEntry('e1', 1000);
  assert.equal(c.attachEntry('e1', 1000), first); // same binding, doesn't consume bob
  assert.equal(c.fpForEntry('e1'), first);
  // bob still available for a different entry
  assert.equal(c.attachEntry('e2', 1000), first === 'alice' ? 'bob' : 'alice');
});

test('prunes adds older than retention', () => {
  const c = new Correlator({ windowMs: 5000, retentionMs: 10000 });
  c.recordAdd('alice', 1000);
  c.recordAdd('bob', 20000); // recording at 20000 prunes alice (older than 10s)
  assert.equal(c.pendingAdds(), 1);
  assert.equal(c.attachEntry('e1', 1000), null); // alice gone
});

test('forget drops a binding', () => {
  const c = new Correlator({ windowMs: 5000 });
  c.recordAdd('alice', 1000);
  c.attachEntry('e1', 1000);
  c.forget('e1');
  assert.equal(c.fpForEntry('e1'), null);
});
