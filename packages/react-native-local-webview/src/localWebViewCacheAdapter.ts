import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { base64ToBytes, bytesToUtf8 } from './binary';

export type LocalWebViewFileEncoding = 'base64' | 'utf8';

export type LocalWebViewHashAlgorithm = 'sha256' | 'sha384' | 'sha512';

export type LocalWebViewFileDigests = Partial<Record<LocalWebViewHashAlgorithm, string>>;

export type LocalWebViewDirectories = {
  documents: string;
};

export type LocalWebViewFileStat = {
  size: number | string;
};

export type LocalWebViewDownloadOptions = {
  followRedirect: false;
  headers?: Record<string, string>;
  /**
   * Maximum response-body bytes that may be written for this request.
   *
   * Providers must stop the transfer and reject as soon as either the
   * declared response length or the received byte count exceeds this bound.
   * They must also reject if a completed file is larger than the bound.
   * A value of zero permits only an empty response.
   */
  maxBytes?: number;
  overwrite: true;
  path: string;
  signal?: AbortSignal;
  timeoutMs: number;
  url: string;
};

export type LocalWebViewDownloadResult = {
  headers?: Record<string, string>;
  responseUrl: string;
  status: number;
};

export class LocalWebViewDownloadLimitError extends RangeError {
  readonly maxBytes: number;
  readonly observedBytes: number;
  readonly url: string;

  constructor(url: string, maxBytes: number, observedBytes: number) {
    super(`Download exceeded maxBytes=${maxBytes} for ${url} (observed ${observedBytes} bytes)`);
    this.name = 'LocalWebViewDownloadLimitError';
    this.maxBytes = maxBytes;
    this.observedBytes = observedBytes;
    this.url = url;
  }
}

/**
 * Platform capabilities required to persist and stream a local web bundle.
 *
 * Implementations may be backed by any React Native file-system/downloader
 * package. The core package does not rely on provider-specific response or
 * path types.
 */
export interface LocalWebViewCacheAdapter {
  /**
   * `documents` must be persistent application storage.
   */
  readonly directories: LocalWebViewDirectories;
  copyFile(source: string, destination: string): Promise<void>;
  /**
   * Download exactly one HTTP response to `options.path`, overwriting it.
   * Do not follow redirects: return the 3xx response and its headers so the
   * core can validate every redirect target. AbortSignal cancellation must
   * stop the provider request and reject. When `maxBytes` is present, the
   * provider must enforce it while receiving the body, not only after the
   * complete response has been buffered or written. Reject an exceeded bound
   * with `LocalWebViewDownloadLimitError`.
   */
  download(options: LocalWebViewDownloadOptions): Promise<LocalWebViewDownloadResult>;
  exists(path: string): Promise<boolean>;
  /**
   * Return every requested raw hexadecimal digest. Implementations should
   * prefer native or single-pass hashing for large WebGL artifacts. Uppercase
   * and lowercase digits are both accepted and normalized by the core.
   */
  hashFile(
    path: string,
    algorithms: readonly LocalWebViewHashAlgorithm[]
  ): Promise<LocalWebViewFileDigests>;
  /**
   * Return immediate child names, not absolute paths or recursive entries.
   */
  listDirectory(path: string): Promise<string[]>;
  /**
   * Recursively create missing parents and succeed when the directory exists.
   */
  makeDirectory(path: string): Promise<void>;
  /**
   * Move a file on the same storage volume without exposing a partial
   * destination file.
   */
  moveFile(source: string, destination: string): Promise<void>;
  readFile(path: string, encoding: LocalWebViewFileEncoding): Promise<string>;
  /**
   * Read exactly the byte range `[start, end)`. This is the latency-sensitive
   * path used to stream large WebGL data and WASM artifacts into the WebView;
   * production adapters should implement a direct positional read.
   */
  readFileRange(
    path: string,
    start: number,
    end: number,
    encoding: LocalWebViewFileEncoding
  ): Promise<string>;
  /**
   * Remove either a file or a directory recursively.
   */
  remove(path: string): Promise<void>;
  stat(path: string): Promise<LocalWebViewFileStat>;
  /**
   * Create or overwrite the complete destination file.
   */
  writeFile(path: string, value: string, encoding: LocalWebViewFileEncoding): Promise<void>;
}

