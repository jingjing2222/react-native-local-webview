import type { LocalWebViewCacheAdapter } from './localWebViewCacheAdapter';
import {
  cacheDirectoryForOrigin as cacheDirectoryForOriginWithAdapter,
  readMirroredWebBundle as readMirroredWebBundleWithAdapter,
  resolveWebBundle as resolveWebBundleWithAdapter,
  rollbackWebBundle as rollbackWebBundleWithAdapter,
  type ResolveWebBundleOptions as InternalResolveWebBundleOptions,
} from './mirrorWebBundle';
import { getCacheAdapter } from './nitroCacheAdapter';

export type ResolveWebBundleOptions = Omit<InternalResolveWebBundleOptions, 'cacheAdapter'>;

function cacheAdapter(): LocalWebViewCacheAdapter {
  return getCacheAdapter();
}

export function cacheDirectoryForOrigin(virtualUrl: string): string {
  return cacheDirectoryForOriginWithAdapter(virtualUrl, cacheAdapter());
}

export function readMirroredWebBundle(source: string): Promise<string> {
  return readMirroredWebBundleWithAdapter(source, cacheAdapter());
}

export function resolveWebBundle(
  options: ResolveWebBundleOptions
): ReturnType<typeof resolveWebBundleWithAdapter> {
  return resolveWebBundleWithAdapter({ ...options, cacheAdapter: cacheAdapter() });
}

export function rollbackWebBundle(
  cacheDirectory: string,
  currentGenerationId?: string,
  requestedUrl?: string
): ReturnType<typeof rollbackWebBundleWithAdapter> {
  return rollbackWebBundleWithAdapter(
    cacheDirectory,
    cacheAdapter(),
    currentGenerationId,
    requestedUrl
  );
}

export async function clearLocalWebViewCache(
  virtualUrl: string,
  cacheDirectory?: string
): Promise<void> {
  const adapter = cacheAdapter();
  const directory = cacheDirectory ?? cacheDirectoryForOriginWithAdapter(virtualUrl, adapter);
  if (await adapter.exists(directory)) await adapter.remove(directory);
}
