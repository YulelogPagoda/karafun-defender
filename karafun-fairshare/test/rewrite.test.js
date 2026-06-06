'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteBody, isTextual } = require('../rewrite');

const opts = { upstreamHost: 'www.karafun.com', ourHost: '192.168.1.42:8080' };

test('rewrites absolute https URLs to our origin', () => {
  const out = rewriteBody('fetch("https://www.karafun.com/api/add")', opts);
  assert.equal(out, 'fetch("http://192.168.1.42:8080/api/add")');
});

test('rewrites ws and wss to our ws origin', () => {
  assert.equal(rewriteBody('new WebSocket("wss://www.karafun.com/socket")', opts),
    'new WebSocket("ws://192.168.1.42:8080/socket")');
  assert.equal(rewriteBody('ws://www.karafun.com/x', opts), 'ws://192.168.1.42:8080/x');
});

test('rewrites protocol-relative URLs', () => {
  assert.equal(rewriteBody('src="//www.karafun.com/app.js"', opts),
    'src="//192.168.1.42:8080/app.js"');
});

test('does not touch other hosts', () => {
  const s = 'https://cdn.example.com/x and https://www.karafun.com/y';
  assert.equal(rewriteBody(s, opts),
    'https://cdn.example.com/x and http://192.168.1.42:8080/y');
});

test('no-op when host info is missing', () => {
  assert.equal(rewriteBody('https://www.karafun.com', { ourHost: 'x' }), 'https://www.karafun.com');
  assert.equal(rewriteBody('https://www.karafun.com', { upstreamHost: 'www.karafun.com' }),
    'https://www.karafun.com');
});

test('isTextual recognizes html/js/json/css, rejects images', () => {
  assert.ok(isTextual('text/html; charset=utf-8'));
  assert.ok(isTextual('application/javascript'));
  assert.ok(isTextual('application/json'));
  assert.ok(!isTextual('image/png'));
  assert.ok(!isTextual('font/woff2'));
});
