import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { fromByteArray, toByteArray } from 'base64-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalWebViewDownloadLimitError,
  type LocalWebViewCacheAdapter,
} from '../src/localWebViewCacheAdapter';
import type { ResolveWebBundleOptions } from '../src/mirrorWebBundle';

const native = vi.hoisted(() => {
  type Response = {
    body?: string | Uint8Array;
    etag?: string;
    error?: Error;
    headers?: Record<string, string>;
    location?: string;
    mediaType?: string;
    status?: number;
  };

  return {
    blobConfigs: [] as Array<{
      followRedirect?: boolean;
      overwrite?: boolean;
      path?: string;
      timeout?: number;
    }>,
    copies: [] as Array<{ destination: string; source: string }>,
    directories: new Set<string>(['/documents', '/temporary']),
    files: new Map<string, Uint8Array>(),
    moves: [] as Array<{ destination: string; source: string }>,
    requests: [] as Array<{ etag?: string; origin?: string; url: string }>,
    responses: new Map<string, Response>(),
  };
});

import {
  cacheDirectoryForOrigin as cacheDirectoryForOriginWithAdapter,
  readMirroredWebBundle as readMirroredWebBundleWithAdapter,
  retainWebBundle,
  resolveWebBundle as resolveWebBundleWithAdapter,
  rollbackWebBundle as rollbackWebBundleWithAdapter,
} from '../src/mirrorWebBundle';

const ENTRY = 'https://app.example/';
const SCRIPT = 'https://app.example/assets/app.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function removePath(path: string): void {
  native.files.delete(path);
  for (const file of native.files.keys()) {
    if (file.startsWith(`${path}/`)) native.files.delete(file);
  }
  for (const directory of native.directories) {
    if (directory === path || directory.startsWith(`${path}/`)) {
      native.directories.delete(directory);
    }
  }
}

function file(path: string): Uint8Array {
  const value = native.files.get(path);
  if (!value) throw new Error(`Missing file: ${path}`);
  return value;
}

const cacheAdapter: LocalWebViewCacheAdapter = {
  directories: {
    documents: '/documents',
  },
  async copyFile(source, destination) {
    native.copies.push({ destination, source });
    native.files.set(destination, file(source).slice());
  },
  async download(options) {
    if (options.signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    native.blobConfigs.push({
      followRedirect: options.followRedirect,
      overwrite: options.overwrite,
      path: options.path,
      timeout: options.timeoutMs,
    });
    const response = native.responses.get(options.url);
    const etag = options.headers?.['If-None-Match'];
    native.requests.push({
      etag,
      ...(options.headers?.Origin ? { origin: options.headers.Origin } : {}),
      url: options.url,
    });
    if (!response) throw new Error(`No response for ${options.url}`);
    if (response.error) throw response.error;
    const status = etag && response.etag === etag ? 304 : (response.status ?? 200);
    const bytes =
      typeof response.body === 'string'
        ? encoder.encode(response.body)
        : (response.body ?? new Uint8Array()).slice();
    if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes) {
      throw new LocalWebViewDownloadLimitError(options.url, options.maxBytes, bytes.byteLength);
    }
    if (status >= 200 && status < 300) {
      native.files.set(options.path, bytes);
    }
    return {
      headers: {
        'content-type': response.mediaType ?? 'application/octet-stream',
        ...(response.etag ? { etag: response.etag } : {}),
        ...(response.location ? { Location: response.location } : {}),
        ...response.headers,
      },
      responseUrl: options.url,
      status,
    };
  },
  async exists(path) {
    return native.files.has(path) || native.directories.has(path);
  },
  async hashFile(path, algorithms) {
    const value = file(path);
    const implementations = { sha256, sha384, sha512 };
    return Object.fromEntries(
      algorithms.map((algorithm) => [
        algorithm,
        Array.from(implementations[algorithm](value), (byte) =>
          byte.toString(16).padStart(2, '0')
        ).join(''),
      ])
    );
  },
  async listDirectory(path) {
    const children = new Set<string>();
    const prefix = `${path}/`;
    for (const candidate of [...native.directories, ...native.files.keys()]) {
      if (!candidate.startsWith(prefix)) continue;
      const child = candidate.slice(prefix.length).split('/')[0];
      if (child) children.add(child);
    }
    return [...children];
  },
  async makeDirectory(path) {
    native.directories.add(path);
  },
  async moveFile(source, destination) {
    native.moves.push({ destination, source });
    native.files.set(destination, file(source));
    native.files.delete(source);
  },
  async readFile(path, encoding) {
    const value = file(path);
    return encoding === 'base64' ? fromByteArray(value) : decoder.decode(value);
  },
  async readFileRange(path, start, end, encoding) {
    const value = file(path).slice(start, end);
    return encoding === 'base64' ? fromByteArray(value) : decoder.decode(value);
  },
  async remove(path) {
    removePath(path);
  },
  async stat(path) {
    return { size: file(path).byteLength };
  },
  async writeFile(path, value, encoding) {
    native.files.set(path, encoding === 'base64' ? toByteArray(value) : encoder.encode(value));
  },
};

function cacheDirectoryForOrigin(virtualUrl: string): string {
  return cacheDirectoryForOriginWithAdapter(virtualUrl, cacheAdapter);
}

function readMirroredWebBundle(source: string): Promise<string> {
  return readMirroredWebBundleWithAdapter(source, cacheAdapter);
}

function resolveWebBundle(
  options: Omit<ResolveWebBundleOptions, 'cacheAdapter'>
): ReturnType<typeof resolveWebBundleWithAdapter> {
  return resolveWebBundleWithAdapter({ ...options, cacheAdapter });
}

function rollbackWebBundle(
  cacheDirectory: string,
  currentGenerationId?: string,
  requestedUrl?: string
): ReturnType<typeof rollbackWebBundleWithAdapter> {
  return rollbackWebBundleWithAdapter(
    cacheDirectory,
    cacheAdapter,
    currentGenerationId,
    requestedUrl
  );
}

function serve(version: string): void {
  native.responses.set(ENTRY, {
    body: '<!doctype html><script type="module" src="/assets/app.js"></script>',
    etag: '"entry-1"',
    mediaType: 'text/html',
  });
  native.responses.set(SCRIPT, {
    body: `document.body.dataset.version = ${JSON.stringify(version)}`,
    etag: `"script-${version}"`,
    mediaType: 'text/javascript',
  });
}

beforeEach(() => {
  native.directories.clear();
  native.directories.add('/documents');
  native.directories.add('/temporary');
  native.files.clear();
  native.blobConfigs.length = 0;
  native.copies.length = 0;
  native.moves.length = 0;
  native.requests.length = 0;
  native.responses.clear();
  serve('one');
});

