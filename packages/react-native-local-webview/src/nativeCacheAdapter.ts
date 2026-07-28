import { NitroModules } from 'react-native-nitro-modules';

import type { LocalWebViewCache } from './LocalWebViewCache.nitro';
import {
  createAbortError,
  LocalWebViewDownloadLimitError,
  type LocalWebViewCacheAdapter,
  type LocalWebViewDownloadResult,
  type LocalWebViewFileDigests,
} from './localWebViewCacheAdapter';

let adapter: LocalWebViewCacheAdapter | undefined;
let nextRequestId = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function translateDownloadError(error: unknown): Error {
  const match = /LOCAL_WEBVIEW_DOWNLOAD_LIMIT\|(\d+)\|(\d+)\|(.*)/.exec(errorMessage(error));
  return match
    ? new LocalWebViewDownloadLimitError(match[3]!, Number(match[1]), Number(match[2]))
    : error instanceof Error
      ? error
      : new Error(String(error));
}

export function createNativeCacheAdapter(cache: LocalWebViewCache): LocalWebViewCacheAdapter {
  return {
    directories: { documents: cache.documentsDirectory },
    copyFile: (source, destination) => cache.copyFile(source, destination),
    async download(options): Promise<LocalWebViewDownloadResult> {
      if (options.signal?.aborted) throw createAbortError();
      const requestId = `local-webview-${Date.now()}-${nextRequestId++}`;
      const abort = (): void => cache.cancelDownload(requestId);
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await cache.download(
          requestId,
          JSON.stringify({
            headers: options.headers,
            maxBytes: options.maxBytes,
            path: options.path,
            timeoutMs: options.timeoutMs,
            url: options.url,
          })
        );
        if (options.signal?.aborted) throw createAbortError();
        return JSON.parse(response) as LocalWebViewDownloadResult;
      } catch (error) {
        if (options.signal?.aborted) throw createAbortError();
        throw translateDownloadError(error);
      } finally {
        options.signal?.removeEventListener('abort', abort);
      }
    },
    exists: (path) => cache.exists(path),
    async hashFile(path, algorithms): Promise<LocalWebViewFileDigests> {
      return JSON.parse(
        await cache.hashFile(path, JSON.stringify(algorithms))
      ) as LocalWebViewFileDigests;
    },
    listDirectory: (path) => cache.listDirectory(path),
    makeDirectory: (path) => cache.makeDirectory(path),
    moveFile: (source, destination) => cache.moveFile(source, destination),
    readFile: (path, encoding) => cache.readFile(path, encoding),
    readFileRange: (path, start, end, encoding) => cache.readFileRange(path, start, end, encoding),
    remove: (path) => cache.remove(path),
    async stat(path) {
      return { size: await cache.stat(path) };
    },
    writeFile: (path, value, encoding) => cache.writeFile(path, value, encoding),
  };
}

export function getNativeCacheAdapter(): LocalWebViewCacheAdapter {
  return (adapter ??= createNativeCacheAdapter(
    NitroModules.createHybridObject<LocalWebViewCache>('LocalWebViewCache')
  ));
}
