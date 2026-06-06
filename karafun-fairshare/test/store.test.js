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

test('identify creates an identity and records plays by id', () => {
  const s = new Store(tmpFile());
  const rec = s.identify({ token: 't1', ip: '10.0.0.1', bfp: 'bf1', name: 'Alice' });
  assert.equal(s.played(rec.id), 0);
  s.recordPlay(rec.id); s.recordPlay(rec.id);
  assert.equal(s.played(rec.id), 2);
  assert.equal(s.get(rec.id).name, 'Alice');
});

test('same token always resolves to the same identity', () => {
  const s = new Store(tmpFile());
  const a = s.identify({ token: 't1', ip: '10.0.0.1', bfp: 'bf1' });
  const b = s.identify({ token: 't1', ip: '10.0.0.9', bfp: 'bfX' }); // ip + bfp changed
  assert.equal(a.id, b.id);
});

test('cleared cookie (new token) still resolves via ip + fingerprint', () => {
  const s = new Store(tmpFile());
  const a = s.identify({ token: 't1', ip: '10.0.0.1', bfp: 'bf1', name: 'Alice' });
  s.recordPlay(a.id); s.recordPlay(a.id);
  // new token, same ip + bfp (the 2-of-3 still match)
  const b = s.identify({ token: 't2-new', ip: '10.0.0.1', bfp: 'bf1' });
  assert.equal(b.id, a.id);
  assert.equal(s.played(b.id), 2); // kept the count
  assert.ok(b.tokens.includes('t1') && b.tokens.includes('t2-new'));
});

test('changed IP still resolves via token (+ fingerprint)', () => {
  const s = new Store(tmpFile());
  const a = s.identify({ token: 't1', ip: '10.0.0.1', bfp: 'bf1' });
  const b = s.identify({ token: 't1', ip: '192.168.5.5', bfp: 'bf1' });
  assert.equal(b.id, a.id);
  assert.ok(b.ips.includes('10.0.0.1') && b.ips.includes('192.168.5.5'));
});

test('changed fingerprint still resolves via token + ip', () => {
  const s = new Store(tmpFile());
  const a = s.identify({ token: 't1', ip: '10.0.0.1', bfp: 'bf1' });
  const b = s.identify({ token: 't1', ip: '10.0.0.1', bfp: 'bf2' });
  assert.equal(b.id, a.id);
});

test('only one weak signal matching does NOT merge (two strangers)', () => {
  const s = new Store(tmpFile());
  const a = s.identify({ token: 't1', ip: '10.0.0.1', bfp: 'bf1' });
  // different person: shares only the IP (e.g., recycled DHCP), token+bfp differ
  const b = s.identify({ token: 't2', ip: '10.0.0.1', bfp: 'bf2' });
  assert.notEqual(b.id, a.id);
});

test('resetStats zeros counts but keeps identities', () => {
  const s = new Store(tmpFile());
  const a = s.identify({ token: 'a', ip: '1.1.1.1', bfp: 'x' });
  const b = s.identify({ token: 'b', ip: '2.2.2.2', bfp: 'y' });
  s.recordPlay(a.id); s.recordPlay(a.id); s.recordPlay(b.id);
  assert.equal(s.resetStats(), 2);
  assert.equal(s.played(a.id), 0);
  assert.equal(s.played(b.id), 0);
  assert.equal(s.get(a.id).name, a.name);
  assert.equal(s.resetStats(), 0);
});

test('persist + load round-trips the multi-signal record', () => {
  const file = tmpFile();
  const s = new Store(file);
  const a = s.identify({ token: 't1', ip: '10.0.0.9', bfp: 'bf9', name: 'Alice' });
  s.recordPlay(a.id);
  s.persist(true);

  const s2 = new Store(file).load();
  assert.equal(s2.played(a.id), 1);
  // resolves the same identity after reload via the persisted signals
  const again = s2.identify({ token: 't2', ip: '10.0.0.9', bfp: 'bf9' });
  assert.equal(again.id, a.id);
  assert.equal(s2.played(again.id), 1);
  fs.unlinkSync(file);
});
