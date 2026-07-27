import { URL } from 'react-native-url-polyfill';

import {
  createAbortError,
  createLocalWebViewCacheAdapter,
  LocalWebViewDownloadLimitError,
  throwIfAborted,
  type LocalWebViewCacheAdapter,
  type LocalWebViewDownloadOptions,
  type LocalWebViewDownloadResult,
  type LocalWebViewFileEncoding,
  type LocalWebViewHashAlgorithm,
} from './localWebViewCacheAdapter';
import { bytesToBase64, bytesToUtf8 } from './binary';

export type CacheAdapterPresetOptions = {
  documentsDirectory?: string;
  download: LocalWebViewCacheAdapter['download'];
};

export type ReactNativeFsLike = {
  DocumentDirectoryPath: string;
  copyFile(source: string, destination: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  hash(path: string, algorithm: LocalWebViewHashAlgorithm): Promise<string>;
  mkdir(path: string): Promise<void>;
  moveFile(source: string, destination: string): Promise<void>;
  read(
    path: string,
    length: number,
    position: number,
    encoding: LocalWebViewFileEncoding
  ): Promise<string>;
  readFile(path: string, encoding: LocalWebViewFileEncoding): Promise<string>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number | string }>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, value: string, encoding: LocalWebViewFileEncoding): Promise<void>;
};

/**
 * Preset for `react-native-fs`.
 *
 * Its built-in downloader follows redirects, so callers must supply a
 * downloader that implements the stricter `LocalWebViewCacheAdapter` contract.
 */
export function createReactNativeFsCacheAdapter(
  fileSystem: ReactNativeFsLike,
  { documentsDirectory = fileSystem.DocumentDirectoryPath, download }: CacheAdapterPresetOptions
): LocalWebViewCacheAdapter {
  return createLocalWebViewCacheAdapter({
    copyFile: (source, destination) => fileSystem.copyFile(source, destination),
    directories: { documents: documentsDirectory },
    download,
    exists: (path) => fileSystem.exists(path),
    hashFile: async (path, algorithms) =>
      Object.fromEntries(
        await Promise.all(
          [...new Set(algorithms)].map(async (algorithm) => [
            algorithm,
            await fileSystem.hash(path, algorithm),
          ])
        )
      ),
    listDirectory: (path) => fileSystem.readdir(path),
    makeDirectory: async (path) => {
      if (await fileSystem.exists(path)) {
        await fileSystem.readdir(path);
        return;
      }
      try {
        await fileSystem.mkdir(path);
      } catch (error) {
        if (!(await fileSystem.exists(path))) throw error;
        await fileSystem.readdir(path);
      }
    },
    moveFile: (source, destination) => fileSystem.moveFile(source, destination),
    readFile: (path, encoding) => fileSystem.readFile(path, encoding),
    readFileRange: (path, start, end, encoding) =>
      fileSystem.read(path, end - start, start, encoding),
    remove: async (path) => {
      if (!(await fileSystem.exists(path))) return;
      await fileSystem.unlink(path);
      if (await fileSystem.exists(path)) {
        throw new Error(`Failed to remove ${path}`);
      }
    },
    stat: (path) => fileSystem.stat(path),
    writeFile: (path, value, encoding) => fileSystem.writeFile(path, value, encoding),
  });
}

type ReactNativeFileAccessHashAlgorithm = 'SHA-256' | 'SHA-384' | 'SHA-512';

