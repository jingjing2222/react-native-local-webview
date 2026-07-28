import type { LocalWebViewCacheAdapter } from './localWebViewCacheAdapter';
import {
  cacheDirectoryForOrigin as cacheDirectoryForOriginWithAdapter,
  readMirroredWebBundle as readMirroredWebBundleWithAdapter,
  resolveWebBundle as resolveWebBundleWithAdapter,
  rollbackWebBundle as rollbackWebBundleWithAdapter,
  type ResolveWebBundleOptions as InternalResolveWebBundleOptions,
} from './mirrorWebBundle';
import { getNativeCacheAdapter } from './nativeCacheAdapter';

export type ResolveWebBundleOptions = Omit<InternalResolveWebBundleOptions, 'cacheAdapter'>;

function nativeAdapter(): LocalWebViewCacheAdapter {
  return getNativeCacheAdapter();
}

export function cacheDirectoryForOrigin(virtualUrl: string): string {
  return cacheDirectoryForOriginWithAdapter(virtualUrl, nativeAdapter());
}

export function readMirroredWebBundle(source: string): Promise<string> {
  return readMirroredWebBundleWithAdapter(source, nativeAdapter());
}

export function resolveWebBundle(
  options: ResolveWebBundleOptions
): ReturnType<typeof resolveWebBundleWithAdapter> {
  return resolveWebBundleWithAdapter({ ...options, cacheAdapter: nativeAdapter() });
}

export function rollbackWebBundle(
  cacheDirectory: string,
  currentGenerationId?: string,
  requestedUrl?: string
): ReturnType<typeof rollbackWebBundleWithAdapter> {
  return rollbackWebBundleWithAdapter(
    cacheDirectory,
    nativeAdapter(),
    currentGenerationId,
    requestedUrl
  );
}

export async function clearLocalWebViewCache(
  virtualUrl: string,
  cacheDirectory?: string
): Promise<void> {
  const adapter = nativeAdapter();
  const directory = cacheDirectory ?? cacheDirectoryForOriginWithAdapter(virtualUrl, adapter);
  if (await adapter.exists(directory)) await adapter.remove(directory);
}
