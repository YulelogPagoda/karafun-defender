'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kf = require('../kfadapter');

test('sniffWeb classifies add / search / queueop / other', () => {
  assert.equal(kf.sniffWeb('POST', '/api/queue/add').kind, 'add');
  assert.equal(kf.sniffWeb('POST', '/enqueue').kind, 'add');
  assert.equal(kf.sniffWeb('GET', '/catalog/search?q=abba').kind, 'search');
  assert.equal(kf.sniffWeb('GET', '/songs?q=queen').kind, 'search');
  assert.equal(kf.sniffWeb('POST', '/queue/move').kind, 'queueop');
  assert.equal(kf.sniffWeb('GET', '/assets/app.js').kind, 'other');
});

test('parseAddRequest reads the song from the query string', () => {
  const r = kf.parseAddRequest('GET', '/api/add?songId=42&title=Bohemian%20Rhapsody', '', null);
  assert.equal(r.songId, '42');
  assert.equal(r.title, 'Bohemian Rhapsody');
});

test('parseAddRequest reads a JSON body', () => {
  const body = Buffer.from(JSON.stringify({ song: { id: 7, title: 'Africa' } }));
  const r = kf.parseAddRequest('POST', '/api/add', 'application/json', body);
  assert.equal(r.songId, '7');
  assert.equal(r.title, 'Africa');
});

test('parseAddRequest reads a urlencoded body', () => {
  const body = Buffer.from('songId=99&name=Mr.%20Brightside');
  const r = kf.parseAddRequest('POST', '/add', 'application/x-www-form-urlencoded', body);
  assert.equal(r.songId, '99');
  assert.equal(r.title, 'Mr. Brightside');
});

test('parseAddRequest returns nulls when nothing recognizable is present', () => {
  const r = kf.parseAddRequest('POST', '/add', 'application/json', Buffer.from('{"foo":"bar"}'));
  assert.equal(r.title, null);
  assert.equal(r.songId, null);
});

test('parseAddRequest tolerates a malformed body without throwing', () => {
  const r = kf.parseAddRequest('POST', '/add', 'application/json', Buffer.from('{not json'));
  assert.deepEqual(r, { title: null, songId: null });
});