export type ReactNativeFileAccessLike = {
  Dirs: {
    DocumentDir: string;
  };
  FileSystem: {
    cp(source: string, destination: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    hash(path: string, algorithm: ReactNativeFileAccessHashAlgorithm): Promise<string>;
    ls(path: string): Promise<string[]>;
    mkdir(path: string): Promise<unknown>;
    mv(source: string, destination: string): Promise<void>;
    readFile(path: string, encoding?: LocalWebViewFileEncoding): Promise<string>;
    readFileChunk(
      path: string,
      offset: number,
      length: number,
      encoding?: LocalWebViewFileEncoding
    ): Promise<string>;
    stat(path: string): Promise<{ size: number | string }>;
    unlink(path: string): Promise<void>;
    writeFile(path: string, value: string, encoding?: LocalWebViewFileEncoding): Promise<void>;
  };
};

/**
 * Preset for `react-native-file-access`.
 *
 * Its managed fetch currently follows redirects, so callers must supply a
 * downloader that implements the stricter `LocalWebViewCacheAdapter` contract.
 */
export function createReactNativeFileAccessCacheAdapter(
  module: ReactNativeFileAccessLike,
  { documentsDirectory = module.Dirs.DocumentDir, download }: CacheAdapterPresetOptions
): LocalWebViewCacheAdapter {
  const { FileSystem: fileSystem } = module;
  const hashAlgorithms: Record<LocalWebViewHashAlgorithm, ReactNativeFileAccessHashAlgorithm> = {
    sha256: 'SHA-256',
    sha384: 'SHA-384',
    sha512: 'SHA-512',
  };
  return createLocalWebViewCacheAdapter({
    copyFile: (source, destination) => fileSystem.cp(source, destination),
    directories: { documents: documentsDirectory },
    download,
    exists: (path) => fileSystem.exists(path),
    hashFile: async (path, algorithms) =>
      Object.fromEntries(
        await Promise.all(
          [...new Set(algorithms)].map(async (algorithm) => [
            algorithm,
            await fileSystem.hash(path, hashAlgorithms[algorithm]),
          ])
        )
      ),
    listDirectory: (path) => fileSystem.ls(path),
    makeDirectory: async (path) => {
      if (await fileSystem.exists(path)) {
        await fileSystem.ls(path);
        return;
      }
      try {
        await fileSystem.mkdir(path);
      } catch (error) {
        if (!(await fileSystem.exists(path))) throw error;
        await fileSystem.ls(path);
      }
    },
    moveFile: (source, destination) => fileSystem.mv(source, destination),
    readFile: (path, encoding) => fileSystem.readFile(path, encoding),
    readFileRange: (path, start, end, encoding) =>
      fileSystem.readFileChunk(path, start, end - start, encoding),
    remove: async (path) => {
      if (await fileSystem.exists(path)) await fileSystem.unlink(path);
    },
    stat: (path) => fileSystem.stat(path),
    writeFile: (path, value, encoding) => fileSystem.writeFile(path, value, encoding),
  });
}

type ExpoFileSystemConstructor = abstract new (...arguments_: never[]) => object;

export type ExpoFileSystemLike = {
  Directory: ExpoFileSystemConstructor;
  File: ExpoFileSystemConstructor;
  Paths: {
    document: { uri: string };
    info(...uris: string[]): {
      exists: boolean;
      isDirectory: boolean | null;
    };
  };
};

type ExpoFileSystemHandle = {
  close(): void;
  offset: number | null;
  readBytes(length: number): Uint8Array;
};

type ExpoFileSystemFile = {
  base64(): Promise<string>;
  copy(destination: ExpoFileSystemFile, options: { overwrite: true }): Promise<void>;
  delete(): void;
  move(destination: ExpoFileSystemFile, options: { overwrite: true }): Promise<void>;
  open(mode: 'r'): ExpoFileSystemHandle;
  size: number;
  text(): Promise<string>;
  write(
    value: string | Uint8Array,
    options: { append: false; encoding: LocalWebViewFileEncoding }
  ): void;
};

type ExpoFileSystemDirectory = {
  create(options: { idempotent: true; intermediates: true }): void;
  delete(): void;
  list(): Array<{ name: string }>;
  size: number | null;
};

type ExpoFileSystemInternals = {
  Directory: new (uri: string) => ExpoFileSystemDirectory;
  File: new (uri: string) => ExpoFileSystemFile;
};

/**
 * Preset for the current object-oriented `expo-file-system` API.
 *
 * Expo's downloader follows redirects, so callers must supply a downloader
 * that implements the stricter `LocalWebViewCacheAdapter` contract.
 */
export function createExpoFileSystemCacheAdapter(
  module: ExpoFileSystemLike,
  {
    documentsDirectory = module.Paths.document.uri.replace(/\/+$/, ''),
    download,
  }: CacheAdapterPresetOptions
): LocalWebViewCacheAdapter {
  const { Directory, File } = module as unknown as ExpoFileSystemInternals;
  const pathInfo = (path: string) => module.Paths.info(path);

  return createLocalWebViewCacheAdapter({
    copyFile: async (source, destination) => {
      await new File(source).copy(new File(destination), { overwrite: true });
    },
    directories: { documents: documentsDirectory },
    download,
    exists: async (path) => pathInfo(path).exists,
    listDirectory: async (path) => new Directory(path).list().map((entry) => entry.name),
    makeDirectory: async (path) => {
      new Directory(path).create({ idempotent: true, intermediates: true });
    },
    moveFile: async (source, destination) => {
      await new File(source).move(new File(destination), { overwrite: true });
    },
    readFile: (path, encoding) => {
      const file = new File(path);
      return encoding === 'base64' ? file.base64() : file.text();
    },
    readFileRange: async (path, start, end, encoding) => {
      const handle = new File(path).open('r');
      try {
        handle.offset = start;
        const bytes = handle.readBytes(end - start);
        return encoding === 'base64' ? bytesToBase64(bytes) : bytesToUtf8(bytes);
      } finally {
        handle.close();
      }
    },
    remove: async (path) => {
      const info = pathInfo(path);
      if (!info.exists) return;
      if (info.isDirectory === null) {
        throw new Error(`Unable to determine whether ${path} is a directory`);
      }
      if (info.isDirectory) new Directory(path).delete();
      else new File(path).delete();
    },
    stat: async (path) => {
      const info = pathInfo(path);
      if (!info.exists) throw new Error(`No such file or directory: ${path}`);
      const size = info.isDirectory ? new Directory(path).size : new File(path).size;
      if (size === null) throw new Error(`Unable to read file size for ${path}`);
      return { size };
    },
    writeFile: async (path, value, encoding) => {
      new File(path).write(value, { append: false, encoding });
    },
  });
}

type BlobUtilResponseInfo = {
  headers?: Record<string, unknown>;
  redirects?: string[];
  status: number;
  timeout?: boolean;
};

type BlobUtilResponse = {
  info(): BlobUtilResponseInfo;
};

type BlobUtilTask = PromiseLike<BlobUtilResponse> & {
  cancel(): unknown;
  progress(
    config: { interval: number },
    callback: (received: number, total: number) => void
  ): unknown;
  stateChange?(callback: (info: BlobUtilResponseInfo) => void): unknown;
};

export type ReactNativeBlobUtilLike = {
  config(options: { followRedirect: false; overwrite: true; path: string; timeout: number }): {
    fetch(method: 'GET', url: string, headers?: Record<string, string>): BlobUtilTask;
  };
  fs: {
    cp(source: string, destination: string): Promise<unknown>;
    dirs: {
      CacheDir: string;
      DocumentDir: string;
    };
    exists(path: string): Promise<boolean>;
    hash(path: string, algorithm: LocalWebViewHashAlgorithm): Promise<string>;
    ls(path: string): Promise<string[]>;
    mkdir(path: string): Promise<unknown>;
    mv(source: string, destination: string): Promise<unknown>;
    readFile(path: string, encoding: LocalWebViewFileEncoding): Promise<string>;
    slice(source: string, destination: string, start: number, end: number): Promise<unknown>;
    stat(path: string): Promise<{ size: number | string }>;
    unlink(path: string): Promise<unknown>;
    writeFile(path: string, value: string, encoding: LocalWebViewFileEncoding): Promise<unknown>;
  };
};

export type ReactNativeBlobUtilCacheAdapterOptions = {
  documentsDirectory?: string;
  download?: LocalWebViewCacheAdapter['download'];
  readFileRange?: LocalWebViewCacheAdapter['readFileRange'];
  temporaryDirectory?: string;
};

let blobUtilSliceSequence = 0;

function responseHeaders(value: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([name, header]) => [
      name,
      Array.isArray(header) ? header.join(', ') : String(header),
    ])
  );
}

