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
  /**
   * Digests to compute while streaming the response to `path`.
   *
   * Providers may omit the resulting metadata, in which case the core falls
   * back to hashing the completed file.
   */
  hashAlgorithms?: readonly LocalWebViewHashAlgorithm[];
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
  /**
   * Exact response-body bytes written to `path`.
   *
   * Native implementations provide this so the resource graph does not need
   * a second filesystem round trip after every completed download.
   */
  bytesWritten?: number;
  /**
   * Raw hexadecimal digests computed over the bytes written to `path`.
   */
  digests?: LocalWebViewFileDigests;
  headers?: Record<string, string>;
  responseUrl: string;
  status: number;
  /**
   * Whether this response created `path`. Non-success responses stay entirely
   * in the native networking layer.
   */
  wroteFile?: boolean;
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

/** Internal boundary between the JS resource graph and the Nitro cache object. */
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

export function createAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}
