# @lp-labs/download-manager

Validated adapter-driven HTTP range downloads with resumable prefix integrity.

Original independent MIT TypeScript implementation with **zero runtime/peer dependencies**. ESM and CommonJS with separate declarations, Node 18+ (browser use when adapters/APIs are available). Development dependencies are not consumer runtime dependencies.

## Install

```sh
npm install @lp-labs/download-manager
```

## Complete example

```js
import assert from 'node:assert/strict';
import { download, DownloadError } from '@lp-labs/download-manager';
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
```

CommonJS exposes the same API: `const api = require('@lp-labs/download-manager')`.

## Scope, customization and performance

Storage/checkpoint adapters must exclusively own object and preserve write ordering. Hash factory digest() MUST be a nonfinalizing snapshot (can update afterward); use cryptographic hash externally, example sum is illustrative only. Resume requires strong quoted ETag and exact 206 Content-Range. Partial ranges persist checkpoint then reject incomplete-response; call again to continue. Checkpoints after every chunk; uncheckpointed storage tail truncated on retry. No checkpoint means truncate old storage before download. Complete-checkpoint 416 response is unsupported: clear/restart explicitly if remote completed but clear failed. No auto network retry. maxBytes defaults safe integer maximum; set finite product limit. Adapter controls body buffering and cancellation. Integrity mismatch resets data/checkpoint.

Configure explicit limits, clocks, policies and adapters through the API below. Error classes and standard TypeError/RangeError reject malformed input; adapter/handler errors propagate. Await asynchronous methods and handle rejection in your application; no success-shaped fallback on failed work. Inputs must be trusted ordinary data, not hostile proxies; adapters must meet documented atomicity, isolation and ownership contracts. This package never publishes data, loads external code or starts background services at import time.

## API reference

The complete exported TypeScript contract (including option defaults discussed above, method return shapes, and error codes) is included below. TypeScript users import interfaces using `import type`; JavaScript users pass matching ordinary objects. Signature optionals indicate intentionally optional fields, not silent recovery.

```ts
export interface Digest {
  update(bytes: Uint8Array): void;
  digest(): string;
}
export interface HashFactory {
  create(): Digest;
}
export interface DownloadCheckpoint {
  readonly url: string;
  readonly etag: string;
  readonly offset: number;
  readonly prefixDigest: string;
}
export interface DownloadCheckpointStore {
  load(): Promise<DownloadCheckpoint | undefined>;
  save(checkpoint: DownloadCheckpoint): Promise<void>;
  clear(): Promise<void>;
}
export interface DownloadStorage {
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
  append(bytes: Uint8Array): Promise<void>;
  truncate(size: number): Promise<void>;
}
export interface RangeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
}
export interface RangeRequestAdapter {
  request(
    request: Readonly<{
      url: string;
      offset: number;
      ifRange?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<RangeResponse>;
}
export interface DownloadOptions {
  readonly url: string;
  readonly maxBytes?: number;
  readonly hashChunkBytes?: number;
  readonly signal?: AbortSignal;
  readonly expectedDigest?: string;
  readonly onProgress?: (
    progress: Readonly<{
      received: number;
      total: number;
    }>,
  ) => void;
}
export interface DownloadResult {
  readonly url: string;
  readonly etag: string;
  readonly size: number;
  readonly digest: string;
  readonly resumed: boolean;
}
export declare class DownloadError extends Error {
  readonly code:
    | 'invalid-response'
    | 'identity-changed'
    | 'integrity-failure'
    | 'size-limit'
    | 'incomplete-response';
  constructor(code: DownloadError['code'], message: string, options?: ErrorOptions);
}
export declare function download(
  requestAdapter: RangeRequestAdapter,
  storage: DownloadStorage,
  checkpoints: DownloadCheckpointStore,
  hashes: HashFactory,
  options: DownloadOptions,
): Promise<DownloadResult>;
```

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