function headerValue(headers: Record<string, string>, expectedName: string): string | undefined {
  const normalizedName = expectedName.toLowerCase();
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === normalizedName);
  return entry?.[1];
}

function nonnegativeHeaderInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function contentRange(value: string | undefined):
  | {
      end?: number;
      start?: number;
      total: number;
    }
  | undefined {
  const match = value?.trim().match(/^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+)$/i);
  if (!match) return undefined;
  const total = nonnegativeHeaderInteger(match[3]);
  if (total === undefined) return undefined;
  if (match[1] === undefined || match[2] === undefined) return { total };
  const start = nonnegativeHeaderInteger(match[1]);
  const end = nonnegativeHeaderInteger(match[2]);
  if (start === undefined || end === undefined || start > end) return undefined;
  return { end, start, total };
}

function requestsMatchUrl(urls: readonly string[] | undefined, requestedUrl: string): boolean {
  if (!urls || urls.length === 0) return false;
  return urls.every((url) => {
    try {
      return new URL(url).href === requestedUrl;
    } catch {
      return false;
    }
  });
}

async function removeIfPresent(
  fileSystem: ReactNativeBlobUtilLike['fs'],
  path: string
): Promise<void> {
  if (!(await fileSystem.exists(path))) return;
  await fileSystem.unlink(path);
  if (await fileSystem.exists(path)) {
    throw new Error(`Failed to remove ${path}`);
  }
}

