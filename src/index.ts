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
    request: Readonly<{ url: string; offset: number; ifRange?: string; signal?: AbortSignal }>,
  ): Promise<RangeResponse>;
}

export interface DownloadOptions {
  readonly url: string;
  readonly maxBytes?: number;
  readonly hashChunkBytes?: number;
  readonly signal?: AbortSignal;
  readonly expectedDigest?: string;
  readonly onProgress?: (progress: Readonly<{ received: number; total: number }>) => void;
}

export interface DownloadResult {
  readonly url: string;
  readonly etag: string;
  readonly size: number;
  readonly digest: string;
  readonly resumed: boolean;
}

export class DownloadError extends Error {
  readonly code:
    | 'invalid-response'
    | 'identity-changed'
    | 'integrity-failure'
    | 'size-limit'
    | 'incomplete-response';

  constructor(code: DownloadError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DownloadError';
    this.code = code;
  }
}

function safeSize(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  return value;
}

function header(response: RangeResponse, name: string): string | undefined {
  const key = Object.keys(response.headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : response.headers[key];
}

function strongEtag(value: string | undefined): string {
  if (!value || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) || value.length > 4096)
    throw new DownloadError('invalid-response', 'A valid strong ETag is required.');
  return value;
}

function parseDecimal(value: string | undefined, name: string): number {
  if (!value || !/^(0|[1-9]\d*)$/.test(value))
    throw new DownloadError('invalid-response', `Invalid ${name} header.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new DownloadError('invalid-response', `${name} exceeds safe integer precision.`);
  return parsed;
}

function parseRange(value: string | undefined): { start: number; end: number; total: number } {
  const match = value?.match(/^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/);
  if (!match) throw new DownloadError('invalid-response', 'A valid Content-Range is required.');
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    end < start ||
    end >= total
  )
    throw new DownloadError('invalid-response', 'Content-Range bounds are inconsistent.');
  return { start, end, total };
}

function makeHash(hashes: HashFactory): Digest {
  const hash = hashes.create();
  if (!hash || typeof hash.update !== 'function' || typeof hash.digest !== 'function')
    throw new TypeError('Hash factory must return an incremental digest.');
  return hash;
}

async function hashStoredPrefix(
  storage: DownloadStorage,
  hashes: HashFactory,
  offset: number,
  chunkBytes: number,
  signal?: AbortSignal,
): Promise<Digest> {
  const hash = makeHash(hashes);
  for (let position = 0; position < offset;) {
    signal?.throwIfAborted();
    const length = Math.min(chunkBytes, offset - position);
    const bytes = await storage.read(position, length);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length)
      throw new DownloadError('integrity-failure', 'Stored prefix is shorter than its checkpoint.');
    hash.update(bytes);
    position += length;
  }
  return hash;
}

export async function download(
  requestAdapter: RangeRequestAdapter,
  storage: DownloadStorage,
  checkpoints: DownloadCheckpointStore,
  hashes: HashFactory,
  options: DownloadOptions,
): Promise<DownloadResult> {
  if (!requestAdapter || typeof requestAdapter.request !== 'function')
    throw new TypeError('A range-request adapter is required.');
  if (!storage || !['size', 'read', 'append', 'truncate'].every((key) => key in storage))
    throw new TypeError('A complete download-storage adapter is required.');
  if (!checkpoints || !['load', 'save', 'clear'].every((key) => key in checkpoints))
    throw new TypeError('A checkpoint-store adapter is required.');
  if (!hashes || typeof hashes.create !== 'function')
    throw new TypeError('A hash factory is required.');
  if (!options || typeof options.url !== 'string' || options.url.length === 0)
    throw new TypeError('A nonempty URL is required.');
  if (options.signal !== undefined && typeof options.signal.throwIfAborted !== 'function')
    throw new TypeError('Expected an AbortSignal.');
  const maxBytes = safeSize(options.maxBytes ?? Number.MAX_SAFE_INTEGER, 'maxBytes');
  const hashChunkBytes = safeSize(options.hashChunkBytes ?? 64 * 1024, 'hashChunkBytes');
  if (hashChunkBytes === 0) throw new RangeError('hashChunkBytes must be positive.');
  if (
    options.expectedDigest !== undefined &&
    (typeof options.expectedDigest !== 'string' || !options.expectedDigest)
  )
    throw new TypeError('expectedDigest must be nonempty when supplied.');

  options.signal?.throwIfAborted();
  const checkpoint = await checkpoints.load();
  let offset = 0;
  let hash = makeHash(hashes);
  let resumed = false;
  if (checkpoint === undefined) await storage.truncate(0);
  if (checkpoint !== undefined) {
    if (
      checkpoint.url !== options.url ||
      typeof checkpoint.etag !== 'string' ||
      typeof checkpoint.prefixDigest !== 'string'
    ) {
      throw new DownloadError(
        'invalid-response',
        'Checkpoint belongs to another URL or has invalid metadata.',
      );
    } else {
      offset = safeSize(checkpoint.offset, 'checkpoint.offset');
      if (offset > maxBytes) throw new DownloadError('size-limit', 'Checkpoint exceeds maxBytes.');
      const storedSize = safeSize(await storage.size(), 'storage size');
      if (storedSize < offset)
        throw new DownloadError(
          'integrity-failure',
          'Stored bytes are shorter than the checkpoint.',
        );
      if (storedSize > offset) await storage.truncate(offset);
      hash = await hashStoredPrefix(storage, hashes, offset, hashChunkBytes, options.signal);
      if (hash.digest() !== checkpoint.prefixDigest) {
        await storage.truncate(0);
        await checkpoints.clear();
        throw new DownloadError(
          'integrity-failure',
          'Stored prefix does not match its checkpoint.',
        );
      }
      resumed = offset > 0;
    }
  }

  options.signal?.throwIfAborted();
  const response = await requestAdapter.request({
    url: options.url,
    offset,
    ...(offset > 0 && checkpoint ? { ifRange: checkpoint.etag } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response || !response.headers || !response.body?.[Symbol.asyncIterator])
    throw new DownloadError('invalid-response', 'Range adapter returned an invalid response.');
  const etag = strongEtag(header(response, 'etag'));
  let total: number;
  let segmentBytes: number;
  if (offset > 0) {
    if (response.status !== 206)
      throw new DownloadError('invalid-response', 'Server ignored the requested byte range.');
    if (etag !== checkpoint?.etag)
      throw new DownloadError('identity-changed', 'Remote ETag changed since the checkpoint.');
    const range = parseRange(header(response, 'content-range'));
    if (range.start !== offset)
      throw new DownloadError(
        'invalid-response',
        'Content-Range does not start at the requested offset.',
      );
    total = range.total;
    segmentBytes = range.end - range.start + 1;
  } else if (response.status === 200) {
    if (header(response, 'content-range') !== undefined)
      throw new DownloadError(
        'invalid-response',
        'A full response must not include Content-Range.',
      );
    total = parseDecimal(header(response, 'content-length'), 'Content-Length');
    segmentBytes = total;
  } else if (response.status === 206) {
    const range = parseRange(header(response, 'content-range'));
    if (range.start !== 0)
      throw new DownloadError('invalid-response', 'Initial Content-Range must start at zero.');
    total = range.total;
    segmentBytes = range.end + 1;
  } else {
    throw new DownloadError('invalid-response', `Unexpected HTTP status ${response.status}.`);
  }
  if (total > maxBytes || total < offset)
    throw new DownloadError(
      'size-limit',
      'Remote object exceeds maxBytes or contradicts the offset.',
    );
  if (offset > 0 && checkpoint && checkpoint.etag !== etag)
    throw new DownloadError('identity-changed', 'Remote ETag changed since the checkpoint.');
  if (offset === 0 && checkpoint?.etag && checkpoint.etag !== etag) await checkpoints.clear();

  let receivedThisResponse = 0;
  try {
    for await (const bytes of response.body) {
      options.signal?.throwIfAborted();
      if (!(bytes instanceof Uint8Array))
        throw new DownloadError('invalid-response', 'Response body yielded a non-byte chunk.');
      if (bytes.byteLength === 0) continue;
      if (bytes.byteLength > segmentBytes - receivedThisResponse)
        throw new DownloadError('invalid-response', 'Response body exceeded its declared range.');
      if (offset + bytes.byteLength > maxBytes)
        throw new DownloadError('size-limit', 'Response exceeded maxBytes.');
      const chunk = bytes.slice();
      await storage.append(chunk.slice());
      hash.update(chunk);
      offset += bytes.byteLength;
      receivedThisResponse += bytes.byteLength;
      const prefixDigest = hash.digest();
      if (!prefixDigest) throw new TypeError('Hash factory returned an empty digest.');
      await checkpoints.save(Object.freeze({ url: options.url, etag, offset, prefixDigest }));
      options.onProgress?.(Object.freeze({ received: offset, total }));
    }
  } catch (error) {
    throw error;
  }
  if (receivedThisResponse !== segmentBytes)
    throw new DownloadError('incomplete-response', 'Response body length did not match its range.');
  if (offset !== total)
    throw new DownloadError(
      'incomplete-response',
      'Download did not reach the advertised object size.',
    );

  const digest = hash.digest();
  if (!digest) throw new TypeError('Hash factory returned an empty digest.');
  if (options.expectedDigest !== undefined && digest !== options.expectedDigest) {
    await storage.truncate(0);
    await checkpoints.clear();
    throw new DownloadError('integrity-failure', 'Downloaded digest did not match expectedDigest.');
  }
  await checkpoints.clear();
  return Object.freeze({ url: options.url, etag, size: offset, digest, resumed });
}