export type CreateLocalWebViewCacheAdapterOptions = Pick<
  LocalWebViewCacheAdapter,
  | 'directories'
  | 'download'
  | 'exists'
  | 'listDirectory'
  | 'makeDirectory'
  | 'moveFile'
  | 'readFileRange'
  | 'remove'
  | 'stat'
  | 'writeFile'
> &
  Partial<Pick<LocalWebViewCacheAdapter, 'copyFile' | 'hashFile' | 'readFile'>> & {
    /**
     * Byte range used by the default incremental `hashFile` implementation.
     *
     * @default 1048576 (1 MiB)
     */
    hashChunkBytes?: number;
  };

type IncrementalHash = {
  destroy(): void;
  digest(): Uint8Array;
  update(bytes: Uint8Array): IncrementalHash;
};

function fileSize(stat: LocalWebViewFileStat, path: string): number {
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Invalid file size for ${path}: ${String(stat.size)}`);
  }
  return size;
}

/**
 * Creates a cache adapter from the host's filesystem and download primitives.
 *
 * `readFile`, `copyFile`, and incremental SHA-2 hashing are supplied when the
 * host does not provide optimized implementations. Large-file streaming still
 * requires a direct `readFileRange` implementation, and `download` must honor
 * the redirect, cancellation, timeout, and byte-limit contract.
 */
export function createLocalWebViewCacheAdapter({
  copyFile,
  hashChunkBytes = 1024 * 1024,
  hashFile,
  readFile,
  ...required
}: CreateLocalWebViewCacheAdapterOptions): LocalWebViewCacheAdapter {
  if (!Number.isSafeInteger(hashChunkBytes) || hashChunkBytes <= 0) {
    throw new Error('hashChunkBytes must be a positive safe integer');
  }
  if (!required.directories.documents) {
    throw new Error('directories.documents must identify persistent application storage');
  }

  const read =
    readFile ??
    (async (path: string, encoding: LocalWebViewFileEncoding): Promise<string> => {
      const size = fileSize(await required.stat(path), path);
      if (size === 0) return '';
      const base64 = await required.readFileRange(path, 0, size, 'base64');
      return encoding === 'base64' ? base64 : bytesToUtf8(base64ToBytes(base64));
    });

  const copy =
    copyFile ??
    (async (source: string, destination: string): Promise<void> => {
      await required.writeFile(destination, await read(source, 'base64'), 'base64');
    });

  const hash =
    hashFile ??
    (async (
      path: string,
      algorithms: readonly LocalWebViewHashAlgorithm[]
    ): Promise<LocalWebViewFileDigests> => {
      const constructors = { sha256, sha384, sha512 };
      const uniqueAlgorithms = [...new Set(algorithms)];
      const hashers = new Map<LocalWebViewHashAlgorithm, IncrementalHash>(
        uniqueAlgorithms.map((algorithm) => [algorithm, constructors[algorithm].create()])
      );
      try {
        const size = fileSize(await required.stat(path), path);
        for (let start = 0; start < size; start += hashChunkBytes) {
          const end = Math.min(start + hashChunkBytes, size);
          const bytes = base64ToBytes(await required.readFileRange(path, start, end, 'base64'));
          if (bytes.byteLength !== end - start) {
            throw new Error(
              `readFileRange returned ${bytes.byteLength} bytes for [${start}, ${end}) in ${path}`
            );
          }
          for (const hasher of hashers.values()) hasher.update(bytes);
        }
        return Object.fromEntries(
          [...hashers].map(([algorithm, hasher]) => [algorithm, bytesToHex(hasher.digest())])
        );
      } finally {
        for (const hasher of hashers.values()) hasher.destroy();
      }
    });

  return {
    ...required,
    copyFile: copy,
    hashFile: hash,
    readFile: read,
  };
}

export function createAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}
