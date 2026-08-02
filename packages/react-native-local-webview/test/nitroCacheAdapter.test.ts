import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native-nitro-modules', () => ({
  NitroModules: { createHybridObject: vi.fn<() => never>() },
}));

import type { LocalWebViewCache } from '../src/LocalWebViewCache.nitro';
import { LocalWebViewDownloadLimitError } from '../src/localWebViewCacheAdapter';
import { createNitroCacheAdapter } from '../src/nitroCacheAdapter';

function cacheObject(overrides: Partial<LocalWebViewCache> = {}): LocalWebViewCache {
  return {
    cancelDownload: () => undefined,
    copyFile: async () => undefined,
    documentsDirectory: '/documents',
    download: async () =>
      JSON.stringify({
        bytesWritten: 12,
        digests: { sha256: 'abc' },
        headers: { etag: '"one"' },
        responseUrl: 'https://example.com/app.js',
        status: 200,
        wroteFile: true,
      }),
    exists: async () => true,
    hashFile: async () => '{"sha256":"abc"}',
    listDirectory: async () => ['one'],
    makeDirectory: async () => undefined,
    moveFile: async () => undefined,
    name: 'LocalWebViewCache',
    readFile: async () => 'contents',
    readFileRange: async () => 'cmFuZ2U=',
    remove: async () => undefined,
    stat: async () => 42,
    toString: () => '[HybridObject LocalWebViewCache]',
    writeFile: async () => undefined,
    ...overrides,
  } as LocalWebViewCache;
}

describe('Nitro cache adapter', () => {
  it('passes only request metadata to the cache object and parses response metadata', async () => {
    const nativeDownload = vi.fn<LocalWebViewCache['download']>(async () =>
      JSON.stringify({
        bytesWritten: 12,
        digests: { sha256: 'abc' },
        headers: { etag: '"one"' },
        responseUrl: 'https://example.com/app.js',
        status: 200,
        wroteFile: true,
      })
    );
    const cache = cacheObject({ download: nativeDownload });
    const adapter = createNitroCacheAdapter(cache);

    await expect(
      adapter.download({
        followRedirect: false,
        hashAlgorithms: ['sha256'],
        headers: { 'If-None-Match': '"one"' },
        maxBytes: 1024,
        overwrite: true,
        path: '/documents/app.js',
        timeoutMs: 5000,
        url: 'https://example.com/app.js',
      })
    ).resolves.toEqual({
      bytesWritten: 12,
      digests: { sha256: 'abc' },
      headers: { etag: '"one"' },
      responseUrl: 'https://example.com/app.js',
      status: 200,
      wroteFile: true,
    });

    const request = JSON.parse(nativeDownload.mock.calls[0]![1]) as Record<string, unknown>;
    expect(request).toEqual({
      hashAlgorithms: ['sha256'],
      headers: { 'If-None-Match': '"one"' },
      maxBytes: 1024,
      path: '/documents/app.js',
      timeoutMs: 5000,
      url: 'https://example.com/app.js',
    });
    await expect(adapter.stat('/documents/app.js')).resolves.toEqual({ size: 42 });
    await expect(adapter.hashFile('/documents/app.js', ['sha256'])).resolves.toEqual({
      sha256: 'abc',
    });
  });

  it('cancels the cache transfer and reports AbortError', async () => {
    let rejectNative!: (error: Error) => void;
    const cancelDownload = vi.fn<LocalWebViewCache['cancelDownload']>();
    const cache = cacheObject({
      cancelDownload,
      download: vi.fn<LocalWebViewCache['download']>(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectNative = reject;
          })
      ),
    });
    const adapter = createNitroCacheAdapter(cache);
    const controller = new AbortController();
    const download = adapter.download({
      followRedirect: false,
      overwrite: true,
      path: '/documents/app.js',
      signal: controller.signal,
      timeoutMs: 5000,
      url: 'https://example.com/app.js',
    });

    controller.abort();
    rejectNative(new Error('cancelled natively'));

    await expect(download).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelDownload).toHaveBeenCalledOnce();
  });

  it('restores the typed byte-limit error rejected by the cache object', async () => {
    const cache = cacheObject({
      download: vi.fn<LocalWebViewCache['download']>(async () => {
        throw new Error('LOCAL_WEBVIEW_DOWNLOAD_LIMIT|100|101|https://example.com/payload.data');
      }),
    });
    const adapter = createNitroCacheAdapter(cache);

    await expect(
      adapter.download({
        followRedirect: false,
        maxBytes: 100,
        overwrite: true,
        path: '/documents/payload.data',
        timeoutMs: 5000,
        url: 'https://example.com/payload.data',
      })
    ).rejects.toEqual(
      new LocalWebViewDownloadLimitError('https://example.com/payload.data', 100, 101)
    );
  });
});
