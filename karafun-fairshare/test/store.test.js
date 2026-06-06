'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Store } = require('../store');

function tmpFile() {
  return path.join(os.tmpdir(), `kf-store-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

test('ensure creates a record and records plays', () => {
  const s = new Store(tmpFile());
  s.ensure('fp1', 'Alice');
  assert.equal(s.played('fp1'), 0);
  s.recordPlay('fp1');
  s.recordPlay('fp1');
  assert.equal(s.played('fp1'), 2);
  assert.equal(s.get('fp1').name, 'Alice');
});

test('ensure updates name and lastIp without touching play count', () => {
  const s = new Store(tmpFile());
  s.ensure('fp1', 'Alice', '10.0.0.5');
  s.recordPlay('fp1');
  s.ensure('fp1', 'Alicia', '10.0.0.6'); // rename + new ip
  assert.equal(s.get('fp1').name, 'Alicia');
  assert.equal(s.get('fp1').lastIp, '10.0.0.6');
  assert.equal(s.played('fp1'), 1); // unchanged
});

test('resetStats zeros all play counts but keeps identities', () => {
  const s = new Store(tmpFile());
  s.ensure('a', 'A'); s.ensure('b', 'B');
  s.recordPlay('a'); s.recordPlay('a'); s.recordPlay('b');
  const n = s.resetStats();
  assert.equal(n, 2); // two people had non-zero counts
  assert.equal(s.played('a'), 0);
  assert.equal(s.played('b'), 0);
  assert.equal(s.get('a').name, 'A'); // identity preserved
  // a second reset reports nobody changed
  assert.equal(s.resetStats(), 0);
});

test('persist + load round-trips through disk', () => {
  const file = tmpFile();
  const s = new Store(file);
  s.ensure('fp1', 'Alice', '10.0.0.9');
  s.recordPlay('fp1');
  s.persist(true);

  const s2 = new Store(file).load();
  assert.equal(s2.played('fp1'), 1);
  assert.equal(s2.get('fp1').name, 'Alice');
  assert.equal(s2.get('fp1').lastIp, '10.0.0.9');
  fs.unlinkSync(file);
});
