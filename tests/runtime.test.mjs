import test from 'node:test';
import assert from 'node:assert/strict';
import { download, DownloadError } from '../dist/esm/index.js';

test('documented workflow produces required outputs', async () => {
  let stored = new Uint8Array();
  let checkpoint;
  const hashes = {
    create() {
      let sum = 0;
      return {
        update(bytes) {
          for (const byte of bytes) sum += byte;
        },
        digest() {
          return String(sum);
        },
      };
    },
  };
  const result = await download(
    {
      async request() {
        return {
          status: 200,
          headers: { etag: '"v1"', 'content-length': '3' },
          body: (async function* () {
            yield Uint8Array.of(1, 2, 3);
          })(),
        };
      },
    },
    {
      async size() {
        return stored.length;
      },
      async read(offset, length) {
        return stored.slice(offset, offset + length);
      },
      async append(bytes) {
        stored = Uint8Array.from([...stored, ...bytes]);
      },
      async truncate(size) {
        stored = stored.slice(0, size);
      },
    },
    {
      async load() {
        return checkpoint;
      },
      async save(value) {
        checkpoint = value;
      },
      async clear() {
        checkpoint = undefined;
      },
    },
    hashes,
    { url: 'https://example.test/file', maxBytes: 3, expectedDigest: '6' },
  );
  assert.equal(result.size, 3);
  assert.deepEqual([...stored], [1, 2, 3]);
});
function harness(cp, initial = []) {
  let data = Uint8Array.from(initial);
  let checkpoint = cp;
  return {
    storage: {
      async size() {
        return data.length;
      },
      async read(o, n) {
        return data.slice(o, o + n);
      },
      async append(b) {
        data = Uint8Array.from([...data, ...b]);
      },
      async truncate(n) {
        data = data.slice(0, n);
      },
    },
    checkpoints: {
      async load() {
        return checkpoint;
      },
      async save(c) {
        checkpoint = c;
      },
      async clear() {
        checkpoint = undefined;
      },
    },
    hashes: {
      create() {
        let sum = 0;
        return {
          update(b) {
            for (const x of b) sum += x;
          },
          digest() {
            return String(sum);
          },
        };
      },
    },
    data: () => [...data],
  };
}
test('resume validates prefix and content range', async () => {
  const h = harness({ url: 'u', etag: '"v"', offset: 1, prefixDigest: '1' }, [1]);
  const r = await download(
    {
      async request(req) {
        assert.equal(req.offset, 1);
        return {
          status: 206,
          headers: { etag: '"v"', 'content-range': 'bytes 1-2/3' },
          body: (async function* () {
            yield Uint8Array.of(2, 3);
          })(),
        };
      },
    },
    h.storage,
    h.checkpoints,
    h.hashes,
    { url: 'u' },
  );
  assert.equal(r.resumed, true);
  assert.deepEqual(h.data(), [1, 2, 3]);
});
test('server ignoring range rejects', async () => {
  const h = harness({ url: 'u', etag: '"v"', offset: 1, prefixDigest: '1' }, [1]);
  await assert.rejects(
    download(
      {
        async request() {
          return {
            status: 200,
            headers: { etag: '"v"', 'content-length': '2' },
            body: (async function* () {})(),
          };
        },
      },
      h.storage,
      h.checkpoints,
      h.hashes,
      { url: 'u' },
    ),
    { code: 'invalid-response' },
  );
});
test('integrity mismatch resets storage', async () => {
  const h = harness();
  await assert.rejects(
    download(
      {
        async request() {
          return {
            status: 200,
            headers: { etag: '"v"', 'content-length': '1' },
            body: (async function* () {
              yield Uint8Array.of(1);
            })(),
          };
        },
      },
      h.storage,
      h.checkpoints,
      h.hashes,
      { url: 'u', expectedDigest: 'bad' },
    ),
    { code: 'integrity-failure' },
  );
  assert.deepEqual(h.data(), []);
});
test('stale storage without checkpoint is truncated', async () => {
  const h = harness(undefined, [9]);
  await download(
    {
      async request() {
        return {
          status: 200,
          headers: { etag: '"v"', 'content-length': '1' },
          body: (async function* () {
            yield Uint8Array.of(1);
          })(),
        };
      },
    },
    h.storage,
    h.checkpoints,
    h.hashes,
    { url: 'u' },
  );
  assert.deepEqual(h.data(), [1]);
});
