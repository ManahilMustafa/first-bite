// Proves the gzip/deflate/br transport optimization actually works end to
// end: HttpClient must advertise Accept-Encoding and correctly decompress
// whatever the server sends back, while staying byte-identical to an
// uncompressed response (no regression for servers that ignore the header).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { HttpClient } from '../src/util/httpClient.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function urlFor(server, path = '/') {
  const { port } = server.address();
  return `http://127.0.0.1:${port}${path}`;
}

const BODY = '<html><body>' + 'A'.repeat(5000) + '</body></html>';

test('HttpClient advertises Accept-Encoding and decompresses a gzip response', async () => {
  let sawAcceptEncoding = '';
  const server = await startServer((req, res) => {
    sawAcceptEncoding = req.headers['accept-encoding'] || '';
    const gz = zlib.gzipSync(Buffer.from(BODY, 'utf8'));
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(gz);
  });
  const client = new HttpClient();
  try {
    const res = await client.get(urlFor(server));
    assert.match(sawAcceptEncoding, /gzip/, 'client should request gzip');
    assert.equal(res.status, 200);
    assert.equal(res.body, BODY, 'decompressed body should match the original');
  } finally {
    client.destroy();
    await closeServer(server);
  }
});

test('HttpClient decompresses a deflate response', async () => {
  const server = await startServer((req, res) => {
    const def = zlib.deflateSync(Buffer.from(BODY, 'utf8'));
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'deflate' });
    res.end(def);
  });
  const client = new HttpClient();
  try {
    const res = await client.get(urlFor(server));
    assert.equal(res.body, BODY);
  } finally {
    client.destroy();
    await closeServer(server);
  }
});

test('HttpClient decompresses a brotli response', async () => {
  const server = await startServer((req, res) => {
    const br = zlib.brotliCompressSync(Buffer.from(BODY, 'utf8'));
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'br' });
    res.end(br);
  });
  const client = new HttpClient();
  try {
    const res = await client.get(urlFor(server));
    assert.equal(res.body, BODY);
  } finally {
    client.destroy();
    await closeServer(server);
  }
});

test('HttpClient passes an uncompressed response through unchanged (no content-encoding)', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(BODY);
  });
  const client = new HttpClient();
  try {
    const res = await client.get(urlFor(server));
    assert.equal(res.body, BODY);
  } finally {
    client.destroy();
    await closeServer(server);
  }
});

test('HttpClient rejects cleanly on a malformed compressed body instead of returning garbage', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end('not actually gzip data');
  });
  const client = new HttpClient();
  try {
    await assert.rejects(() => client.get(urlFor(server)), /decompress/i);
  } finally {
    client.destroy();
    await closeServer(server);
  }
});

test('gzip round-trip shrinks a VIEWSTATE-shaped page (sanity check for the real win)', async () => {
  // Not asserting a real portal's ratio — just confirming the plumbing gets
  // real bytes-on-the-wire savings on repetitive markup like the WebForms
  // pages this bot fetches every poll tick.
  const server = await startServer((req, res) => {
    const gz = zlib.gzipSync(Buffer.from(BODY, 'utf8'));
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(gz);
  });
  const client = new HttpClient();
  try {
    const compressedBytes = zlib.gzipSync(Buffer.from(BODY, 'utf8')).length;
    assert.ok(compressedBytes < BODY.length * 0.2, 'fixture itself should compress well (sanity check)');
    const res = await client.get(urlFor(server));
    assert.equal(res.body.length, BODY.length);
  } finally {
    client.destroy();
    await closeServer(server);
  }
});