class BlobUtilRangeDownloadInterruptedError extends Error {}

async function runBlobUtilDownload(
  blobUtil: ReactNativeBlobUtilLike,
  options: LocalWebViewDownloadOptions,
  useBoundedRange: boolean
): Promise<LocalWebViewDownloadResult> {
  throwIfAborted(options.signal);
  if (
    options.maxBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
  ) {
    throw new Error('maxBytes must be a non-negative safe integer');
  }
  await removeIfPresent(blobUtil.fs, options.path);
  let limitExceeded: { observedBytes: number } | undefined;
  let earlyResponseInfo: BlobUtilResponseInfo | undefined;
  let earlyResponseError: Error | undefined;
  let expectedRangeBytes: number | undefined;
  let expectedResponseBytes: number | undefined;
  let latestResponseInfo: BlobUtilResponseInfo | undefined;
  let nativeProgressHasLength = false;
  let sizePollingStopped = false;
  let sizePollingTimer: ReturnType<typeof setTimeout> | undefined;
  const requestHeaders = { ...options.headers };
  if (options.maxBytes !== undefined) {
    for (const name of Object.keys(requestHeaders)) {
      if (name.toLowerCase() === 'range') delete requestHeaders[name];
    }
    if (!Object.keys(requestHeaders).some((name) => name.toLowerCase() === 'accept-encoding')) {
      requestHeaders['Accept-Encoding'] = 'identity';
    }
    if (useBoundedRange) requestHeaders.Range = `bytes=0-${options.maxBytes}`;
  }
  const task = blobUtil
    .config({
      followRedirect: false,
      overwrite: true,
      path: options.path,
      timeout: options.timeoutMs,
    })
    .fetch('GET', options.url, requestHeaders);
  const pollDownloadedSize = async (): Promise<void> => {
    if (
      sizePollingStopped ||
      limitExceeded ||
      nativeProgressHasLength ||
      options.signal?.aborted ||
      options.maxBytes === undefined
    ) {
      return;
    }
    try {
      if (await blobUtil.fs.exists(options.path)) {
        const size = Number((await blobUtil.fs.stat(options.path)).size);
        if (Number.isSafeInteger(size) && size >= 0 && size > options.maxBytes) {
          limitExceeded = { observedBytes: size };
          task.cancel();
          return;
        }
      }
    } catch {
      // The native downloader may create or replace the path between calls.
      // The completed-file check below remains authoritative.
    }
    if (!sizePollingStopped && !limitExceeded && !nativeProgressHasLength) {
      sizePollingTimer = setTimeout(() => void pollDownloadedSize(), 25);
    }
  };
  void pollDownloadedSize();
  const requestedUrl = new URL(options.url).href;
  const inspectResponseLimit = (info: BlobUtilResponseInfo): void => {
    if (
      options.maxBytes === undefined ||
      earlyResponseError ||
      limitExceeded ||
      !requestsMatchUrl(info.redirects, requestedUrl)
    ) {
      return;
    }
    const headers = responseHeaders(info.headers);
    if (info.status === 206) {
      const range = contentRange(headerValue(headers, 'content-range'));
      if (range?.start !== 0 || range.end === undefined) {
        earlyResponseError = new Error(
          `Invalid Content-Range while enforcing maxBytes for ${options.url}`
        );
      } else if (range.total > options.maxBytes) {
        limitExceeded = { observedBytes: range.total };
      } else if (range.total === 0 || range.end !== range.total - 1) {
        earlyResponseError = new Error(
          `Incomplete Content-Range while enforcing maxBytes for ${options.url}`
        );
      } else {
        expectedRangeBytes = range.total;
      }
    } else if (info.status === 200) {
      const length = nonnegativeHeaderInteger(headerValue(headers, 'content-length'));
      if (length === undefined) {
        earlyResponseError = new Error(
          `The server ignored the bounded Range request without a Content-Length for ${options.url}`
        );
      } else if (length > options.maxBytes) {
        limitExceeded = { observedBytes: length };
      } else {
        expectedResponseBytes = length;
      }
    } else {
      earlyResponseInfo = info;
    }
    // A conditional 304 has no body. Let the native task finish naturally:
    // cancelling it from a response callback can also interrupt sibling tasks
    // in react-native-blob-util on iOS.
    if (earlyResponseError || (earlyResponseInfo && info.status !== 304) || limitExceeded) {
      task.cancel();
    }
  };
  task.stateChange?.((info) => {
    latestResponseInfo = info;
    inspectResponseLimit(info);
  });
  const finishEarlyResponse = async (
    info: BlobUtilResponseInfo
  ): Promise<LocalWebViewDownloadResult> => {
    const headers = responseHeaders(info.headers);
    const emptyRangeResponse =
      info.status === 416 && contentRange(headerValue(headers, 'content-range'))?.total === 0;
    if (info.status === 204 || info.status === 205 || emptyRangeResponse) {
      await blobUtil.fs.writeFile(options.path, '', 'base64');
    }
    return {
      headers,
      responseUrl: options.url,
      status: emptyRangeResponse ? 200 : info.status,
    };
  };
  const cancelForAbort = () => task.cancel();
  options.signal?.addEventListener('abort', cancelForAbort, { once: true });
  if (options.signal?.aborted) cancelForAbort();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    task.cancel();
  }, options.timeoutMs);
  task.progress({ interval: 1 }, (received, total) => {
    if (total >= 0) {
      nativeProgressHasLength = true;
      if (sizePollingTimer !== undefined) clearTimeout(sizePollingTimer);
    }
    if (limitExceeded || options.signal?.aborted || options.maxBytes === undefined) {
      return;
    }
    if (received > options.maxBytes || total > options.maxBytes) {
      limitExceeded = { observedBytes: Math.max(received, total) };
      task.cancel();
    }
  });

  let response: BlobUtilResponse;
  try {
    response = await task;
  } catch (error) {
    if (limitExceeded) {
      throw new LocalWebViewDownloadLimitError(
        options.url,
        options.maxBytes!,
        limitExceeded.observedBytes
      );
    }
    if (earlyResponseError) throw earlyResponseError;
    if (earlyResponseInfo) return await finishEarlyResponse(earlyResponseInfo);
    if (options.signal?.aborted) throw createAbortError();
    if (timedOut) throw new Error(`Download timed out after ${options.timeoutMs}ms`);
    const interruptedInfo = latestResponseInfo;
    if (
      interruptedInfo &&
      [200, 206].includes(interruptedInfo.status) &&
      requestsMatchUrl(interruptedInfo.redirects, requestedUrl) &&
      (await blobUtil.fs.exists(options.path))
    ) {
      const interruptedHeaders = responseHeaders(interruptedInfo.headers);
      const interruptedRange = contentRange(headerValue(interruptedHeaders, 'content-range'));
      const expectedBytes =
        interruptedInfo.status === 206 &&
        interruptedRange?.start === 0 &&
        interruptedRange.end === interruptedRange.total - 1
          ? interruptedRange.total
          : interruptedInfo.status === 200
            ? nonnegativeHeaderInteger(headerValue(interruptedHeaders, 'content-length'))
            : undefined;
      const size = Number((await blobUtil.fs.stat(options.path)).size);
      if (
        expectedBytes !== undefined &&
        Number.isSafeInteger(size) &&
        size === expectedBytes &&
        (options.maxBytes === undefined || size <= options.maxBytes)
      ) {
        return {
          headers: interruptedHeaders,
          responseUrl: options.url,
          status: interruptedInfo.status === 206 ? 200 : interruptedInfo.status,
        };
      }
    }
    if (
      useBoundedRange &&
      error instanceof Error &&
      error.message === 'Download interrupted.' &&
      options.maxBytes !== undefined
    ) {
      throw new BlobUtilRangeDownloadInterruptedError(error.message);
    }
    throw error;
  } finally {
    sizePollingStopped = true;
    if (sizePollingTimer !== undefined) clearTimeout(sizePollingTimer);
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancelForAbort);
  }

  if (limitExceeded) {
    throw new LocalWebViewDownloadLimitError(
      options.url,
      options.maxBytes!,
      limitExceeded.observedBytes
    );
  }
  if (earlyResponseError) throw earlyResponseError;
  if (earlyResponseInfo) return await finishEarlyResponse(earlyResponseInfo);
  if (options.signal?.aborted) throw createAbortError();
  if (timedOut) throw new Error(`Download timed out after ${options.timeoutMs}ms`);

  const info = response.info();
  inspectResponseLimit(info);
  const completedLimitExceeded = limitExceeded as { observedBytes: number } | undefined;
  if (completedLimitExceeded) {
    throw new LocalWebViewDownloadLimitError(
      options.url,
      options.maxBytes!,
      completedLimitExceeded.observedBytes
    );
  }
  if (earlyResponseError) throw earlyResponseError;
  const completedEarlyResponse = earlyResponseInfo as BlobUtilResponseInfo | undefined;
  if (completedEarlyResponse) return await finishEarlyResponse(completedEarlyResponse);
  if (info.timeout) throw new Error(`Download timed out after ${options.timeoutMs}ms`);
  const reportedRequests = info.redirects ?? [];
  const unexpectedRedirect = reportedRequests.some((url) => {
    try {
      return new URL(url).href !== requestedUrl;
    } catch {
      return true;
    }
  });
  if (unexpectedRedirect) {
    throw new Error('react-native-blob-util followed a redirect despite followRedirect=false');
  }
  const headers = responseHeaders(info.headers);
  if (options.maxBytes !== undefined && (await blobUtil.fs.exists(options.path))) {
    const size = Number((await blobUtil.fs.stat(options.path)).size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid downloaded file size for ${options.path}`);
    }
    if (size > options.maxBytes) {
      throw new LocalWebViewDownloadLimitError(options.url, options.maxBytes, size);
    }
    const completedRangeBytes = expectedRangeBytes as number | undefined;
    if (completedRangeBytes !== undefined && size !== completedRangeBytes) {
      throw new Error(
        `Range response wrote ${size} bytes instead of ${completedRangeBytes} for ${options.url}`
      );
    }
    const completedResponseBytes = expectedResponseBytes as number | undefined;
    if (completedResponseBytes !== undefined && size !== completedResponseBytes) {
      throw new Error(
        `Response wrote ${size} bytes instead of ${completedResponseBytes} for ${options.url}`
      );
    }
  }
  return {
    headers,
    responseUrl: options.url,
    status: options.maxBytes !== undefined && info.status === 206 ? 200 : info.status,
  };
}

function createBlobUtilDownload(
  blobUtil: ReactNativeBlobUtilLike
): LocalWebViewCacheAdapter['download'] {
  return async (options) => {
    try {
      return await runBlobUtilDownload(blobUtil, options, true);
    } catch (error) {
      if (!(error instanceof BlobUtilRangeDownloadInterruptedError)) throw error;
      return await runBlobUtilDownload(blobUtil, options, false);
    }
  };
}

/**
 * Complete preset for `react-native-blob-util`.
 *
 * The module is injected by the application, so it is not a dependency or
 * peer dependency of this package. Its downloader uses a bounded HTTP Range
 * request whenever `maxBytes` is present and rejects an unbounded response.
 *
 * When no direct range reader is supplied, the preset uses the module's native
 * `slice` operation and a temporary file. Pass a direct positional reader for
 * large WebGL artifacts to avoid that extra temporary-file I/O.
 */
export function createReactNativeBlobUtilCacheAdapter(
  blobUtil: ReactNativeBlobUtilLike,
  {
    documentsDirectory = blobUtil.fs.dirs.DocumentDir,
    download = createBlobUtilDownload(blobUtil),
    readFileRange,
    temporaryDirectory = blobUtil.fs.dirs.CacheDir,
  }: ReactNativeBlobUtilCacheAdapterOptions = {}
): LocalWebViewCacheAdapter {
  const { fs: fileSystem } = blobUtil;
  const rangeRead =
    readFileRange ??
    (async (
      path: string,
      start: number,
      end: number,
      encoding: LocalWebViewFileEncoding
    ): Promise<string> => {
      const temporaryPath = `${temporaryDirectory}/react-native-local-webview-range-${blobUtilSliceSequence++}`;
      try {
        await fileSystem.slice(path, temporaryPath, start, end);
        return await fileSystem.readFile(temporaryPath, encoding);
      } finally {
        await removeIfPresent(fileSystem, temporaryPath);
      }
    });

  return createLocalWebViewCacheAdapter({
    copyFile: async (source, destination) => {
      await fileSystem.cp(source, destination);
    },
    directories: { documents: documentsDirectory },
    download,
    exists: (path) => fileSystem.exists(path),
    hashFile: async (path, algorithms) =>
      Object.fromEntries(
        await Promise.all(
          [...new Set(algorithms)].map(async (algorithm) => [
            algorithm,
            await fileSystem.hash(path, algorithm),
          ])
        )
      ),
    listDirectory: (path) => fileSystem.ls(path),
    makeDirectory: async (path) => {
      if (await fileSystem.exists(path)) {
        await fileSystem.ls(path);
        return;
      }
      try {
        await fileSystem.mkdir(path);
      } catch (error) {
        if (!(await fileSystem.exists(path))) throw error;
        await fileSystem.ls(path);
      }
    },
    moveFile: async (source, destination) => {
      await fileSystem.mv(source, destination);
    },
    readFile: (path, encoding) => fileSystem.readFile(path, encoding),
    readFileRange: rangeRead,
    remove: (path) => removeIfPresent(fileSystem, path),
    stat: (path) => fileSystem.stat(path),
    writeFile: async (path, value, encoding) => {
      await fileSystem.writeFile(path, value, encoding);
    },
  });
}
