import { fromByteArray, toByteArray } from 'base64-js';
import { describe, expect, it, vi } from 'vitest';

import {
  createExpoFileSystemCacheAdapter,
  createReactNativeBlobUtilCacheAdapter,
  createReactNativeFileAccessCacheAdapter,
  createReactNativeFsCacheAdapter,
  type ExpoFileSystemLike,
  type ReactNativeBlobUtilLike,
  type ReactNativeFileAccessLike,
  type ReactNativeFsLike,
} from '../src/cacheAdapterPresets';
import type { LocalWebViewCacheAdapter } from '../src/localWebViewCacheAdapter';

const download = vi.fn<LocalWebViewCacheAdapter['download']>(async (options) => ({
  responseUrl: options.url,
  status: 200,
}));

describe('cache adapter presets', () => {
  it('maps the object-oriented expo-file-system API and incremental hashing', async () => {
    const files = new Map<string, Uint8Array>([
      ['file:///documents/source', new TextEncoder().encode('hello')],
    ]);
    const directories = new Set(['file:///documents', 'file:///documents/cache']);

    class File {
      readonly uri: string;

      constructor(uri: string) {
        this.uri = uri;
      }

      async base64() {
        return fromByteArray(files.get(this.uri)!);
      }

      async copy(destination: File) {
        files.set(destination.uri, files.get(this.uri)!.slice());
      }

      delete() {
        files.delete(this.uri);
      }

      async move(destination: File) {
        files.set(destination.uri, files.get(this.uri)!);
        files.delete(this.uri);
      }

      open() {
        const bytes = files.get(this.uri)!;
        return {
          close() {},
          offset: 0,
          readBytes(length: number) {
            const result = bytes.slice(this.offset, this.offset + length);
            this.offset += result.byteLength;
            return result;
          },
        };
      }

      get size() {
        return files.get(this.uri)?.byteLength ?? 0;
      }

      async text() {
        return new TextDecoder().decode(files.get(this.uri)!);
      }

      write(value: string, options: { encoding: string }) {
        files.set(
          this.uri,
          options.encoding === 'base64' ? toByteArray(value) : new TextEncoder().encode(value)
        );
      }
    }

    class Directory {
      readonly uri: string;

      constructor(uri: string) {
        this.uri = uri;
      }

      create() {
        directories.add(this.uri);
      }

      delete() {
        directories.delete(this.uri);
        for (const path of [...files.keys()]) {
          if (path.startsWith(`${this.uri}/`)) files.delete(path);
        }
      }

      list() {
        const prefix = `${this.uri}/`;
        return [...files.keys()]
          .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
          .map((path) => ({ name: path.slice(prefix.length) }));
      }

      get size() {
        return 0;
      }
    }

    const expoFileSystem = {
      Directory,
      File,
      Paths: {
        document: { uri: 'file:///documents/' },
        info(path: string) {
          return {
            exists: files.has(path) || directories.has(path),
            isDirectory: directories.has(path) ? true : files.has(path) ? false : null,
          };
        },
      },
    } satisfies ExpoFileSystemLike;
    const cacheAdapter = createExpoFileSystemCacheAdapter(expoFileSystem, { download });

    expect(cacheAdapter.directories.documents).toBe('file:///documents');
    await expect(
      cacheAdapter.readFileRange('file:///documents/source', 1, 4, 'utf8')
    ).resolves.toBe('ell');
    await expect(cacheAdapter.hashFile('file:///documents/source', ['sha256'])).resolves.toEqual({
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    await cacheAdapter.copyFile('file:///documents/source', 'file:///documents/copy');
    await expect(cacheAdapter.listDirectory('file:///documents')).resolves.toEqual([
      'source',
      'copy',
    ]);
    await cacheAdapter.remove('file:///documents/cache');
    expect(directories.has('file:///documents/cache')).toBe(false);
  });

  it('maps react-native-fs positional reads and native hashes', async () => {
    const reads: unknown[][] = [];
    const hashes: unknown[][] = [];
    const mkdir = vi.fn<() => Promise<void>>(async () => {});
    const fileSystem: ReactNativeFsLike = {
      DocumentDirectoryPath: '/rnfs/documents',
      async copyFile() {},
      async exists() {
        return true;
      },
      async hash(path, algorithm) {
        hashes.push([path, algorithm]);
        return `${algorithm}-digest`;
      },
      mkdir,
      async moveFile() {},
      async read(path, length, position, encoding) {
        reads.push([path, length, position, encoding]);
        return 'cmFuZ2U=';
      },
      async readFile() {
        return 'whole';
      },
      async readdir() {
        return ['child'];
      },
      async stat() {
        return { size: 5 };
      },
      async unlink() {},
      async writeFile() {},
    };
    const cacheAdapter = createReactNativeFsCacheAdapter(fileSystem, { download });

    await expect(cacheAdapter.readFileRange('/file', 4, 9, 'base64')).resolves.toBe('cmFuZ2U=');
    await expect(cacheAdapter.hashFile('/file', ['sha256', 'sha512'])).resolves.toEqual({
      sha256: 'sha256-digest',
      sha512: 'sha512-digest',
    });
    expect(cacheAdapter.directories.documents).toBe('/rnfs/documents');
    expect(reads).toEqual([['/file', 5, 4, 'base64']]);
    expect(hashes).toEqual([
      ['/file', 'sha256'],
      ['/file', 'sha512'],
    ]);
    await cacheAdapter.makeDirectory('/existing');
    expect(mkdir).not.toHaveBeenCalled();
    await expect(cacheAdapter.remove('/undeletable')).rejects.toThrow(
      'Failed to remove /undeletable'
    );
  });

  it('maps react-native-file-access chunk reads and hash names', async () => {
    const reads: unknown[][] = [];
    const hashes: unknown[][] = [];
    const mkdir = vi.fn<() => Promise<void>>(async () => {});
    const module: ReactNativeFileAccessLike = {
      Dirs: { DocumentDir: '/file-access/documents' },
      FileSystem: {
        async cp() {},
        async exists() {
          return true;
        },
        async hash(path, algorithm) {
          hashes.push([path, algorithm]);
          return `${algorithm}-digest`;
        },
        async ls() {
          return [];
        },
        mkdir,
        async mv() {},
        async readFile() {
          return 'whole';
        },
        async readFileChunk(path, offset, length, encoding) {
          reads.push([path, offset, length, encoding]);
          return 'cmFuZ2U=';
        },
        async stat() {
          return { size: 5 };
        },
        async unlink() {},
        async writeFile() {},
      },
    };
    const cacheAdapter = createReactNativeFileAccessCacheAdapter(module, { download });

    await cacheAdapter.readFileRange('/file', 4, 9, 'base64');
    await expect(cacheAdapter.hashFile('/file', ['sha384'])).resolves.toEqual({
      sha384: 'SHA-384-digest',
    });
    expect(cacheAdapter.directories.documents).toBe('/file-access/documents');
    expect(reads).toEqual([['/file', 4, 5, 'base64']]);
    expect(hashes).toEqual([['/file', 'SHA-384']]);
    await cacheAdapter.makeDirectory('/existing');
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('provides a complete react-native-blob-util cache adapter without a peer dependency', async () => {
    const files = new Map<string, Uint8Array>([
      ['/blob/documents/file', new TextEncoder().encode('hello')],
    ]);
    const configurations: unknown[] = [];
    const progressConfigurations: unknown[] = [];
    const requests: unknown[] = [];
    const cancel = vi.fn<() => void>();
    let progress = { received: 2, total: 2 };
    let redirects = ['https://app.example/asset', 'https://app.example/asset'];
    let responseHeaders: Record<string, string> = {
      'Content-Length': '2',
      'ETag': '"asset"',
    };
    let responseStatus = 200;
    const mkdir = vi.fn<() => Promise<void>>(async () => {});
    const response = {
      info: () => ({
        headers: responseHeaders,
        redirects,
        status: responseStatus,
      }),
    };
    const task = Object.assign(Promise.resolve(response), {
      cancel,
      progress(config: { interval: number }, callback: (received: number, total: number) => void) {
        progressConfigurations.push(config);
        callback(progress.received, progress.total);
        return task;
      },
      stateChange(callback: (info: ReturnType<typeof response.info>) => void) {
        callback(response.info());
        return task;
      },
    });
    const blobUtil: ReactNativeBlobUtilLike = {
      config(options) {
        configurations.push(options);
        return {
          fetch(method, url, headers) {
            requests.push([method, url, headers]);
            return task;
          },
        };
      },
      fs: {
        async cp(source, destination) {
          files.set(destination, files.get(source)!);
        },
        dirs: {
          CacheDir: '/blob/cache',
          DocumentDir: '/blob/documents',
        },
        async exists(path) {
          return path === '/blob/documents' || files.has(path);
        },
        async hash(_path, algorithm) {
          return `${algorithm}-digest`;
        },
        async ls() {
          return [];
        },
        mkdir,
        async mv(source, destination) {
          files.set(destination, files.get(source)!);
          files.delete(source);
        },
        async readFile(path, encoding) {
          const bytes = files.get(path)!;
          return encoding === 'base64' ? fromByteArray(bytes) : new TextDecoder().decode(bytes);
        },
        async slice(source, destination, start, end) {
          files.set(destination, files.get(source)!.slice(start, end));
        },
        async stat(path) {
          return { size: files.get(path)?.byteLength ?? 2 };
        },
        async unlink(path) {
          files.delete(path);
        },
        async writeFile(path, value, encoding) {
          files.set(
            path,
            encoding === 'base64' ? toByteArray(value) : new TextEncoder().encode(value)
          );
        },
      },
    };
    const cacheAdapter = createReactNativeBlobUtilCacheAdapter(blobUtil);

    await expect(cacheAdapter.readFileRange('/blob/documents/file', 1, 4, 'utf8')).resolves.toBe(
      'ell'
    );
    expect([...files.keys()]).toEqual(['/blob/documents/file']);
    await expect(
      cacheAdapter.download({
        followRedirect: false,
        maxBytes: 10,
        overwrite: true,
        path: '/blob/documents/download',
        timeoutMs: 5_000,
        url: 'https://app.example/asset',
      })
    ).resolves.toEqual({
      headers: { 'Content-Length': '2', 'ETag': '"asset"' },
      responseUrl: 'https://app.example/asset',
      status: 200,
    });
    expect(configurations.at(-1)).toEqual({
      followRedirect: false,
      overwrite: true,
      path: '/blob/documents/download',
      timeout: 5_000,
    });
    expect(progressConfigurations.at(-1)).toEqual({ interval: 1 });
    expect(requests.at(-1)).toEqual([
      'GET',
      'https://app.example/asset',
      {
        'Accept-Encoding': 'identity',
        'Range': 'bytes=0-10',
      },
    ]);
    await cacheAdapter.makeDirectory('/blob/documents');
    expect(mkdir).not.toHaveBeenCalled();

    redirects = ['https://app.example/range'];
    responseHeaders = {
      'Content-Length': '2',
      'Content-Range': 'bytes 0-1/2',
      'ETag': '"asset"',
    };
    responseStatus = 206;
    await expect(
      cacheAdapter.download({
        followRedirect: false,
        maxBytes: 10,
        overwrite: true,
        path: '/blob/documents/download',
        timeoutMs: 5_000,
        url: 'https://app.example/range',
      })
    ).resolves.toMatchObject({ status: 200 });

    redirects = ['https://app.example/incomplete-range'];
    responseHeaders = {
      'Content-Length': '2',
      'Content-Range': 'bytes 1-2/2',
      'ETag': '"asset"',
    };
    responseStatus = 206;
    await expect(
      cacheAdapter.download({
        followRedirect: false,
        maxBytes: 10,
        overwrite: true,
        path: '/blob/documents/download',
        timeoutMs: 5_000,
        url: 'https://app.example/incomplete-range',
      })
    ).rejects.toThrow('Invalid Content-Range');
    expect(cancel).toHaveBeenCalledOnce();
    cancel.mockClear();

    redirects = ['https://app.example/unknown-length'];
    responseHeaders = { ETag: '"asset"' };
    responseStatus = 200;
    await expect(
      cacheAdapter.download({
        followRedirect: false,
        maxBytes: 10,
        overwrite: true,
        path: '/blob/documents/download',
        timeoutMs: 5_000,
        url: 'https://app.example/unknown-length',
      })
    ).rejects.toThrow('ignored the bounded Range request without a Content-Length');
    expect(cancel).toHaveBeenCalledOnce();
    cancel.mockClear();

    redirects = ['https://app.example/redirect'];
    responseHeaders = { Location: '/next' };
    responseStatus = 302;
    await expect(
      cacheAdapter.download({
        followRedirect: false,
        maxBytes: 10,
        overwrite: true,
        path: '/blob/documents/download',
        timeoutMs: 5_000,
        url: 'https://app.example/redirect',
      })
    ).resolves.toEqual({
      headers: { Location: '/next' },
      responseUrl: 'https://app.example/redirect',
      status: 302,
    });
    expect(cancel).toHaveBeenCalledOnce();
    cancel.mockClear();

    redirects = ['https://app.example/unchanged'];
    responseHeaders = { ETag: '"unchanged"' };
    responseStatus = 304;
    await expect(
      cacheAdapter.download({
        followRedirect: false,
        maxBytes: 10,
        overwrite: true,
        path: '/blob/documents/download',
        timeoutMs: 5_000,
        url: 'https://app.example/unchanged',
      })
    ).resolves.toEqual({
      headers: { ETag: '"unchanged"' },
      responseUrl: 'https://app.example/unchanged',
      status: 304,
    });
    expect(cancel).not.toHaveBeenCalled();

    redirects = ['https://app.example/asset', 'https://redirected.example/asset'];
    await expect(
      cacheAdapter.download({
        followRedirect: false,
        maxBytes: 10,
        overwrite: true,
        path: '/blob/documents/download',
        timeoutMs: 5_000,
        url: 'https://app.example/asset',
      })
    ).rejects.toThrow('react-native-blob-util followed a redirect');
    redirects = ['https://app.example/large'];
    responseHeaders = { 'Content-Length': '2', 'ETag': '"asset"' };
    responseStatus = 200;

    progress = { received: 4, total: 10 };
    await expect(
      cacheAdapter.download({
        followRedirect: false,
        maxBytes: 3,
        overwrite: true,
        path: '/blob/documents/download',
        timeoutMs: 5_000,
        url: 'https://app.example/large',
      })
    ).rejects.toThrow('Download exceeded maxBytes=3');
    expect(cancel).toHaveBeenCalledOnce();

    const interruptedInfo = {
      headers: {
        'Content-Length': '2',
        'Content-Range': 'bytes 0-1/2',
        'ETag': '"interrupted"',
      },
      redirects: ['https://app.example/interrupted'],
      status: 206,
    };
    let interruptedTask: ReturnType<ReturnType<ReactNativeBlobUtilLike['config']>['fetch']>;
    interruptedTask = Object.assign(
      new Promise<typeof response>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Download interrupted.')), 0);
      }),
      {
        cancel() {},
        progress() {
          return interruptedTask;
        },
        stateChange(callback: (info: typeof interruptedInfo) => void) {
          callback(interruptedInfo);
          return interruptedTask;
        },
      }
    );
    const interruptedAdapter = createReactNativeBlobUtilCacheAdapter({
      ...blobUtil,
      config() {
        return {
          fetch() {
            files.set('/blob/documents/interrupted', new Uint8Array([1, 2]));
            return interruptedTask;
          },
        };
      },
    });
    await expect(
      interruptedAdapter.download({
        followRedirect: false,
        maxBytes: 10,
        overwrite: true,
        path: '/blob/documents/interrupted',
        timeoutMs: 5_000,
        url: 'https://app.example/interrupted',
      })
    ).resolves.toEqual({
      headers: interruptedInfo.headers,
      responseUrl: 'https://app.example/interrupted',
      status: 200,
    });

    const retryRequests: Array<Record<string, string> | undefined> = [];
    let retryAttempt = 0;
    const retryAdapter = createReactNativeBlobUtilCacheAdapter({
      ...blobUtil,
      config() {
        return {
          fetch(_method, _url, headers) {
            retryAttempt += 1;
            retryRequests.push(headers);
            const retryInfo = {
              headers: { 'Content-Length': '2', 'ETag': '"retried"' },
              redirects: ['https://app.example/retry'],
              status: 200,
            };
            let retryTask: ReturnType<ReturnType<ReactNativeBlobUtilLike['config']>['fetch']>;
            retryTask = Object.assign(
              retryAttempt === 1
                ? new Promise<typeof response>((_resolve, reject) => {
                    setTimeout(() => reject(new Error('Download interrupted.')), 0);
                  })
                : Promise.resolve({ info: () => retryInfo }),
              {
                cancel() {},
                progress(
                  _config: { interval: number },
                  callback: (received: number, total: number) => void
                ) {
                  callback(retryAttempt === 1 ? 1 : 2, 2);
                  return retryTask;
                },
                stateChange(callback: (info: typeof retryInfo) => void) {
                  if (retryAttempt === 2) callback(retryInfo);
                  return retryTask;
                },
              }
            );
            files.set(
              '/blob/documents/retry',
              retryAttempt === 1 ? new Uint8Array([1]) : new Uint8Array([1, 2])
            );
            return retryTask;
          },
        };
      },
    });
    await expect(
      retryAdapter.download({
        followRedirect: false,
        maxBytes: 10,
        overwrite: true,
        path: '/blob/documents/retry',
        timeoutMs: 5_000,
        url: 'https://app.example/retry',
      })
    ).resolves.toEqual({
      headers: { 'Content-Length': '2', 'ETag': '"retried"' },
      responseUrl: 'https://app.example/retry',
      status: 200,
    });
    expect(retryRequests).toEqual([
      { 'Accept-Encoding': 'identity', 'Range': 'bytes=0-10' },
      { 'Accept-Encoding': 'identity' },
    ]);

    let rejectChunked!: (error: Error) => void;
    const chunkedCancel = vi.fn<() => void>(() => {
      rejectChunked(new Error('native cancellation'));
    });
    const chunkedTask = Object.assign(
      new Promise<typeof response>((_resolve, reject) => {
        rejectChunked = reject;
      }),
      {
        cancel: chunkedCancel,
        progress(
          _config: { interval: number },
          callback: (received: number, total: number) => void
        ) {
          callback(0, -1);
          return chunkedTask;
        },
        stateChange() {
          return chunkedTask;
        },
      }
    );
    let chunkedDownloadStarted = false;
    const chunkedAdapter = createReactNativeBlobUtilCacheAdapter({
      ...blobUtil,
      config() {
        return {
          fetch() {
            chunkedDownloadStarted = true;
            return chunkedTask;
          },
        };
      },
      fs: {
        ...blobUtil.fs,
        async exists(path) {
          return (
            (path === '/blob/documents/chunked' && chunkedDownloadStarted) ||
            blobUtil.fs.exists(path)
          );
        },
        async stat(path) {
          if (path === '/blob/documents/chunked') return { size: 4 };
          return blobUtil.fs.stat(path);
        },
      },
    });

    await expect(
      chunkedAdapter.download({
        followRedirect: false,
        maxBytes: 3,
        overwrite: true,
        path: '/blob/documents/chunked',
        timeoutMs: 5_000,
        url: 'https://app.example/chunked',
      })
    ).rejects.toThrow('Download exceeded maxBytes=3');
    expect(chunkedCancel).toHaveBeenCalledOnce();

    let rejectPending!: (error: Error) => void;
    const timeoutCancel = vi.fn<() => void>(() => {
      rejectPending(new Error('native cancellation'));
    });
    const pendingTask = Object.assign(
      new Promise<typeof response>((_resolve, reject) => {
        rejectPending = reject;
      }),
      {
        cancel: timeoutCancel,
        progress() {
          return pendingTask;
        },
        stateChange() {
          return pendingTask;
        },
      }
    );
    const timedAdapter = createReactNativeBlobUtilCacheAdapter({
      ...blobUtil,
      config() {
        return {
          fetch() {
            return pendingTask;
          },
        };
      },
    });

    await expect(
      timedAdapter.download({
        followRedirect: false,
        overwrite: true,
        path: '/blob/documents/download',
        timeoutMs: 1,
        url: 'https://app.example/slow',
      })
    ).rejects.toThrow('Download timed out after 1ms');
    expect(timeoutCancel).toHaveBeenCalledOnce();
  });
});