describe('resolveWebBundle', () => {
  it('commits a complete origin-scoped generation', async () => {
    const progress: string[] = [];
    const bundle = await resolveWebBundle({
      onProgress: (message) => progress.push(message),
      virtualUrl: ENTRY,
    });

    expect(cacheDirectoryForOrigin(ENTRY)).toBe(
      '/documents/local-webview/2bf585a6f689247104c31bb9cf683e2c8be97bfe0cb266d49c4ef99c81ebbdd6'
    );
    expect(bundle.usedCachedBundle).toBe(false);
    expect(bundle.downloadedAssets).toEqual([ENTRY, SCRIPT]);
    expect(await readMirroredWebBundle(bundle.sourcePath)).toContain(
      'document.body.dataset.version'
    );
    expect(progress.at(-1)).toContain('Committing');
  });

  it('isolates origins that collide under filename character replacement', async () => {
    const ipv6Entry = 'https://[2606:4700:4700::1111]/';
    const underscoreEntry = 'https://_2606_4700_4700__1111_/';
    native.responses.set(ipv6Entry, {
      body: '<!doctype html><html><head></head><body>ipv6</body></html>',
      mediaType: 'text/html',
    });
    native.responses.set(underscoreEntry, {
      body: '<!doctype html><html><head></head><body>underscore</body></html>',
      mediaType: 'text/html',
    });

    const ipv6 = await resolveWebBundle({
      cachePolicy: { maxGenerations: 1 },
      virtualUrl: ipv6Entry,
    });
    const underscore = await resolveWebBundle({
      cachePolicy: { maxGenerations: 1 },
      virtualUrl: underscoreEntry,
    });

    expect(cacheDirectoryForOrigin(ipv6Entry)).not.toBe(cacheDirectoryForOrigin(underscoreEntry));
    await expect(readMirroredWebBundle(ipv6.sourcePath)).resolves.toContain('ipv6');
    await expect(readMirroredWebBundle(underscore.sourcePath)).resolves.toContain('underscore');
  });

  it('removes orphaned generations from an obsolete cache format', async () => {
    const cacheDirectory = cacheDirectoryForOrigin(ENTRY);
    const obsoleteDirectory = `${cacheDirectory}/generations/obsolete`;
    native.directories.add(`${cacheDirectory}/generations`);
    native.directories.add(obsoleteDirectory);
    native.files.set(
      `${cacheDirectory}/state.json`,
      new TextEncoder().encode(
        JSON.stringify({
          activeGeneration: 'obsolete',
          formatVersion: 3,
          generations: [],
        })
      )
    );
    native.files.set(`${obsoleteDirectory}/index.html`, new TextEncoder().encode('obsolete'));

    await resolveWebBundle({ virtualUrl: ENTRY });

    expect(native.files.has(`${obsoleteDirectory}/index.html`)).toBe(false);
  });

  it('revalidates every asset with its own ETag and reuses an unchanged generation', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    native.requests.length = 0;

    const second = await resolveWebBundle({ virtualUrl: ENTRY });

    expect(second).toMatchObject({
      generationId: first.generationId,
      usedCachedBundle: true,
    });
    expect(native.requests).toEqual(
      expect.arrayContaining([
        { etag: '"entry-1"', url: ENTRY },
        { etag: '"script-one"', url: SCRIPT },
      ])
    );
  });

  it('uses native response metadata without stat or empty-file cleanup round trips', async () => {
    let temporaryExistsCalls = 0;
    let temporaryHashCalls = 0;
    let temporaryRemoveCalls = 0;
    let temporaryStatCalls = 0;
    const isTemporaryDownload = (path: string): boolean => path.includes('/staging/download-');
    const metadataAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async download(options) {
        const result = await cacheAdapter.download(options);
        const wroteFile =
          result.status >= 200 && result.status < 300 && native.files.has(options.path);
        return {
          ...result,
          bytesWritten: wroteFile ? file(options.path).byteLength : 0,
          digests: wroteFile
            ? await cacheAdapter.hashFile(options.path, options.hashAlgorithms ?? [])
            : undefined,
          wroteFile,
        };
      },
      async exists(path) {
        if (isTemporaryDownload(path)) temporaryExistsCalls += 1;
        return cacheAdapter.exists(path);
      },
      async remove(path) {
        if (isTemporaryDownload(path)) temporaryRemoveCalls += 1;
        return cacheAdapter.remove(path);
      },
      async hashFile(path, algorithms) {
        if (isTemporaryDownload(path)) temporaryHashCalls += 1;
        return cacheAdapter.hashFile(path, algorithms);
      },
      async stat(path) {
        if (isTemporaryDownload(path)) temporaryStatCalls += 1;
        return cacheAdapter.stat(path);
      },
    };
    const first = await resolveWebBundleWithAdapter({
      cacheAdapter: metadataAdapter,
      virtualUrl: ENTRY,
    });
    expect(temporaryHashCalls).toBe(0);
    expect(temporaryStatCalls).toBe(0);
    temporaryExistsCalls = 0;
    temporaryHashCalls = 0;
    temporaryRemoveCalls = 0;
    temporaryStatCalls = 0;

    const second = await resolveWebBundleWithAdapter({
      cacheAdapter: metadataAdapter,
      virtualUrl: ENTRY,
    });

    expect(second.generationId).toBe(first.generationId);
    expect({
      exists: temporaryExistsCalls,
      hash: temporaryHashCalls,
      remove: temporaryRemoveCalls,
      stat: temporaryStatCalls,
    }).toEqual({ exists: 0, hash: 0, remove: 0, stat: 0 });
  });

  it('keeps a bodyless successful response as an empty resource', async () => {
    native.responses.set(SCRIPT, {
      etag: '"empty-script"',
      mediaType: 'text/javascript',
      status: 204,
    });

    const bundle = await resolveWebBundle({ virtualUrl: ENTRY });

    expect(bundle.downloadedAssets).toContain(SCRIPT);
    await expect(readMirroredWebBundle(bundle.sourcePath)).resolves.toContain(
      'data:text/javascript;charset=utf-8,'
    );
  });

  it('revalidates unchanged resources concurrently', async () => {
    const assetUrls = Array.from(
      { length: 6 },
      (_, index) => `https://app.example/assets/concurrent-${index}.png`
    );
    native.responses.set(ENTRY, {
      body: `<!doctype html>${assetUrls.map((url) => `<img src="${url}">`).join('')}`,
      etag: '"entry-concurrent"',
      mediaType: 'text/html',
    });
    for (const url of assetUrls) {
      native.responses.set(url, {
        body: new Uint8Array([1]),
        etag: `"${url}"`,
        mediaType: 'image/png',
      });
    }
    await resolveWebBundle({ virtualUrl: ENTRY });

    let activeRevalidations = 0;
    let peakRevalidations = 0;
    let releaseRevalidations!: () => void;
    const revalidationGate = new Promise<void>((resolve) => {
      releaseRevalidations = resolve;
    });
    const concurrentAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async download(options) {
        if (options.headers?.['If-None-Match']) {
          activeRevalidations += 1;
          peakRevalidations = Math.max(peakRevalidations, activeRevalidations);
          await revalidationGate;
          activeRevalidations -= 1;
        }
        return cacheAdapter.download(options);
      },
    };

    const revalidation = resolveWebBundleWithAdapter({
      cacheAdapter: concurrentAdapter,
      virtualUrl: ENTRY,
    });
    await vi.waitFor(() => {
      expect(peakRevalidations).toBe(6);
    });
    releaseRevalidations();
    await revalidation;

    expect(peakRevalidations).toBe(6);
  });

  it('hashes each cached generation file only once while reconciling and reading it', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    const generationPath = `/generations/${first.generationId}/`;
    const cachedHashCalls = new Map<string, number>();
    const observedAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async hashFile(path, algorithms) {
        if (path.includes(generationPath)) {
          cachedHashCalls.set(path, (cachedHashCalls.get(path) ?? 0) + 1);
        }
        return cacheAdapter.hashFile(path, algorithms);
      },
    };

    const second = await resolveWebBundleWithAdapter({
      cacheAdapter: observedAdapter,
      virtualUrl: ENTRY,
    });

    expect(second.generationId).toBe(first.generationId);
    expect([...cachedHashCalls.values()]).not.toHaveLength(0);
    expect([...cachedHashCalls.values()].every((count) => count === 1)).toBe(true);
  });

  it('does not hash the old generation when a forced refresh succeeds', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    const generationPath = `/generations/${first.generationId}/`;
    const oldGenerationHashes: string[] = [];
    const observedAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async hashFile(path, algorithms) {
        if (path.includes(generationPath)) oldGenerationHashes.push(path);
        return cacheAdapter.hashFile(path, algorithms);
      },
    };
    serve('two');

    const refreshed = await resolveWebBundleWithAdapter({
      cacheAdapter: observedAdapter,
      forceRefresh: true,
      virtualUrl: ENTRY,
    });

    expect(refreshed.generationId).not.toBe(first.generationId);
    expect(oldGenerationHashes).toEqual([]);
  });

  it('validates the old generation before using it after a forced refresh fails', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    const generationPath = `/generations/${first.generationId}/`;
    const oldGenerationHashes = new Map<string, number>();
    const observedAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async hashFile(path, algorithms) {
        if (path.includes(generationPath)) {
          oldGenerationHashes.set(path, (oldGenerationHashes.get(path) ?? 0) + 1);
        }
        return cacheAdapter.hashFile(path, algorithms);
      },
    };
    native.responses.set(ENTRY, { error: new Error('offline') });

    const fallback = await resolveWebBundleWithAdapter({
      cacheAdapter: observedAdapter,
      forceRefresh: true,
      virtualUrl: ENTRY,
    });

    expect(fallback.generationId).toBe(first.generationId);
    expect([...oldGenerationHashes.values()]).not.toHaveLength(0);
    expect([...oldGenerationHashes.values()].every((count) => count === 1)).toBe(true);
  });

  it('does not prune a valid fallback before a forced refresh succeeds', async () => {
    const good = await resolveWebBundle({ virtualUrl: ENTRY });
    serve('two');
    const corrupt = await resolveWebBundle({ virtualUrl: ENTRY });
    native.files.set(corrupt.sourcePath, encoder.encode('corrupt active generation'));
    native.responses.set(ENTRY, { error: new Error('offline') });

    const fallback = await resolveWebBundle({
      cachePolicy: { maxGenerations: 1 },
      forceRefresh: true,
      virtualUrl: ENTRY,
    });

    expect(fallback.generationId).toBe(good.generationId);
    expect(native.files.has(good.sourcePath)).toBe(true);
    expect(native.files.has(corrupt.sourcePath)).toBe(false);
  });

  it('uses only a verified generation within the current byte policy after a forced refresh fails', async () => {
    const smaller = await resolveWebBundle({ virtualUrl: ENTRY });
    serve('x'.repeat(2048));
    const oversized = await resolveWebBundle({ virtualUrl: ENTRY });
    expect(oversized.totalBytes).toBeGreaterThan(smaller.totalBytes);
    native.responses.set(ENTRY, { error: new Error('offline') });

    const fallback = await resolveWebBundle({
      cachePolicy: { maxBytes: oversized.totalBytes - 1 },
      forceRefresh: true,
      virtualUrl: ENTRY,
    });

    expect(fallback.generationId).toBe(smaller.generationId);
    expect(fallback.totalBytes).toBeLessThanOrEqual(oversized.totalBytes - 1);
    expect(native.files.has(oversized.sourcePath)).toBe(false);
  });

  it('publishes a stricter generation limit after a forced refresh fails', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    serve('two');
    const second = await resolveWebBundle({ virtualUrl: ENTRY });
    serve('three');
    const active = await resolveWebBundle({ virtualUrl: ENTRY });
    native.responses.set(ENTRY, { error: new Error('offline') });

    const fallback = await resolveWebBundle({
      cachePolicy: { maxGenerations: 1 },
      forceRefresh: true,
      virtualUrl: ENTRY,
    });

    expect(fallback.generationId).toBe(active.generationId);
    await expect(readMirroredWebBundle(first.sourcePath)).rejects.toThrow('Missing file');
    await expect(readMirroredWebBundle(second.sourcePath)).rejects.toThrow('Missing file');
    const state = JSON.parse(
      decoder.decode(native.files.get(`${cacheDirectoryForOrigin(ENTRY)}/state.json`)!)
    ) as { generations: Array<{ generationId: string }> };
    expect(state.generations.map(({ generationId }) => generationId)).toEqual([
      active.generationId,
    ]);
  });

  it('removes an unreferenced generation before a forced refresh', async () => {
    await resolveWebBundle({ virtualUrl: ENTRY });
    const cacheDirectory = cacheDirectoryForOrigin(ENTRY);
    const orphanDirectory = `${cacheDirectory}/generations/orphan`;
    native.directories.add(orphanDirectory);
    native.files.set(`${orphanDirectory}/large.data`, new Uint8Array(1024));
    serve('two');

    await resolveWebBundle({
      forceRefresh: true,
      virtualUrl: ENTRY,
    });

    expect(native.files.has(`${orphanDirectory}/large.data`)).toBe(false);
    expect(native.directories.has(orphanDirectory)).toBe(false);
  });

  it('requests identity transfer encoding without dropping conditional headers', async () => {
    const observedHeaders: Array<Record<string, string> | undefined> = [];
    const observedAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async download(options) {
        observedHeaders.push(options.headers);
        return cacheAdapter.download(options);
      },
    };

    await resolveWebBundleWithAdapter({
      cacheAdapter: observedAdapter,
      virtualUrl: ENTRY,
    });
    await resolveWebBundleWithAdapter({
      cacheAdapter: observedAdapter,
      virtualUrl: ENTRY,
    });

    expect(observedHeaders.length).toBeGreaterThan(2);
    expect(observedHeaders.every((headers) => headers?.['Accept-Encoding'] === 'identity')).toBe(
      true
    );
    expect(
      observedHeaders.some(
        (headers) =>
          headers?.['Accept-Encoding'] === 'identity' &&
          typeof headers['If-None-Match'] === 'string'
      )
    ).toBe(true);
  });

  it('reuses fragmentless cache resources while composing the current hash route', async () => {
    const firstUrl = `${ENTRY}#/books/42`;
    const first = await resolveWebBundle({ virtualUrl: firstUrl });
    const manifest = JSON.parse(
      decoder.decode(file(first.sourcePath.replace('/index.html', '/manifest.json')))
    ) as {
      documentFragmentInherited?: boolean;
      documentUrl?: string;
      entryUrl?: string;
    };
    native.requests.length = 0;

    const secondUrl = `${ENTRY}#/books/99`;
    const second = await resolveWebBundle({ virtualUrl: secondUrl });

    expect(first.baseUrl).toBe(firstUrl);
    expect(second).toMatchObject({
      baseUrl: secondUrl,
      generationId: first.generationId,
      usedCachedBundle: true,
    });
    expect(first.downloadedAssets).toEqual([ENTRY, SCRIPT]);
    expect(manifest).toMatchObject({
      documentFragmentInherited: true,
      documentUrl: ENTRY,
      entryUrl: ENTRY,
    });
    expect(native.requests).toEqual(
      expect.arrayContaining([
        { etag: '"entry-1"', url: ENTRY },
        { etag: '"script-one"', url: SCRIPT },
      ])
    );
    expect(native.requests.every((request) => !request.url.includes('#'))).toBe(true);
  });

  it.each([
    {
      expectedFirst: 'https://app.example/releases/index.html#/books/42',
      expectedSecond: 'https://app.example/releases/index.html#/books/99',
      firstLocation: '/intermediate',
      name: 'inherits the requested fragment through redirects that omit one',
    },
    {
      expectedFirst: 'https://app.example/releases/index.html#server-route',
      expectedSecond: 'https://app.example/releases/index.html#server-route',
      firstLocation: '/intermediate#server-route',
      name: 'retains a redirect-provided fragment through later redirects that omit one',
    },
  ])('$name', async ({ expectedFirst, expectedSecond, firstLocation }) => {
    const intermediateUrl = 'https://app.example/intermediate';
    const documentUrl = 'https://app.example/releases/index.html';
    native.responses.set(ENTRY, {
      location: firstLocation,
      status: 302,
    });
    native.responses.set(intermediateUrl, {
      location: '/releases/index.html',
      status: 302,
    });
    native.responses.set(documentUrl, {
      body: '<!doctype html><html><head></head><body>redirected</body></html>',
      etag: '"redirected-entry"',
      mediaType: 'text/html',
    });

    const first = await resolveWebBundle({ virtualUrl: `${ENTRY}#/books/42` });
    native.requests.length = 0;
    const second = await resolveWebBundle({ virtualUrl: `${ENTRY}#/books/99` });

    expect(first.baseUrl).toBe(expectedFirst);
    expect(second).toMatchObject({
      baseUrl: expectedSecond,
      generationId: first.generationId,
      usedCachedBundle: true,
    });
    expect(native.requests.every((request) => !request.url.includes('#'))).toBe(true);
  });

  it('does not reuse a generation created for another entry on the same origin', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    const secondEntry = 'https://app.example/admin/';
    native.responses.set(secondEntry, {
      body: '<!doctype html><html><head></head><body>admin entry</body></html>',
      etag: '"admin-entry"',
      mediaType: 'text/html',
    });
    native.requests.length = 0;

    const second = await resolveWebBundle({ virtualUrl: secondEntry });

    expect(second.generationId).not.toBe(first.generationId);
    expect(native.requests.some((request) => request.url === secondEntry)).toBe(true);
    expect(await readMirroredWebBundle(second.sourcePath)).toContain('admin entry');
  });

  it('promotes the requested entry before maxGenerations pruning and keeps it available offline', async () => {
    const entryA = 'https://app.example/a/';
    const entryB = 'https://app.example/b/';
    native.responses.set(entryA, {
      body: '<!doctype html><html><head></head><body>entry a</body></html>',
      etag: '"entry-a"',
      mediaType: 'text/html',
    });
    native.responses.set(entryB, {
      body: '<!doctype html><html><head></head><body>entry b</body></html>',
      etag: '"entry-b"',
      mediaType: 'text/html',
    });
    const firstA = await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: entryA,
    });
    const firstB = await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: entryB,
    });
    native.responses.set(entryA, { error: new Error('offline') });

    const offlineA = await resolveWebBundle({
      cachePolicy: { maxGenerations: 1 },
      virtualUrl: entryA,
    });
    const state = JSON.parse(
      decoder.decode(file(`${cacheDirectoryForOrigin(entryA)}/state.json`))
    ) as {
      activeGeneration?: string;
      generations?: Array<{ generationId?: string }>;
    };

    expect(offlineA).toMatchObject({
      baseUrl: entryA,
      generationId: firstA.generationId,
      rollbackAvailable: false,
      usedCachedBundle: true,
    });
    expect(state.activeGeneration).toBe(firstA.generationId);
    expect(state.generations).toEqual([
      {
        createdAt: expect.any(String),
        generationId: firstA.generationId,
        securityPolicyFingerprint: expect.any(String),
        totalBytes: expect.any(Number),
      },
    ]);
    await expect(readMirroredWebBundle(firstA.sourcePath)).resolves.toContain('entry a');
    await expect(readMirroredWebBundle(firstB.sourcePath)).rejects.toThrow('Missing file');
  });

  it('normalizes uppercase hexadecimal hashes from a custom cache adapter', async () => {
    const uppercaseHashAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async hashFile(path, algorithms) {
        return Object.fromEntries(
          Object.entries(await cacheAdapter.hashFile(path, algorithms)).map(
            ([algorithm, digest]) => [algorithm, digest?.toUpperCase()]
          )
        );
      },
    };

    const bundle = await resolveWebBundleWithAdapter({
      cacheAdapter: uppercaseHashAdapter,
      virtualUrl: ENTRY,
    });

    expect(bundle.usedCachedBundle).toBe(false);
    expect(bundle.generationId).toMatch(/-[a-f0-9]{8}-[a-f0-9]{8}$/);
  });

  it('creates a generation when a stable asset URL changes content', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    serve('two');

    const second = await resolveWebBundle({ virtualUrl: ENTRY });

    expect(second.generationId).not.toBe(first.generationId);
    expect(second.rollbackAvailable).toBe(true);
    expect(await readMirroredWebBundle(second.sourcePath)).toContain(
      encodeURIComponent('dataset.version = "two"')
    );
  });

  it('refreshes when an asset ETag changes even if its bytes are identical', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    native.responses.get(SCRIPT)!.etag = '"script-reissued"';

    const second = await resolveWebBundle({ virtualUrl: ENTRY });

    expect(second.generationId).not.toBe(first.generationId);
    expect(
      native.requests.some((request) => request.url === SCRIPT && request.etag === '"script-one"')
    ).toBe(true);
  });

  it('refreshes when a 304 response replaces the stored ETag validator', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    native.responses.get(SCRIPT)!.etag = 'W/"script-one"';
    const weakComparisonAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async download(options) {
        if (options.url === SCRIPT && options.headers?.['If-None-Match'] === '"script-one"') {
          return {
            headers: {
              etag: 'W/"script-one"',
            },
            responseUrl: SCRIPT,
            status: 304,
          };
        }
        return cacheAdapter.download(options);
      },
    };

    const refreshed = await resolveWebBundleWithAdapter({
      cacheAdapter: weakComparisonAdapter,
      virtualUrl: ENTRY,
    });
    native.requests.length = 0;
    await resolveWebBundle({ virtualUrl: ENTRY });

    expect(refreshed.generationId).not.toBe(first.generationId);
    expect(native.requests).toContainEqual({
      etag: 'W/"script-one"',
      url: SCRIPT,
    });
  });

  it('refreshes after a proven change with sibling validators already in flight', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    native.responses.get(ENTRY)!.etag = '"entry-reissued"';
    let siblingStarted = false;
    const cancellingAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async download(options) {
        if (options.url === SCRIPT && options.headers?.['If-None-Match']) {
          siblingStarted = true;
        }
        return cacheAdapter.download(options);
      },
    };

    const refreshed = await resolveWebBundleWithAdapter({
      cacheAdapter: cancellingAdapter,
      virtualUrl: ENTRY,
    });

    expect(siblingStarted).toBe(true);
    expect(refreshed.generationId).not.toBe(first.generationId);
    expect(refreshed.usedCachedBundle).toBe(false);
  });

  it('persists an ETag that appears after the first download', async () => {
    native.responses.get(SCRIPT)!.etag = undefined;
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    native.responses.get(SCRIPT)!.etag = '"script-now-versioned"';

    const refreshed = await resolveWebBundle({ virtualUrl: ENTRY });
    native.requests.length = 0;
    const reused = await resolveWebBundle({ virtualUrl: ENTRY });

    expect(refreshed.generationId).not.toBe(first.generationId);
    expect(reused.generationId).toBe(refreshed.generationId);
    expect(native.requests).toContainEqual({
      etag: '"script-now-versioned"',
      url: SCRIPT,
    });
  });

  it('uses the last verified generation when revalidation is offline', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    native.responses.set(ENTRY, { error: new Error('offline') });

    const second = await resolveWebBundle({ virtualUrl: ENTRY });

    expect(second.generationId).toBe(first.generationId);
    expect(second.usedCachedBundle).toBe(true);
  });

  it('reports a cache miss or verified generation before starting network work', async () => {
    const observations: Array<{
      bundle: string | undefined;
      requests: number;
    }> = [];
    const first = await resolveWebBundle({
      onCachedBundle: (bundle) => {
        observations.push({
          bundle: bundle?.generationId,
          requests: native.requests.length,
        });
      },
      virtualUrl: ENTRY,
    });

    expect(observations).toEqual([{ bundle: undefined, requests: 0 }]);

    native.requests.length = 0;
    await resolveWebBundle({
      onCachedBundle: (bundle) => {
        observations.push({
          bundle: bundle?.generationId,
          requests: native.requests.length,
        });
      },
      virtualUrl: ENTRY,
    });

    expect(observations[1]).toEqual({
      bundle: first.generationId,
      requests: 0,
    });
  });

  it('returns an offline fallback with sibling validators already in flight', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    let scriptStarted = false;
    const delayedAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async download(options) {
        if (options.headers?.['If-None-Match'] && options.url === ENTRY) {
          throw new Error('offline');
        }
        if (options.headers?.['If-None-Match'] && options.url === SCRIPT) {
          scriptStarted = true;
        }
        return cacheAdapter.download(options);
      },
    };
    await expect(
      resolveWebBundleWithAdapter({
        cacheAdapter: delayedAdapter,
        virtualUrl: ENTRY,
      })
    ).resolves.toMatchObject({
      generationId: first.generationId,
      usedCachedBundle: true,
    });
    expect(scriptStarted).toBe(true);
  });

  it('retains bounded generations and can atomically roll back', async () => {
    await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: ENTRY,
    });
    serve('two');
    const second = await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: ENTRY,
    });
    serve('three');
    const third = await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: ENTRY,
    });

    const rolledBack = await rollbackWebBundle(cacheDirectoryForOrigin(ENTRY), third.generationId);

    expect(third.generationId).not.toBe(second.generationId);
    expect(rolledBack?.generationId).toBe(second.generationId);
    expect(await readMirroredWebBundle(rolledBack!.sourcePath)).toContain(
      encodeURIComponent('dataset.version = "two"')
    );
  });

  it('composes the currently requested hash route when rolling back a shared generation', async () => {
    const first = await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: `${ENTRY}#/books/42`,
    });
    serve('two');
    const currentUrl = `${ENTRY}#/books/99`;
    const current = await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: currentUrl,
    });

    const rolledBack = await rollbackWebBundle(
      cacheDirectoryForOrigin(ENTRY),
      current.generationId,
      currentUrl
    );

    expect(rolledBack).toMatchObject({
      baseUrl: currentUrl,
      generationId: first.generationId,
    });
  });

  it('rolls back when the active generation itself is corrupt', async () => {
    const first = await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: ENTRY,
    });
    serve('two');
    const active = await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: ENTRY,
    });
    native.files.delete(active.sourcePath);

    const rolledBack = await rollbackWebBundle(cacheDirectoryForOrigin(ENTRY), active.generationId);

    expect(rolledBack?.generationId).toBe(first.generationId);
    await expect(readMirroredWebBundle(rolledBack!.sourcePath)).resolves.toContain(
      encodeURIComponent('dataset.version = "one"')
    );
  });

  it('discards rejected newer generations so a repeated bad deployment keeps a good rollback', async () => {
    const good = await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: ENTRY,
    });
    serve('broken');
    const firstBroken = await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: ENTRY,
    });

    expect(
      (await rollbackWebBundle(cacheDirectoryForOrigin(ENTRY), firstBroken.generationId))
        ?.generationId
    ).toBe(good.generationId);
    await expect(readMirroredWebBundle(firstBroken.sourcePath)).rejects.toThrow('Missing file');

    const retriedBroken = await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: ENTRY,
    });
    const recoveredAgain = await rollbackWebBundle(
      cacheDirectoryForOrigin(ENTRY),
      retriedBroken.generationId
    );

    expect(retriedBroken.generationId).not.toBe(firstBroken.generationId);
    expect(recoveredAgain?.generationId).toBe(good.generationId);
    await expect(readMirroredWebBundle(good.sourcePath)).resolves.toContain(
      encodeURIComponent('dataset.version = "one"')
    );
  });

  it('rolls backward monotonically instead of toggling to a newer generation', async () => {
    const first = await resolveWebBundle({
      cachePolicy: { maxGenerations: 3 },
      virtualUrl: ENTRY,
    });
    serve('two');
    const second = await resolveWebBundle({
      cachePolicy: { maxGenerations: 3 },
      virtualUrl: ENTRY,
    });
    serve('three');
    const third = await resolveWebBundle({
      cachePolicy: { maxGenerations: 3 },
      virtualUrl: ENTRY,
    });
    const cacheDirectory = cacheDirectoryForOrigin(ENTRY);

    expect((await rollbackWebBundle(cacheDirectory, third.generationId))?.generationId).toBe(
      second.generationId
    );
    expect((await rollbackWebBundle(cacheDirectory, second.generationId))?.generationId).toBe(
      first.generationId
    );
    await expect(rollbackWebBundle(cacheDirectory, first.generationId)).resolves.toBeUndefined();
  });

  it('rolls back only within the displayed entry lineage in a shared cache directory', async () => {
    const firstEntry = 'https://app.example/first/';
    const secondEntry = 'https://app.example/second/';
    const cacheDirectory = '/documents/shared-entry-cache';
    native.responses.set(firstEntry, {
      body: '<!doctype html><html><head></head><body>FIRST_ONE</body></html>',
      etag: '"first-one"',
      mediaType: 'text/html',
    });
    const firstOne = await resolveWebBundle({
      cacheDirectory,
      cachePolicy: { maxGenerations: 4 },
      virtualUrl: firstEntry,
    });
    native.responses.set(firstEntry, {
      body: '<!doctype html><html><head></head><body>FIRST_TWO</body></html>',
      etag: '"first-two"',
      mediaType: 'text/html',
    });
    const firstTwo = await resolveWebBundle({
      cacheDirectory,
      cachePolicy: { maxGenerations: 4 },
      virtualUrl: firstEntry,
    });
    native.responses.set(secondEntry, {
      body: '<!doctype html><html><head></head><body>SECOND_ONE</body></html>',
      etag: '"second-one"',
      mediaType: 'text/html',
    });
    const secondOne = await resolveWebBundle({
      cacheDirectory,
      cachePolicy: { maxGenerations: 4 },
      virtualUrl: secondEntry,
    });

    const rolledBack = await rollbackWebBundle(cacheDirectory, firstTwo.generationId);

    expect(rolledBack?.generationId).toBe(firstOne.generationId);
    expect(rolledBack?.generationId).not.toBe(secondOne.generationId);
    await expect(readMirroredWebBundle(secondOne.sourcePath)).resolves.toContain('SECOND_ONE');
    await expect(
      rollbackWebBundle(cacheDirectory, secondOne.generationId)
    ).resolves.toBeUndefined();
  });

  it('keeps the active-generation fallback for the lower-level rollback API', async () => {
    const first = await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: ENTRY,
    });
    serve('two');
    await resolveWebBundle({
      cachePolicy: { maxGenerations: 2 },
      virtualUrl: ENTRY,
    });

    await expect(rollbackWebBundle(cacheDirectoryForOrigin(ENTRY))).resolves.toMatchObject({
      generationId: first.generationId,
    });
  });

  it('serializes concurrent resolves that share one cache directory', async () => {
    const [first, second] = await Promise.all([
      resolveWebBundle({ virtualUrl: ENTRY }),
      resolveWebBundle({ virtualUrl: ENTRY }),
    ]);

    expect(second.generationId).toBe(first.generationId);
    expect([...native.files.keys()].filter((path) => path.includes('/state.next-'))).toEqual([]);
  });

  it('propagates cancellation into an active native download', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const cancellableAdapter = {
      ...cacheAdapter,
      download: vi.fn<LocalWebViewCacheAdapter['download']>(
        (options: Parameters<typeof cacheAdapter.download>[0]) =>
          new Promise<never>((_resolve, reject) => {
            markStarted();
            options.signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('cancelled');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true }
            );
          })
      ),
    };
    const controller = new AbortController();
    const pending = resolveWebBundleWithAdapter({
      cacheAdapter: cancellableAdapter,
      signal: controller.signal,
      virtualUrl: ENTRY,
    });
    await started;

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('removes an unpublished generation when cancellation lands after its files are moved', async () => {
    const controller = new AbortController();
    const abortingAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async moveFile(source, destination) {
        await cacheAdapter.moveFile(source, destination);
        if (destination.endsWith('/manifest.json')) controller.abort();
      },
    };

    await expect(
      resolveWebBundleWithAdapter({
        cacheAdapter: abortingAdapter,
        signal: controller.signal,
        virtualUrl: ENTRY,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    const cacheDirectory = cacheDirectoryForOrigin(ENTRY);
    expect(
      [...native.files.keys()].filter((path) => path.startsWith(`${cacheDirectory}/generations/`))
    ).toEqual([]);
    expect(
      [...native.directories].filter((path) => path.startsWith(`${cacheDirectory}/generations/`))
    ).toEqual([]);
    expect(native.files.has(`${cacheDirectory}/state.json`)).toBe(false);
  });

  it('keeps later cache operations queued when a lock waiter is cancelled', async () => {
    let unblockFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    let downloadStarts = 0;
    const blockedAdapter = {
      ...cacheAdapter,
      async download(options: Parameters<typeof cacheAdapter.download>[0]) {
        downloadStarts += 1;
        if (downloadStarts === 1) {
          markFirstStarted();
          await firstGate;
        }
        return cacheAdapter.download(options);
      },
    };
    const cacheDirectory = '/documents/local-webview/lock-abort';
    const first = resolveWebBundleWithAdapter({
      cacheAdapter: blockedAdapter,
      cacheDirectory,
      virtualUrl: ENTRY,
    });
    await firstStarted;
    const waiterController = new AbortController();
    const cancelledWaiter = resolveWebBundleWithAdapter({
      cacheAdapter: blockedAdapter,
      cacheDirectory,
      signal: waiterController.signal,
      virtualUrl: ENTRY,
    });
    waiterController.abort();
    await expect(cancelledWaiter).rejects.toMatchObject({ name: 'AbortError' });

    const third = resolveWebBundleWithAdapter({
      cacheAdapter: blockedAdapter,
      cacheDirectory,
      virtualUrl: ENTRY,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(downloadStarts).toBe(1);

    unblockFirst();
    const [firstBundle, thirdBundle] = await Promise.all([first, third]);
    expect(thirdBundle.generationId).toBe(firstBundle.generationId);
  });

  it('reconciles interrupted staging, state, and generation artifacts', async () => {
    const cacheDirectory = cacheDirectoryForOrigin(ENTRY);
    const current = await resolveWebBundle({ virtualUrl: ENTRY });
    const orphanDirectory = `${cacheDirectory}/generations/orphan`;
    native.directories.add(orphanDirectory);
    native.files.set(`${orphanDirectory}/large.data`, new Uint8Array(1024));
    native.files.set(`${cacheDirectory}/staging/interrupted.data`, new Uint8Array(1024));
    native.files.set(`${cacheDirectory}/state.next-crash.json`, new TextEncoder().encode('{}'));

    const reused = await resolveWebBundle({ virtualUrl: ENTRY });

    expect(reused.generationId).toBe(current.generationId);
    expect(native.files.has(`${orphanDirectory}/large.data`)).toBe(false);
    expect(native.files.has(`${cacheDirectory}/staging/interrupted.data`)).toBe(false);
    expect(native.files.has(`${cacheDirectory}/state.next-crash.json`)).toBe(false);
  });

  it('propagates a state read I/O error without deleting verified generations', async () => {
    const current = await resolveWebBundle({ virtualUrl: ENTRY });
    const cacheDirectory = cacheDirectoryForOrigin(ENTRY);
    const failingAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async readFile(path, encoding) {
        if (path === `${cacheDirectory}/state.json`) {
          throw new Error('EIO while reading cache state');
        }
        return cacheAdapter.readFile(path, encoding);
      },
    };

    await expect(
      resolveWebBundleWithAdapter({
        cacheAdapter: failingAdapter,
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('EIO while reading cache state');

    await expect(readMirroredWebBundle(current.sourcePath)).resolves.toContain('dataset.version');
    expect(native.files.has(`${cacheDirectory}/state.json`)).toBe(true);
  });

  it('applies a stricter generation policy even when the active bundle is unchanged', async () => {
    const first = await resolveWebBundle({
      cachePolicy: { maxGenerations: 3 },
      virtualUrl: ENTRY,
    });
    serve('two');
    const second = await resolveWebBundle({
      cachePolicy: { maxGenerations: 3 },
      virtualUrl: ENTRY,
    });
    serve('three');
    const active = await resolveWebBundle({
      cachePolicy: { maxGenerations: 3 },
      virtualUrl: ENTRY,
    });

    const reused = await resolveWebBundle({
      cachePolicy: { maxGenerations: 1 },
      virtualUrl: ENTRY,
    });

    expect(reused.generationId).toBe(active.generationId);
    await expect(readMirroredWebBundle(first.sourcePath)).rejects.toThrow('Missing file');
    await expect(readMirroredWebBundle(second.sourcePath)).rejects.toThrow('Missing file');
    const previousState = JSON.parse(
      new TextDecoder().decode(
        native.files.get(`${cacheDirectoryForOrigin(ENTRY)}/state.previous.json`)!
      )
    ) as { generations: Array<{ generationId: string }> };
    expect(previousState.generations.map(({ generationId }) => generationId)).toEqual([
      active.generationId,
    ]);
  });

  it('does not reuse an active generation after maxBytes is lowered below its size', async () => {
    const active = await resolveWebBundle({ virtualUrl: ENTRY });
    native.requests.length = 0;

    await expect(
      resolveWebBundle({
        cachePolicy: { maxBytes: active.totalBytes - 1 },
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('maxBytes');

    expect(native.requests.length).toBeGreaterThan(0);
    await expect(readMirroredWebBundle(active.sourcePath)).rejects.toThrow('Missing file');
  });

  it('keeps an oversized active generation only while it has a lease', async () => {
    const cacheDirectory = cacheDirectoryForOrigin(ENTRY);
    const active = await resolveWebBundle({ virtualUrl: ENTRY });
    const release = retainWebBundle(cacheDirectory, active.generationId);

    await expect(
      resolveWebBundle({
        cachePolicy: { maxBytes: active.totalBytes - 1 },
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('maxBytes');
    await expect(readMirroredWebBundle(active.sourcePath)).resolves.toContain('dataset.version');

    release();
    await expect(
      resolveWebBundle({
        cachePolicy: { maxBytes: active.totalBytes - 1 },
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('maxBytes');
    await expect(readMirroredWebBundle(active.sourcePath)).rejects.toThrow('Missing file');
  });

  it('keeps a leased generation until its mounted consumer releases it', async () => {
    const cacheDirectory = cacheDirectoryForOrigin(ENTRY);
    const first = await resolveWebBundle({
      cachePolicy: { maxGenerations: 1 },
      virtualUrl: ENTRY,
    });
    const release = retainWebBundle(cacheDirectory, first.generationId);
    serve('two');
    const second = await resolveWebBundle({
      cachePolicy: { maxGenerations: 1 },
      virtualUrl: ENTRY,
    });

    expect(second.generationId).not.toBe(first.generationId);
    await expect(readMirroredWebBundle(first.sourcePath)).resolves.toContain('dataset.version');

    release();
    await resolveWebBundle({
      cachePolicy: { maxGenerations: 1 },
      virtualUrl: ENTRY,
    });
    await expect(readMirroredWebBundle(first.sourcePath)).rejects.toThrow('Missing file');
  });

  it('stops crawling when cumulative downloaded bytes exceed maxBytes', async () => {
    const entryHtml =
      '<!doctype html><html><head><script src="/assets/app.js"></script></head></html>';
    const script = `globalThis.downloaded = ${JSON.stringify('x'.repeat(256))};`;
    native.responses.set(ENTRY, {
      body: entryHtml,
      mediaType: 'text/html',
    });
    native.responses.set(SCRIPT, {
      body: script,
      mediaType: 'text/javascript',
    });
    const entryBytes = new TextEncoder().encode(entryHtml).byteLength;
    const maxBytes = entryBytes + 4 * Math.ceil(entryBytes / 3);

    await expect(
      resolveWebBundle({
        cachePolicy: { maxBytes },
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('maxBytes');

    expect(native.requests.map((request) => request.url)).toEqual([ENTRY, SCRIPT]);
    expect([...native.files.keys()].filter((path) => path.includes('/staging/download-'))).toEqual(
      []
    );
  });

  it.each([
    {
      assetPath: '/assets/special.js',
      entry: '<!doctype html><script type="module" src="/assets/special.js"></script>',
      mediaType: 'text/javascript',
      source: (marker: string) => `globalThis.special = ${JSON.stringify(marker)};`,
    },
    {
      assetPath: '/assets/special.css',
      entry: '<!doctype html><link rel="stylesheet" href="/assets/special.css">',
      mediaType: 'text/css',
      source: (marker: string) => `.special::before{content:${JSON.stringify(marker)}}`,
    },
  ])(
    'rejects percent-encoded $mediaType output before allocating its data URL or publishing',
    async ({ assetPath, entry, mediaType, source }) => {
      const assetUrl = new URL(assetPath, ENTRY).toString();
      const marker = `🙂;/%${'한'.repeat(128)}`;
      const assetSource = source(marker);
      native.responses.set(ENTRY, {
        body: entry,
        mediaType: 'text/html',
      });
      native.responses.set(assetUrl, {
        body: assetSource,
        mediaType,
      });
      const entrySize = encoder.encode(entry).byteLength;
      const assetSize = encoder.encode(assetSource).byteLength;
      const maxBytes = 4 * Math.ceil(entrySize / 3) + assetSize + 4 * Math.ceil(assetSize / 3);
      const originalEncodeURIComponent = globalThis.encodeURIComponent;
      let payloadEncodingCalls = 0;
      const encodeSpy = vi
        .spyOn(globalThis, 'encodeURIComponent')
        .mockImplementation((value: string | number | boolean) => {
          if (String(value).includes(marker)) payloadEncodingCalls += 1;
          return originalEncodeURIComponent(value);
        });
      const cacheDirectory = cacheDirectoryForOrigin(ENTRY);

      try {
        await expect(
          resolveWebBundle({
            cachePolicy: { maxBytes },
            virtualUrl: ENTRY,
          })
        ).rejects.toThrow(`while materializing ${assetUrl}`);
      } finally {
        encodeSpy.mockRestore();
      }

      expect(payloadEncodingCalls).toBe(0);
      expect(native.files.has(`${cacheDirectory}/state.json`)).toBe(false);
      expect(
        [...native.files.keys()].filter((path) => path.startsWith(`${cacheDirectory}/generations/`))
      ).toEqual([]);
    }
  );

  it('rejects an oversized response before hashing or reading it into memory', async () => {
    const oversizedHtml = `<!doctype html><html><body>${'x'.repeat(1024)}</body></html>`;
    native.responses.set(ENTRY, {
      body: oversizedHtml,
      mediaType: 'text/html',
    });
    let hashCalls = 0;
    let readCalls = 0;
    const downloadLimits: Array<number | undefined> = [];
    const observedAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async download(options) {
        downloadLimits.push(options.maxBytes);
        return cacheAdapter.download(options);
      },
      async hashFile(path, algorithms) {
        hashCalls += 1;
        return cacheAdapter.hashFile(path, algorithms);
      },
      async readFile(path, encoding) {
        readCalls += 1;
        return cacheAdapter.readFile(path, encoding);
      },
    };

    await expect(
      resolveWebBundleWithAdapter({
        cacheAdapter: observedAdapter,
        cachePolicy: { maxBytes: 128 },
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('maxBytes=54');

    expect(downloadLimits).toEqual([54]);
    expect(hashCalls).toBe(0);
    expect(readCalls).toBe(0);
    expect([...native.files.keys()].filter((path) => path.includes('/staging/download-'))).toEqual(
      []
    );
  });

  it.each([
    ['bridge then inline', true],
    ['inline then bridge', false],
  ] as const)(
    'reuses one canonical download for %s delivery and preserves the bridge file',
    async (_label, bridgeFirst) => {
      const assetUrl = 'https://app.example/assets/shared.wasm';
      const bridge = '<link rel="preload" as="fetch" href="/assets/shared.wasm#bridge">';
      const inline = '<img src="/assets/shared.wasm#inline">';
      native.responses.set(ENTRY, {
        body: `<!doctype html><html><head>${bridgeFirst ? bridge : ''}</head><body>${
          bridgeFirst ? inline : `${inline}${bridge}`
        }</body></html>`,
        mediaType: 'text/html',
      });
      native.responses.set(assetUrl, {
        body: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
        mediaType: 'application/wasm',
      });

      const bundle = await resolveWebBundle({ virtualUrl: `${ENTRY}#initial-route` });
      const assetRequests = native.requests.filter((request) => request.url === assetUrl);
      const localAsset = bundle.localAssets[assetUrl];

      expect(assetRequests).toHaveLength(1);
      expect(native.requests.some((request) => request.url.includes('#'))).toBe(false);
      expect(bundle.downloadedAssets).toContain(assetUrl);
      expect(bundle.downloadedAssets.some((url) => url.includes('#'))).toBe(false);
      expect(Object.keys(bundle.localAssets)).toEqual([assetUrl]);
      expect(localAsset).toBeDefined();
      expect(localAsset?.integrity.sha256).toBeTruthy();
      expect(localAsset?.integrity.sha384).toBeTruthy();
      expect(localAsset?.integrity.sha512).toBeTruthy();
      expect(native.files.get(localAsset!.path)).toEqual(
        new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
      );
      expect(await readMirroredWebBundle(bundle.sourcePath)).toContain(
        'data:application/wasm;base64,'
      );
    }
  );

  it('rejects an inline asset when a custom cache adapter corrupts its promoted bridge file', async () => {
    const assetUrl = 'https://app.example/assets/shared.wasm';
    native.responses.set(ENTRY, {
      body: `<!doctype html><html><body>
        <img src="/assets/shared.wasm">
        <link rel="preload" as="fetch" href="/assets/shared.wasm">
      </body></html>`,
      mediaType: 'text/html',
    });
    native.responses.set(assetUrl, {
      body: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      mediaType: 'application/wasm',
    });
    const corruptingAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async writeFile(path, value, encoding) {
        if (path.includes('/promoted-')) {
          await cacheAdapter.writeFile(path, fromByteArray(new Uint8Array([9, 9, 9])), 'base64');
          return;
        }
        await cacheAdapter.writeFile(path, value, encoding);
      },
    };

    await expect(
      resolveWebBundleWithAdapter({
        cacheAdapter: corruptingAdapter,
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('Promoted bridge asset failed integrity verification');

    expect(native.requests.filter((request) => request.url === assetUrl)).toHaveLength(1);
    expect(
      [...native.files.keys()].filter((path) => path.startsWith('/temporary/local-webview-'))
    ).toEqual([]);
  });

  it('rejects invalid URLs and cache policies before downloading', async () => {
    await expect(resolveWebBundle({ virtualUrl: 'http://app.example/' })).rejects.toThrow(
      'absolute HTTPS'
    );
    await expect(
      resolveWebBundle({
        cachePolicy: { maxBytes: 0 },
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('safe integers');
    await expect(
      resolveWebBundle({
        trustedAssetOrigins: ['https://127.0.0.1'],
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('public HTTPS host');
  });

  it.each([
    'https://100.64.0.1/',
    'https://192.0.2.1/',
    'https://198.18.0.1/',
    'https://203.0.113.1/',
    'https://[::ffff:7f00:1]/',
    'https://[::ffff:192.168.1.1]/',
    'https://[::ffff:100.64.0.1]/',
    'https://[fc00::1]/',
    'https://[fe80::1]/',
    'https://[2001:db8::1]/',
  ])('rejects the non-public host %s before downloading', async (virtualUrl) => {
    await expect(resolveWebBundle({ virtualUrl })).rejects.toThrow('public HTTPS host');
    expect(native.requests).toEqual([]);
  });

  it.each([
    ['NaN maxBytes', { maxBytes: Number.NaN }],
    ['infinite maxBytes', { maxBytes: Number.POSITIVE_INFINITY }],
    ['fractional maxBytes', { maxBytes: 1.5 }],
    ['NaN maxGenerations', { maxGenerations: Number.NaN }],
    ['infinite maxGenerations', { maxGenerations: Number.POSITIVE_INFINITY }],
    ['fractional maxGenerations', { maxGenerations: 1.5 }],
    ['NaN maxInlineBytes', { maxInlineBytes: Number.NaN }],
    ['infinite maxInlineBytes', { maxInlineBytes: Number.POSITIVE_INFINITY }],
    ['fractional maxInlineBytes', { maxInlineBytes: 1.5 }],
  ] as const)('rejects %s before touching the cache', async (_description, cachePolicy) => {
    await expect(
      resolveWebBundle({
        cachePolicy,
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('safe integers');

    expect(native.requests).toEqual([]);
    expect(native.files.size).toBe(0);
  });

  it('rejects a large data-URL resource before duplicating it into the localized HTML', async () => {
    const mediaUrl = 'https://app.example/assets/movie.mp4';
    let mediaDownloadLimit: number | undefined;
    const observedAdapter: LocalWebViewCacheAdapter = {
      ...cacheAdapter,
      async download(options) {
        if (options.url === mediaUrl) mediaDownloadLimit = options.maxBytes;
        return cacheAdapter.download(options);
      },
    };
    native.responses.set(ENTRY, {
      body: '<!doctype html><video src="/assets/movie.mp4"></video>',
      mediaType: 'text/html',
    });
    native.responses.set(mediaUrl, {
      body: new Uint8Array(1024),
      mediaType: 'video/mp4',
    });

    await expect(
      resolveWebBundleWithAdapter({
        cacheAdapter: observedAdapter,
        cachePolicy: { maxBytes: 4096, maxInlineBytes: 256 },
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('maxInlineBytes=256');

    expect(mediaDownloadLimit).toBe(256);
    expect(native.requests.map((request) => request.url)).toEqual([ENTRY, mediaUrl]);
    expect([...native.files.keys()].some((path) => path.includes('/generations/'))).toBe(false);
  });

  it('does not reuse a generation created under a larger maxInlineBytes policy', async () => {
    const mediaUrl = 'https://app.example/assets/poster.png';
    native.responses.set(ENTRY, {
      body: '<!doctype html><img src="/assets/poster.png">',
      mediaType: 'text/html',
    });
    native.responses.set(mediaUrl, {
      body: new Uint8Array(1024),
      mediaType: 'image/png',
    });
    await resolveWebBundle({
      cachePolicy: { maxInlineBytes: 2048 },
      virtualUrl: ENTRY,
    });
    native.requests.length = 0;

    await expect(
      resolveWebBundle({
        cachePolicy: { maxInlineBytes: 128 },
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('maxInlineBytes=128');

    expect(native.requests.map((request) => request.url)).toEqual([ENTRY, mediaUrl]);
  });

  it('enforces maxInlineBytes when a previously streamed asset is promoted inline', async () => {
    const sharedUrl = 'https://app.example/assets/shared.wasm';
    native.responses.set(ENTRY, {
      body: `<!doctype html>
        <link rel="preload" as="fetch" href="/assets/shared.wasm">
        <img src="/assets/shared.wasm">`,
      mediaType: 'text/html',
    });
    native.responses.set(sharedUrl, {
      body: new Uint8Array(1024),
      mediaType: 'application/wasm',
    });

    await expect(
      resolveWebBundle({
        cachePolicy: { maxBytes: 4096, maxInlineBytes: 256 },
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('maxInlineBytes=256');

    expect(native.requests.filter((request) => request.url === sharedUrl)).toHaveLength(1);
  });

  it('follows only validated redirects with native auto-follow disabled', async () => {
    const redirectedEntry = 'https://app.example/index.html';
    native.responses.set(ENTRY, {
      location: '/index.html',
      status: 302,
    });
    native.responses.set(redirectedEntry, {
      body: '<!doctype html><script type="module" src="/assets/app.js"></script>',
      etag: '"entry-redirected"',
      mediaType: 'text/html',
    });

    await resolveWebBundle({ virtualUrl: ENTRY });

    expect(native.requests.slice(0, 2)).toEqual([
      { etag: undefined, url: ENTRY },
      { etag: undefined, url: redirectedEntry },
    ]);
    expect(native.blobConfigs.every((config) => config.followRedirect === false)).toBe(true);
  });

  it('uses final response URLs to resolve redirected entry and module dependencies', async () => {
    const documentUrl = 'https://app.example/releases/v2/index.html';
    const moduleStart = 'https://app.example/releases/v2/start.js';
    const moduleUrl = 'https://app.example/assets/v2/app.js';
    const chunkUrl = 'https://app.example/assets/v2/chunk.js';
    native.responses.set(ENTRY, {
      location: documentUrl,
      status: 302,
    });
    native.responses.set(documentUrl, {
      body: '<!doctype html><script type="module" src="./start.js"></script>',
      mediaType: 'text/html',
    });
    native.responses.set(moduleStart, {
      location: moduleUrl,
      status: 302,
    });
    native.responses.set(moduleUrl, {
      body: 'import "./chunk.js";',
      mediaType: 'text/javascript',
    });
    native.responses.set(chunkUrl, {
      body: 'export const ready = true;',
      mediaType: 'text/javascript',
    });

    const bundle = await resolveWebBundle({ virtualUrl: ENTRY });

    expect(bundle.baseUrl).toBe(documentUrl);
    expect(native.requests.map((request) => request.url)).toEqual(
      expect.arrayContaining([documentUrl, moduleStart, moduleUrl, chunkUrl])
    );
    expect(native.requests.some((request) => request.url === 'https://app.example/chunk.js')).toBe(
      false
    );
  });

  it('does not grant the entry origin to HTML redirected to a trusted CDN', async () => {
    const cdnEntry = 'https://cdn.example/maintenance.html';
    native.responses.set(ENTRY, {
      location: cdnEntry,
      status: 302,
    });

    await expect(
      resolveWebBundle({
        trustedAssetOrigins: ['https://cdn.example'],
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('Entry redirect target changes origin');
    expect(native.requests.map((request) => request.url)).toEqual([ENTRY]);
  });

  it.each([
    ['cross-origin', 'https://attacker.example/entry.html'],
    ['HTTPS downgrade', 'http://app.example/entry.html'],
    ['private network', 'https://127.0.0.1/entry.html'],
  ])('rejects a %s redirect before requesting its target', async (_name, target) => {
    native.responses.set(ENTRY, {
      location: target,
      status: 302,
    });

    await expect(resolveWebBundle({ virtualUrl: ENTRY })).rejects.toThrow(
      /untrusted origin|absolute HTTPS|public HTTPS host/
    );

    expect(native.requests.map((request) => request.url)).toEqual([ENTRY]);
  });

  it('rejects redirect loops and bounded overlong chains', async () => {
    native.responses.set(ENTRY, {
      location: '/loop',
      status: 302,
    });
    native.responses.set('https://app.example/loop', {
      location: '/',
      status: 302,
    });

    await expect(resolveWebBundle({ virtualUrl: ENTRY })).rejects.toThrow('Redirect loop');

    native.requests.length = 0;
    for (let index = 0; index <= 10; index += 1) {
      native.responses.set(index === 0 ? ENTRY : `https://app.example/redirect-${index}`, {
        location: `/redirect-${index + 1}`,
        status: 302,
      });
    }
    await expect(resolveWebBundle({ virtualUrl: ENTRY })).rejects.toThrow('Too many redirects');
    expect(native.requests).toHaveLength(11);
  });

  it('keeps cross-origin references remote unless their origin is explicitly trusted', async () => {
    const cdn = 'https://cdn.example/app.js';
    const cdnBinary = 'https://cdn.example/game.wasm';
    native.responses.set(ENTRY, {
      body: `<!doctype html>
        <link rel="preload" href="${cdnBinary}" as="fetch" type="application/wasm">
        <script type="module" src="${cdn}"></script>`,
      etag: '"cross-origin-entry"',
      mediaType: 'text/html',
    });
    native.responses.set(cdn, {
      body: 'export const ready = true;',
      etag: '"cdn-script"',
      mediaType: 'text/javascript',
    });
    native.responses.set(cdnBinary, {
      body: 'wasm-bytes',
      etag: '"cdn-wasm"',
      headers: {
        'Access-Control-Allow-Origin': 'https://app.example',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Set-Cookie': 'must-not-be-replayed=true',
      },
      mediaType: 'application/wasm',
    });

    const defaultBundle = await resolveWebBundle({ virtualUrl: ENTRY });
    expect(native.requests.some((request) => request.url === cdn)).toBe(false);
    expect(await readMirroredWebBundle(defaultBundle.sourcePath)).toContain(`src="${cdn}"`);

    native.requests.length = 0;
    const trustedBundle = await resolveWebBundle({
      trustedAssetOrigins: ['https://cdn.example'],
      virtualUrl: ENTRY,
    });
    expect(native.requests.some((request) => request.url === cdn)).toBe(true);
    expect(
      native.requests
        .filter((request) => request.url === cdn || request.url === cdnBinary)
        .map((request) => request.origin)
    ).toEqual(['https://app.example', 'https://app.example']);
    expect(await readMirroredWebBundle(trustedBundle.sourcePath)).not.toContain(`src="${cdn}"`);
    expect(trustedBundle.localAssets[cdnBinary]?.responseHeaders).toEqual({
      'access-control-allow-origin': 'https://app.example',
      'cross-origin-resource-policy': 'cross-origin',
      'etag': '"cdn-wasm"',
    });
  });

  it('requires explicit CSP removal for both HTTP headers and meta tags', async () => {
    native.responses.set(ENTRY, {
      body: `<!doctype html><html><head>
        <meta http-equiv="Content-Security-Policy" content="script-src 'self'">
      </head><body></body></html>`,
      headers: {
        'Content-Security-Policy': "default-src 'self'",
      },
      mediaType: 'text/html',
    });

    await expect(resolveWebBundle({ virtualUrl: ENTRY })).rejects.toThrow(
      'allowContentSecurityPolicyBypass'
    );

    const bypassed = await resolveWebBundle({
      allowContentSecurityPolicyBypass: true,
      virtualUrl: ENTRY,
    });
    expect(await readMirroredWebBundle(bypassed.sourcePath)).not.toContain(
      'Content-Security-Policy'
    );

    await expect(resolveWebBundle({ virtualUrl: ENTRY })).rejects.toThrow(
      'allowContentSecurityPolicyBypass'
    );
  });

  it('applies the current cache policy before rethrowing a forced-refresh CSP error', async () => {
    const first = await resolveWebBundle({ virtualUrl: ENTRY });
    serve('two');
    const second = await resolveWebBundle({ virtualUrl: ENTRY });
    serve('three');
    const active = await resolveWebBundle({ virtualUrl: ENTRY });
    native.responses.set(ENTRY, {
      body: '<!doctype html><html><body>blocked refresh</body></html>',
      headers: {
        'Content-Security-Policy': "default-src 'self'",
      },
      mediaType: 'text/html',
    });

    await expect(
      resolveWebBundle({
        cachePolicy: { maxGenerations: 1 },
        forceRefresh: true,
        virtualUrl: ENTRY,
      })
    ).rejects.toThrow('allowContentSecurityPolicyBypass');

    await expect(readMirroredWebBundle(first.sourcePath)).rejects.toThrow('Missing file');
    await expect(readMirroredWebBundle(second.sourcePath)).rejects.toThrow('Missing file');
    await expect(readMirroredWebBundle(active.sourcePath)).resolves.toContain(
      'document.body.dataset.version'
    );
    const state = JSON.parse(
      decoder.decode(native.files.get(`${cacheDirectoryForOrigin(ENTRY)}/state.json`)!)
    ) as { generations: Array<{ generationId: string }> };
    expect(state.generations.map(({ generationId }) => generationId)).toEqual([
      active.generationId,
    ]);
  });

  it('records and revalidates a report-only CSP only under the explicit bypass', async () => {
    const reportOnly = (endpoint: string) => `default-src 'self'; report-to ${endpoint}`;
    native.responses.set(ENTRY, {
      body: '<!doctype html><html><body>report only</body></html>',
      etag: '"entry-report-only"',
      headers: {
        'Content-Security-Policy-Report-Only': reportOnly('first'),
      },
      mediaType: 'text/html',
    });

    await expect(resolveWebBundle({ virtualUrl: ENTRY })).rejects.toThrow(
      'Content-Security-Policy-Report-Only'
    );
    const first = await resolveWebBundle({
      allowContentSecurityPolicyBypass: true,
      virtualUrl: ENTRY,
    });
    const firstManifest = JSON.parse(
      decoder.decode(file(first.sourcePath.replace('/index.html', '/manifest.json')))
    ) as {
      remoteAssets: Array<{
        contentSecurityPolicyReportOnly?: string;
        url: string;
      }>;
    };
    expect(
      firstManifest.remoteAssets.find((asset) => asset.url === ENTRY)
        ?.contentSecurityPolicyReportOnly
    ).toBe(reportOnly('first'));

    native.responses.get(ENTRY)!.headers = {
      'Content-Security-Policy-Report-Only': reportOnly('second'),
    };
    const second = await resolveWebBundle({
      allowContentSecurityPolicyBypass: true,
      virtualUrl: ENTRY,
    });

    expect(second.generationId).not.toBe(first.generationId);
  });

  it('does not reinterpret a non-HTML entry response as executable HTML', async () => {
    native.responses.set(ENTRY, {
      body: '<script>globalThis.shouldNotRun = true</script>',
      mediaType: 'text/plain',
    });

    await expect(resolveWebBundle({ virtualUrl: ENTRY })).rejects.toThrow(
      'must use Content-Type: text/html'
    );
  });

  it('rejects encoded native responses instead of serving compressed bytes as WASM', async () => {
    native.responses.set(SCRIPT, {
      body: new Uint8Array([11, 29, 0, 0]),
      headers: { 'Content-Encoding': 'br' },
      mediaType: 'application/wasm',
    });

    await expect(resolveWebBundle({ virtualUrl: ENTRY })).rejects.toThrow(
      'Unsupported encoded response (br)'
    );
  });

  it('does not let URL extension inference override a server-declared script MIME type', async () => {
    native.responses.set(SCRIPT, {
      body: 'globalThis.injected = true;',
      mediaType: 'text/plain',
    });

    await expect(resolveWebBundle({ virtualUrl: ENTRY })).rejects.toThrow(
      'invalid MIME type: text/plain'
    );
  });

  it('preserves final response metadata for a redirected bridge asset', async () => {
    const entryUrl = 'https://redirect-assets.example/play/';
    const assetUrl = `${entryUrl}Build/game.data`;
    const responseUrl = `${entryUrl}releases/v2/game.data`;
    const html =
      '<!doctype html><canvas></canvas><script>const config={dataUrl:"Build/game.data"}</script>';
    const bytes = new Uint8Array([1, 2, 3, 4]);
    native.responses.set(entryUrl, { body: html, mediaType: 'text/html' });
    native.responses.set(assetUrl, {
      location: responseUrl,
      status: 302,
    });
    native.responses.set(responseUrl, {
      body: bytes,
      mediaType: 'application/octet-stream',
    });

    const bundle = await resolveWebBundle({ virtualUrl: entryUrl });

    expect(bundle.localAssets[assetUrl]).toMatchObject({
      redirected: true,
      responseUrl,
      url: assetUrl,
    });
  });

  it('persists statically discoverable Unity WebGL runtime files', async () => {
    const entryUrl = 'https://game.example/play/';
    const html = `<!doctype html><html><head></head><body>
      <canvas id="unity-canvas"></canvas>
      <script>
        const loaderUrl = "Build/game.loader.js";
        const config = {
          dataUrl: "Build/game.data",
          frameworkUrl: "Build/game.framework.js",
          codeUrl: "Build/game.wasm",
          streamingAssetsUrl: "StreamingAssets"
        };
        const script = document.createElement("script");
        script.src = loaderUrl;
        document.body.appendChild(script);
      </script>
    </body></html>`;
    const assets: Record<string, string | Uint8Array> = {
      [entryUrl]: html,
      'Build/game.data': new Uint8Array([10, 20, 30, 40]),
      'Build/game.framework.js': 'globalThis.unityFramework = true;',
      'Build/game.loader.js': 'globalThis.createUnityInstance = () => Promise.resolve();',
      'Build/game.wasm': new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    };

    for (const [relativeUrl, body] of Object.entries(assets)) {
      const url = new URL(relativeUrl, entryUrl).toString();
      native.responses.set(url, {
        body,
        etag: `"${new URL(url).pathname}"`,
        mediaType: url.endsWith('.wasm')
          ? 'application/wasm'
          : url.endsWith('.js')
            ? 'text/javascript'
            : url.endsWith('.html') || url === entryUrl
              ? 'text/html'
              : 'application/octet-stream',
      });
    }

    const bundle = await resolveWebBundle({ virtualUrl: entryUrl });

    const streamableUrls = ['Build/game.data', 'Build/game.wasm'].map((url) =>
      new URL(url, entryUrl).toString()
    );
    expect(Object.keys(bundle.localAssets).sort()).toEqual(streamableUrls.sort());
    for (const asset of Object.values(bundle.localAssets)) {
      expect(native.files.get(asset.path)?.byteLength).toBe(asset.size);
      expect(asset.path).toContain(`/generations/${bundle.generationId}/assets/`);
      expect(asset.integrity.sha256).toBeTruthy();
      expect(asset.integrity.sha384).toBeTruthy();
      expect(asset.integrity.sha512).toBeTruthy();
    }
    const localized = await readMirroredWebBundle(bundle.sourcePath);
    expect(localized).toContain(`${entryUrl}Build/game.wasm`);
    expect(localized).toContain(
      `frameworkUrl: globalThis["__reactNativeLocalWebViewMaterializeDynamicScript__"]("${entryUrl}Build/game.framework.js")`
    );
    expect(localized).toContain(
      `globalThis["__reactNativeLocalWebViewPrepareDynamicScript__"]("${entryUrl}Build/game.loader.js", script)`
    );
    expect(localized).toContain('new globalThis.Blob([node.code]');
    expect(localized).not.toContain('data:text/javascript;base64,');
    expect(localized).not.toContain('data:application/wasm;base64,');
    expect(
      native.copies.filter(({ destination }) =>
        destination.includes(`/generations/${bundle.generationId}/assets/`)
      )
    ).toEqual([]);
    const assetMoves = native.moves.filter(({ destination }) =>
      destination.includes(`/generations/${bundle.generationId}/assets/`)
    );
    expect(assetMoves).toHaveLength(
      new Set(Object.values(bundle.localAssets).map((asset) => asset.sha256)).size
    );
    expect(
      [...native.files.keys()].filter((path) => path.startsWith('/temporary/local-webview-'))
    ).toEqual([]);
  });
});
