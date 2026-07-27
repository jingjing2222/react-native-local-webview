import { fromByteArray, toByteArray } from 'base64-js';
import { describe, expect, it, vi } from 'vitest';

import {
  createLocalWebViewCacheAdapter,
  type CreateLocalWebViewCacheAdapterOptions,
  type LocalWebViewCacheAdapter,
} from '../src/localWebViewCacheAdapter';

function optionsFor(initialFiles: Record<string, Uint8Array> = {}) {
  const files = new Map(Object.entries(initialFiles));
  const readFileRange = vi.fn<CreateLocalWebViewCacheAdapterOptions['readFileRange']>(
    async (path, start, end, encoding) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`Missing file: ${path}`);
      const slice = bytes.slice(start, end);
      if (encoding === 'base64') return fromByteArray(slice);
      return new TextDecoder().decode(slice);
    }
  );
  const options: CreateLocalWebViewCacheAdapterOptions = {
    directories: { documents: '/documents' },
    async download() {
      throw new Error('not used');
    },
    async exists(path) {
      return files.has(path);
    },
    async listDirectory() {
      return [];
    },
    async makeDirectory() {},
    async moveFile(source, destination) {
      const bytes = files.get(source);
      if (!bytes) throw new Error(`Missing file: ${source}`);
      files.set(destination, bytes);
      files.delete(source);
    },
    readFileRange,
    async remove(path) {
      files.delete(path);
    },
    async stat(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`Missing file: ${path}`);
      return { size: bytes.byteLength };
    },
    async writeFile(path, value, encoding) {
      files.set(path, encoding === 'base64' ? toByteArray(value) : new TextEncoder().encode(value));
    },
  };
  return { ...options, files, readFileRange };
}

describe('createLocalWebViewCacheAdapter', () => {
  it('supplies whole-file reads, small-file copies, and incremental hashes', async () => {
    const source = new TextEncoder().encode('hello');
    const options = optionsFor({ '/documents/source': source });
    const cacheAdapter = createLocalWebViewCacheAdapter({ ...options, hashChunkBytes: 2 });

    await expect(cacheAdapter.readFile('/documents/source', 'utf8')).resolves.toBe('hello');
    await cacheAdapter.copyFile('/documents/source', '/documents/copy');
    expect(options.files.get('/documents/copy')).toEqual(source);
    await expect(cacheAdapter.hashFile('/documents/source', ['sha256'])).resolves.toEqual({
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(options.readFileRange).toHaveBeenCalledWith('/documents/source', 0, 2, 'base64');
    expect(options.readFileRange).toHaveBeenCalledWith('/documents/source', 4, 5, 'base64');
  });

  it('keeps optimized host implementations when supplied', async () => {
    const options = optionsFor();
    const copyFile = vi.fn<LocalWebViewCacheAdapter['copyFile']>(async () => undefined);
    const hashFile = vi.fn<LocalWebViewCacheAdapter['hashFile']>(async () => ({
      sha256: '00'.repeat(32),
    }));
    const readFile = vi.fn<LocalWebViewCacheAdapter['readFile']>(async () => 'host');
    const cacheAdapter = createLocalWebViewCacheAdapter({
      ...options,
      copyFile,
      hashFile,
      readFile,
    });

    await cacheAdapter.copyFile('/source', '/destination');
    await cacheAdapter.hashFile('/source', ['sha256']);
    await cacheAdapter.readFile('/source', 'utf8');
    expect(copyFile).toHaveBeenCalledWith('/source', '/destination');
    expect(hashFile).toHaveBeenCalledWith('/source', ['sha256']);
    expect(readFile).toHaveBeenCalledWith('/source', 'utf8');
  });

  it('rejects invalid factory configuration and truncated range reads', async () => {
    const options = optionsFor({
      '/documents/source': new TextEncoder().encode('hello'),
    });
    expect(() => createLocalWebViewCacheAdapter({ ...options, hashChunkBytes: 0 })).toThrow(
      'hashChunkBytes'
    );

    const cacheAdapter = createLocalWebViewCacheAdapter({
      ...options,
      readFileRange: async () => '',
    });
    await expect(cacheAdapter.hashFile('/documents/source', ['sha256'])).rejects.toThrow(
      'readFileRange returned 0 bytes'
    );
  });
});
