import { URL } from 'react-native-url-polyfill';

import { selectCacheGenerations } from './cachePolicy';
import { base64ToBytes, bytesToUtf8, sha256Text, utf8ByteLength } from './binary';
import {
  ContentSecurityPolicyError,
  localizeWebDocument,
  mediaTypeFromPath,
  type LoadedResource,
  type ResourceDelivery,
  type ResourceLoadOptions,
  type ResourceLoader,
} from './resourceGraph';
import {
  hexDigestToBase64,
  strongestIntegrityAlgorithm,
  type SubresourceIntegrityDigests,
} from './subresourceIntegrity';
import {
  createAbortError,
  LocalWebViewDownloadLimitError,
  throwIfAborted,
  type LocalWebViewCacheAdapter,
} from './localWebViewCacheAdapter';

export type CachePolicy = {
  /**
   * Maximum on-disk bytes retained for one origin.
   *
   * @default 536870912 (512 MiB)
   */
  maxBytes?: number;
  /**
   * Maximum raw bytes for a resource that must be embedded into the HTML as a
   * data URL. Larger runtime data/WASM files remain as streamable files.
   *
   * @default 33554432 (32 MiB)
   */
  maxInlineBytes?: number;
  /**
   * Number of complete generations retained for rollback.
   *
   * @default 2
   */
  maxGenerations?: number;
};

export type WebBundleValidationMode = 'content-hash' | 'release-etag';

export type MirroredWebBundle = {
  /**
   * Final same-origin document URL after validated entry redirects.
   */
  baseUrl: string;
  downloadedAssets: string[];
  generationId: string;
  localAssets: Record<string, MirroredLocalAsset>;
  rollbackAvailable: boolean;
  sourcePath: string;
  totalBytes: number;
  usedCachedBundle: boolean;
};

export type MirroredLocalAsset = {
  integrity: Required<SubresourceIntegrityDigests>;
  mediaType: string;
  path: string;
  redirected: boolean;
  responseHeaders?: Record<string, string>;
  responseUrl: string;
  sha256: string;
  size: number;
  url: string;
};

export type ResolveWebBundleOptions = {
  /**
   * Host-provided persistent file, hashing, and download implementation.
   */
  cacheAdapter: LocalWebViewCacheAdapter;
  /**
   * Remove CSP declarations that would otherwise be silently lost when HTML is
   * handed to a WebView as a string.
   *
   * @default false
   */
  allowContentSecurityPolicyBypass?: boolean;
  cacheDirectory?: string;
  cachePolicy?: CachePolicy;
  forceRefresh?: boolean;
  /**
   * Called as soon as an atomically published generation can be identified
   * from cache state and its entry path. The configured validation strategy
   * runs afterwards, before `onCachedBundle` is called.
   *
   * This latency-sensitive hook lets a WebView start a warm local navigation
   * without waiting for validation of every large WebGL payload.
   */
  onPublishedBundle?: (bundle: MirroredWebBundle | undefined) => Promise<void> | void;
  /**
   * Called after the durable cache has been validated, before any network
   * revalidation or download starts. `undefined` means that no usable local
   * generation exists yet.
   *
   * This lets a WebView show the remote HTTPS document immediately on first
   * install while the mirror is populated in the background.
   */
  onCachedBundle?: (bundle: MirroredWebBundle | undefined) => Promise<void> | void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  /**
   * Additional absolute HTTPS origins whose resources may cross the native
   * download boundary. The entry origin is always trusted.
   */
  trustedAssetOrigins?: string[];
  /**
   * Select how a cached release is validated. `release-etag` requires the
   * entry ETag to represent the complete release and avoids warm local hashes
   * and per-resource revalidation.
   *
   * @default 'content-hash'
   */
  validationMode?: WebBundleValidationMode;
  virtualUrl: string;
};

type RemoteAssetMetadata = {
  contentSecurityPolicy?: string;
  contentSecurityPolicyReportOnly?: string;
  declaredMediaType?: string;
  delivery: ResourceDelivery;
  etag?: string;
  integrity: SubresourceIntegrityDigests;
  localFile?: string;
  mediaType: string;
  redirected: boolean;
  responseHeaders?: Record<string, string>;
  responseUrl: string;
  sha256: string;
  size: number;
  url: string;
};

type GenerationManifest = {
  bundleEtag?: string;
  createdAt: string;
  downloadedAssets: string[];
  documentFragment: string;
  documentFragmentInherited: boolean;
  documentUrl: string;
  entryUrl: string;
  formatVersion: typeof CACHE_FORMAT_VERSION;
  generationId: string;
  remoteAssets: RemoteAssetMetadata[];
  securityPolicyFingerprint: string;
  sourceSha256: string;
  totalBytes: number;
  validationMode: WebBundleValidationMode;
};

type GenerationSummary = {
  createdAt: string;
  generationId: string;
  securityPolicyFingerprint: string;
  totalBytes: number;
};

type CacheState = {
  activeGeneration: string;
  formatVersion: typeof CACHE_FORMAT_VERSION;
  generations: GenerationSummary[];
};

type DownloadResult =
  | {
      contentSecurityPolicy?: string;
      contentSecurityPolicyReportOnly?: string;
      declaredMediaType?: string;
      documentFragmentInherited: boolean;
      documentUrl: string;
      etag?: string;
      redirected: boolean;
      responseUrl: string;
      status: 'not-modified';
    }
  | {
      asset: LoadedResource;
      documentFragmentInherited: boolean;
      documentUrl: string;
      status: 'downloaded';
    };

type PreparedBundle = {
  bundleEtag?: string;
  downloadedAssets: string[];
  documentFragment: string;
  documentFragmentInherited: boolean;
  documentUrl: string;
  html: string;
  remoteAssets: LoadedResource[];
};

const CACHE_FORMAT_VERSION = 14;
const CACHE_STATE_OVERHEAD_BYTES_PER_GENERATION = 256;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_GENERATIONS = 2;
const DEFAULT_MAX_INLINE_BYTES = 32 * 1024 * 1024;
const REVALIDATION_CONCURRENCY = 6;
const MAX_REDIRECTS = 10;
const RUNTIME_RESPONSE_HEADER_NAMES = new Set([
  'access-control-allow-credentials',
  'access-control-allow-origin',
  'access-control-expose-headers',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'etag',
  'last-modified',
  'timing-allow-origin',
]);

type ResolvedSecurityPolicy = {
  allowContentSecurityPolicyBypass: boolean;
  entryOrigin: string;
  fingerprint: string;
  trustedOrigins: string[];
};

export type WebBundleCacheRequest = {
  cacheDirectory: string;
  generationId?: string;
  maxBytes: number;
  securityPolicyFingerprint: string;
  validationMode: WebBundleValidationMode;
  virtualUrl: string;
};

class RequiredReleaseEtagError extends Error {
  override readonly name = 'RequiredReleaseEtagError';
}

function requiredReleaseEtag(value: string | undefined, url: string): string {
  if (value && isSafeRuntimeHeaderValue(value)) return value;
  throw new RequiredReleaseEtagError(
    `validationMode="release-etag" requires the entry response to include an ETag: ${url}`
  );
}

async function mkdir(cacheAdapter: LocalWebViewCacheAdapter, path: string): Promise<void> {
  if (await cacheAdapter.exists(path)) return;
  try {
    await cacheAdapter.makeDirectory(path);
  } catch (error) {
    if (!(await cacheAdapter.exists(path))) throw error;
  }
}

let temporaryFileSequence = 0;
let generationSequence = 0;
let cacheStateSequence = 0;

const cacheOperationTails = new Map<string, Promise<void>>();
const cacheRuntimes = new Map<
  string,
  { cacheAdapter: LocalWebViewCacheAdapter; policy: Required<CachePolicy> }
>();
const generationLeases = new Map<string, Map<string, number>>();

async function waitForLock(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    await previous;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    previous.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

async function withCacheLock<T>(
  cacheDirectory: string,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const previous = cacheOperationTails.get(cacheDirectory) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  cacheOperationTails.set(cacheDirectory, tail);
  try {
    await waitForLock(
      previous.catch(() => undefined),
      signal
    );
    throwIfAborted(signal);
    return await operation();
  } finally {
    release?.();
    void tail.then(() => {
      if (cacheOperationTails.get(cacheDirectory) === tail) {
        cacheOperationTails.delete(cacheDirectory);
      }
    });
  }
}

function leasedGenerationIds(cacheDirectory: string): Set<string> {
  return new Set(generationLeases.get(cacheDirectory)?.keys() ?? []);
}

/**
 * Protect a generation while a mounted WebView may still stream its files.
 */
export function retainWebBundle(cacheDirectory: string, generationId: string): () => void {
  const leases = generationLeases.get(cacheDirectory) ?? new Map<string, number>();
  leases.set(generationId, (leases.get(generationId) ?? 0) + 1);
  generationLeases.set(cacheDirectory, leases);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = generationLeases.get(cacheDirectory);
    if (!current) return;
    const nextCount = (current.get(generationId) ?? 1) - 1;
    if (nextCount > 0) current.set(generationId, nextCount);
    else current.delete(generationId);
    if (current.size === 0) generationLeases.delete(cacheDirectory);

    const runtime = cacheRuntimes.get(cacheDirectory);
    if (!runtime) return;
    void withCacheLock(cacheDirectory, async () => {
      const state = await readCacheState(runtime.cacheAdapter, cacheDirectory);
      if (!state) {
        await removeUnreferencedGenerationDirectories(runtime.cacheAdapter, cacheDirectory);
        return;
      }
      const pruned = await applyCachePolicy(
        cacheDirectory,
        state,
        runtime.policy,
        runtime.cacheAdapter
      );
      await removeUnreferencedGenerationDirectories(runtime.cacheAdapter, cacheDirectory, pruned);
    }).catch(() => undefined);
  };
}

function assertHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:' || !url.hostname) {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  return url;
}

function parseIpv4Address(value: string): number[] | undefined {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
}

function isNonPublicIpv4(octets: number[]): boolean {
  const [first = 0, second = 0, third = 0] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIpv6Address(value: string): number[] | undefined {
  if (value.split('::').length > 2) return undefined;
  const hasCompression = value.includes('::');
  const [left = '', right = ''] = value.split('::');
  const parseSide = (side: string): number[] | undefined => {
    if (!side) return [];
    const parts = side.split(':');
    const result: number[] = [];
    for (const [index, part] of parts.entries()) {
      const ipv4 = parseIpv4Address(part);
      if (ipv4) {
        if (index !== parts.length - 1) return undefined;
        result.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
        continue;
      }
      if (!/^[a-f\d]{1,4}$/i.test(part)) return undefined;
      result.push(Number.parseInt(part, 16));
    }
    return result;
  };
  const leftParts = parseSide(left);
  const rightParts = parseSide(right);
  if (!leftParts || !rightParts) return undefined;
  const explicitCount = leftParts.length + rightParts.length;
  if ((!hasCompression && explicitCount !== 8) || (hasCompression && explicitCount >= 8)) {
    return undefined;
  }
  return [
    ...leftParts,
    ...Array.from({ length: hasCompression ? 8 - explicitCount : 0 }, () => 0),
    ...rightParts,
  ];
}

function isPrivateNetworkHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)]$/, '$1')
    .replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;

  const ipv4 = parseIpv4Address(normalized);
  if (ipv4) return isNonPublicIpv4(ipv4);
  if (!normalized.includes(':')) return false;

  const ipv6 = parseIpv6Address(normalized);
  if (!ipv6) return true;
  const isIpv4Embedded =
    ipv6.slice(0, 5).every((part) => part === 0) && (ipv6[5] === 0 || ipv6[5] === 0xffff);
  if (isIpv4Embedded) {
    return isNonPublicIpv4([ipv6[6]! >>> 8, ipv6[6]! & 0xff, ipv6[7]! >>> 8, ipv6[7]! & 0xff]);
  }
  // Publicly routable IPv6 unicast currently occupies 2000::/3. Keep
  // documentation space out even though it is inside that aggregate.
  const globallyRoutable = (ipv6[0]! & 0xe000) === 0x2000;
  const documentationRange = ipv6[0] === 0x2001 && ipv6[1] === 0x0db8;
  return !globallyRoutable || documentationRange;
}

function assertPublicHttpsUrl(value: string, label: string): URL {
  const url = assertHttpsUrl(value, label);
  if (url.username || url.password || isPrivateNetworkHostname(url.hostname)) {
    throw new Error(`${label} must use a public HTTPS host without credentials`);
  }
  return url;
}

function resolveSecurityPolicy({
  allowContentSecurityPolicyBypass = false,
  trustedAssetOrigins = [],
  virtualUrl,
}: Pick<
  ResolveWebBundleOptions,
  'allowContentSecurityPolicyBypass' | 'trustedAssetOrigins' | 'virtualUrl'
>): ResolvedSecurityPolicy {
  const entry = assertPublicHttpsUrl(virtualUrl, 'virtualUrl');
  const origins = new Set([entry.origin]);
  for (const [index, value] of trustedAssetOrigins.entries()) {
    const url = assertPublicHttpsUrl(value, `trustedAssetOrigins[${index}]`);
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`trustedAssetOrigins[${index}] must contain an origin only`);
    }
    origins.add(url.origin);
  }
  const trustedOrigins = [...origins].sort();
  return {
    allowContentSecurityPolicyBypass,
    entryOrigin: entry.origin,
    fingerprint: sha256Text(
      JSON.stringify({
        allowContentSecurityPolicyBypass,
        entryUrl: canonicalResourceUrl(entry.toString()),
        trustedOrigins,
      })
    ),
    trustedOrigins,
  };
}

function resolveBundlePolicy({
  allowContentSecurityPolicyBypass = false,
  cachePolicy,
  trustedAssetOrigins,
  validationMode = 'content-hash',
  virtualUrl,
}: Pick<
  ResolveWebBundleOptions,
  | 'allowContentSecurityPolicyBypass'
  | 'cachePolicy'
  | 'trustedAssetOrigins'
  | 'validationMode'
  | 'virtualUrl'
>): {
  generationPolicyFingerprint: string;
  policy: Required<CachePolicy>;
  security: ResolvedSecurityPolicy;
} {
  if (validationMode !== 'content-hash' && validationMode !== 'release-etag') {
    throw new Error('validationMode must be "content-hash" or "release-etag"');
  }
  const security = resolveSecurityPolicy({
    allowContentSecurityPolicyBypass,
    trustedAssetOrigins,
    virtualUrl,
  });
  const policy = {
    maxBytes: cachePolicy?.maxBytes ?? DEFAULT_MAX_BYTES,
    maxGenerations: cachePolicy?.maxGenerations ?? DEFAULT_MAX_GENERATIONS,
    maxInlineBytes: cachePolicy?.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES,
  };
  if (
    !Number.isSafeInteger(policy.maxBytes) ||
    policy.maxBytes <= 0 ||
    !Number.isSafeInteger(policy.maxGenerations) ||
    policy.maxGenerations < 1 ||
    !Number.isSafeInteger(policy.maxInlineBytes) ||
    policy.maxInlineBytes < 1
  ) {
    throw new Error(
      'cachePolicy requires maxBytes > 0, maxGenerations >= 1, and maxInlineBytes > 0; all must be positive safe integers'
    );
  }
  return {
    generationPolicyFingerprint: sha256Text(
      JSON.stringify({
        maxInlineBytes: policy.maxInlineBytes,
        security: security.fingerprint,
        validationMode,
      })
    ),
    policy,
    security,
  };
}

export function createWebBundleCacheRequest({
  cacheDirectory,
  generationId,
  ...options
}: Pick<
  ResolveWebBundleOptions,
  | 'allowContentSecurityPolicyBypass'
  | 'cachePolicy'
  | 'trustedAssetOrigins'
  | 'validationMode'
  | 'virtualUrl'
> & {
  cacheDirectory: string;
  generationId?: string;
}): WebBundleCacheRequest {
  const { generationPolicyFingerprint, policy } = resolveBundlePolicy(options);
  return {
    cacheDirectory,
    generationId,
    maxBytes: policy.maxBytes,
    securityPolicyFingerprint: generationPolicyFingerprint,
    validationMode: options.validationMode ?? 'content-hash',
    virtualUrl: options.virtualUrl,
  };
}

function assertTrustedAssetUrl(
  value: string,
  policy: ResolvedSecurityPolicy,
  label = 'Asset URL'
): URL {
  const url = assertPublicHttpsUrl(value, label);
  if (!policy.trustedOrigins.includes(url.origin)) {
    throw new Error(`${label} uses an untrusted origin: ${url.origin}`);
  }
  return url;
}

function isTrustedAssetUrl(value: string, policy: ResolvedSecurityPolicy): boolean {
  try {
    assertTrustedAssetUrl(value, policy);
    return true;
  } catch {
    return false;
  }
}

function setUrlHash(url: URL, hash: string): void {
  Reflect.set(url, 'hash', hash);
}

function canonicalResourceUrl(value: string, base?: string): string {
  const url = new URL(value, base);
  setUrlHash(url, '');
  return url.toString();
}

function resolveDocumentRedirectUrl(value: string, currentDocumentUrl: string): string {
  const resolved = new URL(value, currentDocumentUrl);
  if (!value.includes('#')) {
    setUrlHash(resolved, new URL(currentDocumentUrl).hash);
  }
  return resolved.toString();
}

function documentUrlForRequest(
  documentUrl: string,
  documentFragment: string,
  documentFragmentInherited: boolean,
  requestedUrl: string
): string {
  const resolved = new URL(documentUrl);
  setUrlHash(resolved, documentFragmentInherited ? new URL(requestedUrl).hash : documentFragment);
  return resolved.toString();
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1]?.trim() || undefined;
}

function isSafeRuntimeHeaderValue(value: string): boolean {
  return (
    value.length > 0 && !value.includes('\u0000') && !value.includes('\r') && !value.includes('\n')
  );
}

function runtimeResponseHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const selected: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    const normalizedValue = value.trim();
    if (
      RUNTIME_RESPONSE_HEADER_NAMES.has(normalizedName) &&
      isSafeRuntimeHeaderValue(normalizedValue)
    ) {
      selected[normalizedName] = normalizedValue;
    }
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function stringRecordsEqual(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([name, value], index) =>
        name === rightEntries[index]?.[0] && value === rightEntries[index]?.[1]
    )
  );
}

async function canonicalFileHashes(
  cacheAdapter: LocalWebViewCacheAdapter,
  path: string,
  algorithms: readonly ('sha256' | 'sha384' | 'sha512')[]
): Promise<Partial<Record<'sha256' | 'sha384' | 'sha512', string>>> {
  const uniqueAlgorithms = [...new Set(algorithms)];
  return canonicalHashes(await cacheAdapter.hashFile(path, uniqueAlgorithms), uniqueAlgorithms);
}

function canonicalHashes(
  digests: Partial<Record<'sha256' | 'sha384' | 'sha512', string>>,
  algorithms: readonly ('sha256' | 'sha384' | 'sha512')[]
): Partial<Record<'sha256' | 'sha384' | 'sha512', string>> {
  const normalized: Partial<Record<'sha256' | 'sha384' | 'sha512', string>> = {};
  for (const algorithm of algorithms) {
    const digest = digests[algorithm];
    const expectedLength = algorithm === 'sha256' ? 64 : algorithm === 'sha384' ? 96 : 128;
    if (
      typeof digest !== 'string' ||
      digest.length !== expectedLength ||
      !/^[a-fA-F0-9]+$/.test(digest)
    ) {
      throw new Error(
        `${algorithm} cache adapter digest must be ${expectedLength} hexadecimal characters`
      );
    }
    normalized[algorithm] = digest.toLowerCase();
  }
  return normalized;
}

async function canonicalFileHash(
  cacheAdapter: LocalWebViewCacheAdapter,
  path: string,
  algorithm: 'sha256' | 'sha384' | 'sha512'
): Promise<string> {
  return (await canonicalFileHashes(cacheAdapter, path, [algorithm]))[algorithm]!;
}

async function downloadWithoutRedirects(
  cacheAdapter: LocalWebViewCacheAdapter,
  url: string,
  temporaryPath: string,
  headers: Record<string, string>,
  policy: ResolvedSecurityPolicy,
  sameOriginRedirectsOnly: boolean,
  maxBytes?: number,
  hashAlgorithms?: readonly ('sha256' | 'sha384' | 'sha512')[],
  signal?: AbortSignal
): Promise<{
  bytesWritten?: number;
  digests?: Partial<Record<'sha256' | 'sha384' | 'sha512', string>>;
  documentFragmentInherited: boolean;
  documentUrl: string;
  finalUrl: string;
  headers: Record<string, string> | undefined;
  redirected: boolean;
  status: number;
  wroteFile?: boolean;
}> {
  let currentDocumentUrl = assertTrustedAssetUrl(url, policy).toString();
  let currentUrl = canonicalResourceUrl(currentDocumentUrl);
  let documentFragmentInherited = true;
  const initialOrigin = new URL(currentUrl).origin;
  const visited = new Set<string>();
  for (let redirects = 0; ; redirects += 1) {
    throwIfAborted(signal);
    if (visited.has(currentUrl)) throw new Error(`Redirect loop while downloading ${url}`);
    visited.add(currentUrl);
    const info = await cacheAdapter.download({
      followRedirect: false,
      hashAlgorithms,
      headers: {
        ...headers,
        ...(new URL(currentUrl).origin === policy.entryOrigin
          ? {}
          : { Origin: policy.entryOrigin }),
      },
      maxBytes,
      overwrite: true,
      path: temporaryPath,
      signal,
      timeoutMs: 30_000,
      url: currentUrl,
    });
    const responseHeaders = info.headers;
    if (![301, 302, 303, 307, 308].includes(info.status)) {
      const responseUrl = info.responseUrl || currentUrl;
      const finalDocumentUrl = assertTrustedAssetUrl(
        resolveDocumentRedirectUrl(responseUrl, currentDocumentUrl),
        policy,
        'Native response URL'
      );
      const finalUrl = assertTrustedAssetUrl(responseUrl, policy, 'Native response URL');
      if (sameOriginRedirectsOnly && finalUrl.origin !== initialOrigin) {
        throw new Error(`Entry redirect target changes origin: ${finalUrl.origin}`);
      }
      return {
        bytesWritten: info.bytesWritten,
        digests: info.digests,
        documentFragmentInherited: documentFragmentInherited && !responseUrl.includes('#'),
        documentUrl: finalDocumentUrl.toString(),
        finalUrl: canonicalResourceUrl(finalUrl.toString()),
        headers: responseHeaders,
        redirected: redirects > 0 || canonicalResourceUrl(responseUrl) !== currentUrl,
        status: info.status,
        wroteFile: info.wroteFile,
      };
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects while downloading ${url}`);
    }
    const location = header(responseHeaders, 'location');
    if (!location) throw new Error(`HTTP ${info.status} without Location while downloading ${url}`);
    const nextDocumentUrl = resolveDocumentRedirectUrl(location, currentDocumentUrl);
    const nextUrl = canonicalResourceUrl(nextDocumentUrl);
    const validatedTarget = assertTrustedAssetUrl(nextUrl, policy, 'Redirect target');
    if (sameOriginRedirectsOnly && validatedTarget.origin !== initialOrigin) {
      throw new Error(`Entry redirect target changes origin: ${validatedTarget.origin}`);
    }
    documentFragmentInherited = documentFragmentInherited && !location.includes('#');
    currentDocumentUrl = nextDocumentUrl;
    currentUrl = canonicalResourceUrl(validatedTarget.toString());
    if (info.wroteFile === true) {
      await cacheAdapter.remove(temporaryPath);
    } else if (info.wroteFile === undefined && (await cacheAdapter.exists(temporaryPath))) {
      await cacheAdapter.remove(temporaryPath);
    }
  }
}

async function downloadResource(
  cacheAdapter: LocalWebViewCacheAdapter,
  stagingDirectory: string,
  url: string,
  policy: ResolvedSecurityPolicy,
  etag?: string,
  {
    accountDownloadedBytes,
    completeFileIntegrity = true,
    delivery = 'inline',
    documentRequestUrl,
    integrity: integrityMetadata,
    maxDownloadBytes,
    preserveFile = false,
    sameOriginRedirectsOnly = false,
  }: ResourceLoadOptions & {
    accountDownloadedBytes?: (size: number, url: string, delivery: ResourceDelivery) => void;
    completeFileIntegrity?: boolean;
    documentRequestUrl?: string;
    maxDownloadBytes?: number;
    preserveFile?: boolean;
    sameOriginRedirectsOnly?: boolean;
  } = {},
  signal?: AbortSignal
): Promise<DownloadResult> {
  throwIfAborted(signal);
  const temporaryPath = `${stagingDirectory}/download-${Date.now()}-${temporaryFileSequence++}`;
  const hashAlgorithms: Array<'sha256' | 'sha384' | 'sha512'> = ['sha256'];
  if (delivery === 'file' && completeFileIntegrity) {
    hashAlgorithms.push('sha384', 'sha512');
  } else {
    const strongestIntegrity = strongestIntegrityAlgorithm(integrityMetadata);
    if (strongestIntegrity && strongestIntegrity !== 'sha256')
      hashAlgorithms.push(strongestIntegrity);
  }
  let keepFile = false;
  let completedDownload:
    | {
        bytesWritten?: number;
        wroteFile?: boolean;
      }
    | undefined;
  try {
    const result = await downloadWithoutRedirects(
      cacheAdapter,
      documentRequestUrl ?? url,
      temporaryPath,
      {
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      policy,
      sameOriginRedirectsOnly,
      maxDownloadBytes,
      hashAlgorithms,
      signal
    );
    completedDownload = result;
    throwIfAborted(signal);
    const contentSecurityPolicy = header(result.headers, 'content-security-policy');
    const contentSecurityPolicyReportOnly = header(
      result.headers,
      'content-security-policy-report-only'
    );
    const declaredMediaType = header(result.headers, 'content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (result.status === 304) {
      return {
        contentSecurityPolicy,
        contentSecurityPolicyReportOnly,
        declaredMediaType,
        documentFragmentInherited: result.documentFragmentInherited,
        documentUrl: result.documentUrl,
        etag: header(result.headers, 'etag'),
        redirected: result.redirected,
        responseUrl: result.finalUrl,
        status: 'not-modified',
      };
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`HTTP ${result.status} while downloading ${url}`);
    }
    const contentEncoding = header(result.headers, 'content-encoding')?.toLowerCase();
    if (contentEncoding && contentEncoding !== 'identity') {
      throw new Error(
        `Unsupported encoded response (${contentEncoding}) for ${url}. Serve identity bytes or use the WebGL build's decompression-fallback artifact.`
      );
    }
    if (result.wroteFile === false) {
      throw new Error(`Native download did not create a file for HTTP ${result.status}: ${url}`);
    }
    const size =
      result.bytesWritten === undefined
        ? Number((await cacheAdapter.stat(temporaryPath)).size)
        : result.bytesWritten;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Native download reported an invalid byte size for ${url}`);
    }
    throwIfAborted(signal);
    accountDownloadedBytes?.(size, url, delivery);
    const hashes =
      result.digests === undefined
        ? await canonicalFileHashes(cacheAdapter, temporaryPath, hashAlgorithms)
        : canonicalHashes(result.digests, hashAlgorithms);
    throwIfAborted(signal);
    const sha256 = hashes.sha256!;
    const integrity: SubresourceIntegrityDigests = {
      sha256: hexDigestToBase64(sha256),
    };
    for (const algorithm of hashAlgorithms) {
      if (algorithm !== 'sha256') integrity[algorithm] = hexDigestToBase64(hashes[algorithm]!);
    }
    const content =
      delivery === 'inline' ? await cacheAdapter.readFile(temporaryPath, 'base64') : undefined;
    throwIfAborted(signal);
    const inferredMediaType = mediaTypeFromPath(new URL(result.finalUrl).pathname);
    const mediaType =
      inferredMediaType !== 'application/octet-stream' &&
      (!declaredMediaType ||
        [
          'application/br',
          'application/gzip',
          'application/octet-stream',
          'application/x-gzip',
        ].includes(declaredMediaType))
        ? inferredMediaType
        : declaredMediaType || inferredMediaType;
    keepFile = delivery === 'file' && preserveFile;
    return {
      asset: {
        content,
        contentSecurityPolicy,
        contentSecurityPolicyReportOnly,
        declaredMediaType: declaredMediaType ?? 'application/octet-stream',
        delivery,
        encoding: 'base64',
        etag: header(result.headers, 'etag'),
        integrity,
        localPath: delivery === 'file' && preserveFile ? temporaryPath : undefined,
        mediaType,
        redirected: result.redirected,
        responseHeaders: runtimeResponseHeaders(result.headers),
        responseUrl: result.finalUrl,
        sha256,
        size,
        url,
      },
      documentFragmentInherited: result.documentFragmentInherited,
      documentUrl: result.documentUrl,
      status: 'downloaded',
    };
  } finally {
    if (!keepFile) {
      if (completedDownload?.wroteFile === true) {
        await cacheAdapter.remove(temporaryPath);
      } else if (
        completedDownload?.wroteFile === undefined &&
        (await cacheAdapter.exists(temporaryPath))
      ) {
        await cacheAdapter.remove(temporaryPath);
      }
    }
  }
}

async function ensureResourceIntegrity(
  cacheAdapter: LocalWebViewCacheAdapter,
  asset: LoadedResource,
  metadata: string | undefined
): Promise<void> {
  const algorithm = strongestIntegrityAlgorithm(metadata);
  if (!algorithm || asset.integrity?.[algorithm] || asset.content !== undefined) return;
  if (!asset.localPath) {
    throw new Error(`Cannot verify ${algorithm} Subresource Integrity for ${asset.url}`);
  }
  asset.integrity ??= {};
  asset.integrity[algorithm] = hexDigestToBase64(
    await canonicalFileHash(cacheAdapter, asset.localPath, algorithm)
  );
}

function metadataForAsset(asset: LoadedResource, localFile?: string): RemoteAssetMetadata {
  if (
    (asset.delivery ?? 'inline') === 'file' &&
    (!asset.integrity?.sha256 || !asset.integrity.sha384 || !asset.integrity.sha512)
  ) {
    throw new Error(`Complete Subresource Integrity metadata is unavailable for ${asset.url}`);
  }
  return {
    contentSecurityPolicy: asset.contentSecurityPolicy,
    contentSecurityPolicyReportOnly: asset.contentSecurityPolicyReportOnly,
    declaredMediaType: asset.declaredMediaType,
    delivery: asset.delivery ?? 'inline',
    etag: asset.etag,
    integrity: asset.integrity ?? { sha256: hexDigestToBase64(asset.sha256) },
    localFile,
    mediaType: asset.mediaType,
    redirected:
      asset.redirected ??
      canonicalResourceUrl(asset.responseUrl ?? asset.url) !== canonicalResourceUrl(asset.url),
    responseHeaders: asset.responseHeaders,
    responseUrl: asset.responseUrl ?? asset.url,
    sha256: asset.sha256,
    size: asset.size,
    url: asset.url,
  };
}

function manifestPath(cacheDirectory: string, generationId: string): string {
  return `${cacheDirectory}/generations/${generationId}/manifest.json`;
}

function sourcePath(cacheDirectory: string, generationId: string): string {
  return `${cacheDirectory}/generations/${generationId}/index.html`;
}

async function readJson<T>(
  cacheAdapter: LocalWebViewCacheAdapter,
  path: string
): Promise<T | undefined> {
  if (!(await cacheAdapter.exists(path))) return undefined;
  const contents = await cacheAdapter.readFile(path, 'utf8');
  try {
    return JSON.parse(contents) as T;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSerializedHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isGenerationId(value: unknown): value is string {
  return typeof value === 'string' && /^\d+-\d+-[a-f0-9]{8}-[a-f0-9]{8}$/.test(value);
}

function isGenerationSummary(value: unknown): value is GenerationSummary {
  return (
    isRecord(value) &&
    typeof value.createdAt === 'string' &&
    isGenerationId(value.generationId) &&
    typeof value.securityPolicyFingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(value.securityPolicyFingerprint) &&
    typeof value.totalBytes === 'number' &&
    Number.isFinite(value.totalBytes) &&
    value.totalBytes >= 0
  );
}

function isCacheState(value: unknown): value is CacheState {
  return (
    isRecord(value) &&
    value.formatVersion === CACHE_FORMAT_VERSION &&
    isGenerationId(value.activeGeneration) &&
    Array.isArray(value.generations) &&
    value.generations.every(isGenerationSummary) &&
    value.generations.some((generation) => generation.generationId === value.activeGeneration)
  );
}

function isRemoteAssetMetadata(value: unknown): value is RemoteAssetMetadata {
  if (
    !isRecord(value) ||
    (value.delivery !== 'inline' && value.delivery !== 'file') ||
    !isRecord(value.integrity) ||
    typeof value.mediaType !== 'string' ||
    typeof value.redirected !== 'boolean' ||
    !isSerializedHttpsUrl(value.responseUrl) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.size !== 'number' ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    !isSerializedHttpsUrl(value.url)
  ) {
    return false;
  }
  return (
    (value.contentSecurityPolicy === undefined ||
      typeof value.contentSecurityPolicy === 'string') &&
    (value.contentSecurityPolicyReportOnly === undefined ||
      typeof value.contentSecurityPolicyReportOnly === 'string') &&
    (value.declaredMediaType === undefined || typeof value.declaredMediaType === 'string') &&
    (value.etag === undefined || typeof value.etag === 'string') &&
    (value.integrity.sha256 === undefined || typeof value.integrity.sha256 === 'string') &&
    (value.integrity.sha384 === undefined || typeof value.integrity.sha384 === 'string') &&
    (value.integrity.sha512 === undefined || typeof value.integrity.sha512 === 'string') &&
    (value.localFile === undefined || value.localFile === `assets/${value.sha256}`) &&
    (value.responseHeaders === undefined ||
      (isRecord(value.responseHeaders) &&
        Object.entries(value.responseHeaders).every(
          ([name, headerValue]) =>
            RUNTIME_RESPONSE_HEADER_NAMES.has(name) &&
            typeof headerValue === 'string' &&
            isSafeRuntimeHeaderValue(headerValue)
        )))
  );
}

function isGenerationManifest(value: unknown, generationId: string): value is GenerationManifest {
  return (
    isRecord(value) &&
    value.formatVersion === CACHE_FORMAT_VERSION &&
    value.generationId === generationId &&
    (value.validationMode === 'release-etag' || value.validationMode === 'content-hash') &&
    (value.bundleEtag === undefined || typeof value.bundleEtag === 'string') &&
    (value.validationMode !== 'release-etag' ||
      (typeof value.bundleEtag === 'string' && value.bundleEtag.length > 0)) &&
    Array.isArray(value.downloadedAssets) &&
    value.downloadedAssets.every((url) => typeof url === 'string') &&
    typeof value.documentFragment === 'string' &&
    (value.documentFragment === '' || value.documentFragment.startsWith('#')) &&
    typeof value.documentFragmentInherited === 'boolean' &&
    isSerializedHttpsUrl(value.documentUrl) &&
    isSerializedHttpsUrl(value.entryUrl) &&
    Array.isArray(value.remoteAssets) &&
    value.remoteAssets.every(isRemoteAssetMetadata) &&
    typeof value.securityPolicyFingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(value.securityPolicyFingerprint) &&
    typeof value.sourceSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sourceSha256) &&
    typeof value.totalBytes === 'number' &&
    Number.isFinite(value.totalBytes) &&
    value.totalBytes >= 0
  );
}

async function readCacheState(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string
): Promise<CacheState | undefined> {
  const current = await readJson<unknown>(cacheAdapter, `${cacheDirectory}/state.json`);
  if (isCacheState(current)) return current;
  const previous = await readJson<unknown>(cacheAdapter, `${cacheDirectory}/state.previous.json`);
  return isCacheState(previous) ? previous : undefined;
}

async function writeCacheState(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string,
  state: CacheState
): Promise<void> {
  const statePath = `${cacheDirectory}/state.json`;
  const previousPath = `${cacheDirectory}/state.previous.json`;
  const nextPath = `${cacheDirectory}/state.next-${Date.now()}-${cacheStateSequence++}.json`;
  await cacheAdapter.writeFile(nextPath, JSON.stringify(state), 'utf8');
  if (await cacheAdapter.exists(statePath)) {
    if (await cacheAdapter.exists(previousPath)) await cacheAdapter.remove(previousPath);
    await cacheAdapter.copyFile(statePath, previousPath);
    await cacheAdapter.remove(statePath);
  }
  await cacheAdapter.moveFile(nextPath, statePath);
}

async function writePreviousCacheState(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string,
  state: CacheState
): Promise<void> {
  const previousPath = `${cacheDirectory}/state.previous.json`;
  const nextPath = `${cacheDirectory}/state.previous.next-${Date.now()}-${cacheStateSequence++}.json`;
  await cacheAdapter.writeFile(nextPath, JSON.stringify(state), 'utf8');
  if (await cacheAdapter.exists(previousPath)) await cacheAdapter.remove(previousPath);
  await cacheAdapter.moveFile(nextPath, previousPath);
}

async function validGeneration(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string,
  generationId: string,
  securityPolicyFingerprint?: string
): Promise<GenerationManifest | undefined> {
  if (!isGenerationId(generationId)) return undefined;
  const path = sourcePath(cacheDirectory, generationId);
  const manifest = await readGenerationManifest(cacheAdapter, cacheDirectory, generationId);
  if (
    !manifest ||
    manifest.formatVersion !== CACHE_FORMAT_VERSION ||
    (securityPolicyFingerprint !== undefined &&
      manifest.securityPolicyFingerprint !== securityPolicyFingerprint) ||
    !(await cacheAdapter.exists(path))
  ) {
    return undefined;
  }
  if (
    manifest.validationMode === 'content-hash' &&
    (await canonicalFileHash(cacheAdapter, path, 'sha256')) !== manifest.sourceSha256
  )
    return undefined;
  const verifiedLocalFiles = new Map<string, { sha256: string; size: number }>();
  for (const asset of manifest.remoteAssets) {
    if (!asset.localFile) continue;
    const localPath = `${cacheDirectory}/generations/${generationId}/${asset.localFile}`;
    const verified = verifiedLocalFiles.get(localPath);
    if (verified) {
      if (verified.sha256 !== asset.sha256 || verified.size !== asset.size) return undefined;
      continue;
    }
    if (!(await cacheAdapter.exists(localPath))) return undefined;
    const localStat = await cacheAdapter.stat(localPath);
    if (Number(localStat.size) !== asset.size) return undefined;
    if (
      manifest.validationMode === 'content-hash' &&
      (await canonicalFileHash(cacheAdapter, localPath, 'sha256')) !== asset.sha256
    )
      return undefined;
    verifiedLocalFiles.set(localPath, { sha256: asset.sha256, size: asset.size });
  }
  return manifest;
}

type GenerationValidationCache = Map<string, GenerationManifest | undefined>;

async function cachedValidGeneration(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string,
  generationId: string,
  securityPolicyFingerprint: string,
  validationCache: GenerationValidationCache
): Promise<GenerationManifest | undefined> {
  if (validationCache.has(generationId)) return validationCache.get(generationId);
  const manifest = await validGeneration(
    cacheAdapter,
    cacheDirectory,
    generationId,
    securityPolicyFingerprint
  );
  validationCache.set(generationId, manifest);
  return manifest;
}

async function readGenerationManifest(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string,
  generationId: string
): Promise<GenerationManifest | undefined> {
  if (!isGenerationId(generationId)) return undefined;
  const candidate = await readJson<unknown>(
    cacheAdapter,
    manifestPath(cacheDirectory, generationId)
  );
  return isGenerationManifest(candidate, generationId) ? candidate : undefined;
}

function localAssetsForGeneration(
  cacheDirectory: string,
  generationId: string,
  manifest: GenerationManifest
): Record<string, MirroredLocalAsset> {
  return Object.fromEntries(
    manifest.remoteAssets
      .filter(
        (
          asset
        ): asset is RemoteAssetMetadata & {
          integrity: Required<SubresourceIntegrityDigests>;
          localFile: string;
        } =>
          typeof asset.localFile === 'string' &&
          typeof asset.integrity.sha256 === 'string' &&
          typeof asset.integrity.sha384 === 'string' &&
          typeof asset.integrity.sha512 === 'string'
      )
      .map((asset) => {
        const requestUrl = new URL(asset.url);
        setUrlHash(requestUrl, '');
        return [
          requestUrl.toString(),
          {
            integrity: {
              ...asset.integrity,
            },
            mediaType: asset.mediaType,
            path: `${cacheDirectory}/generations/${generationId}/${asset.localFile}`,
            redirected: asset.redirected,
            responseHeaders: asset.responseHeaders,
            responseUrl: asset.responseUrl,
            sha256: asset.sha256,
            size: asset.size,
            url: requestUrl.toString(),
          },
        ] as const;
      })
  );
}

function generationMatchesEntry(manifest: GenerationManifest, requestedUrl: string): boolean {
  return canonicalResourceUrl(manifest.entryUrl) === canonicalResourceUrl(requestedUrl);
}

async function hasRollbackForEntry(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string,
  candidates: GenerationSummary[],
  currentGenerationId: string,
  securityPolicyFingerprint: string,
  entryUrl: string
): Promise<boolean> {
  for (const candidate of candidates) {
    if (
      candidate.generationId === currentGenerationId ||
      candidate.securityPolicyFingerprint !== securityPolicyFingerprint
    ) {
      continue;
    }
    const manifest = await readGenerationManifest(
      cacheAdapter,
      cacheDirectory,
      candidate.generationId
    );
    if (manifest && generationMatchesEntry(manifest, entryUrl)) return true;
  }
  return false;
}

async function readCachedBundle(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string,
  securityPolicyFingerprint: string,
  requestedUrl: string,
  validationCache: GenerationValidationCache
): Promise<{ bundle: MirroredWebBundle; manifest: GenerationManifest } | undefined> {
  const state = await readCacheState(cacheAdapter, cacheDirectory);
  if (!state) return undefined;
  const ordered = [
    state.activeGeneration,
    ...state.generations
      .map((generation) => generation.generationId)
      .filter((generationId) => generationId !== state.activeGeneration),
  ];

  for (const generationId of ordered) {
    const manifest = await cachedValidGeneration(
      cacheAdapter,
      cacheDirectory,
      generationId,
      securityPolicyFingerprint,
      validationCache
    );
    if (!manifest || !generationMatchesEntry(manifest, requestedUrl)) continue;
    if (generationId !== state.activeGeneration) {
      await writeCacheState(cacheAdapter, cacheDirectory, {
        ...state,
        activeGeneration: generationId,
      });
    }
    const generationIndex = state.generations.findIndex(
      (generation) => generation.generationId === generationId
    );
    return {
      bundle: {
        baseUrl: documentUrlForRequest(
          manifest.documentUrl,
          manifest.documentFragment,
          manifest.documentFragmentInherited,
          requestedUrl
        ),
        downloadedAssets: manifest.downloadedAssets,
        generationId,
        localAssets: localAssetsForGeneration(cacheDirectory, generationId, manifest),
        rollbackAvailable: await hasRollbackForEntry(
          cacheAdapter,
          cacheDirectory,
          state.generations.slice(generationIndex + 1),
          generationId,
          securityPolicyFingerprint,
          manifest.entryUrl
        ),
        sourcePath: sourcePath(cacheDirectory, generationId),
        totalBytes: manifest.totalBytes,
        usedCachedBundle: true,
      },
      manifest,
    };
  }
  return undefined;
}

async function readPublishedBundle(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string,
  securityPolicyFingerprint: string,
  requestedUrl: string,
  maxBytes: number
): Promise<MirroredWebBundle | undefined> {
  const state = await readCacheState(cacheAdapter, cacheDirectory);
  if (!state) return undefined;
  const ordered = [
    state.activeGeneration,
    ...state.generations
      .map((generation) => generation.generationId)
      .filter((generationId) => generationId !== state.activeGeneration),
  ];

  for (const generationId of ordered) {
    const generationIndex = state.generations.findIndex(
      (generation) => generation.generationId === generationId
    );
    const summary = state.generations[generationIndex];
    if (
      !summary ||
      summary.securityPolicyFingerprint !== securityPolicyFingerprint ||
      summary.totalBytes > maxBytes
    ) {
      continue;
    }
    const manifest = await readGenerationManifest(cacheAdapter, cacheDirectory, generationId);
    if (
      !manifest ||
      manifest.securityPolicyFingerprint !== securityPolicyFingerprint ||
      manifest.totalBytes !== summary.totalBytes ||
      !generationMatchesEntry(manifest, requestedUrl) ||
      !(await cacheAdapter.exists(sourcePath(cacheDirectory, generationId)))
    ) {
      continue;
    }
    return {
      baseUrl: documentUrlForRequest(
        manifest.documentUrl,
        manifest.documentFragment,
        manifest.documentFragmentInherited,
        requestedUrl
      ),
      downloadedAssets: manifest.downloadedAssets,
      generationId,
      localAssets: localAssetsForGeneration(cacheDirectory, generationId, manifest),
      rollbackAvailable: await hasRollbackForEntry(
        cacheAdapter,
        cacheDirectory,
        state.generations.slice(generationIndex + 1),
        generationId,
        securityPolicyFingerprint,
        manifest.entryUrl
      ),
      sourcePath: sourcePath(cacheDirectory, generationId),
      totalBytes: manifest.totalBytes,
      usedCachedBundle: true,
    };
  }
  return undefined;
}

async function applyCachePolicy(
  cacheDirectory: string,
  state: CacheState,
  policy: Required<CachePolicy>,
  cacheAdapter: LocalWebViewCacheAdapter
): Promise<CacheState> {
  const { kept, removed } = selectCacheGenerations({
    activeGeneration: state.activeGeneration,
    generations: state.generations,
    maxBytes: policy.maxBytes,
    maxGenerations: policy.maxGenerations,
  });
  const leasedIds = leasedGenerationIds(cacheDirectory);
  const deletable = removed.filter((generation) => !leasedIds.has(generation.generationId));
  const pruned: CacheState = {
    ...state,
    generations: kept,
  };
  if (JSON.stringify(pruned) !== JSON.stringify(state)) {
    // Publish the reference set before deleting files so interruption can only
    // leave reclaimable orphans, never state that points at a removed rollback.
    await writeCacheState(cacheAdapter, cacheDirectory, pruned);
    // `writeCacheState` intentionally retains the prior current state as its
    // corruption fallback. Once pruning is about to delete generations, that
    // fallback must reference the same retained set.
    await writePreviousCacheState(cacheAdapter, cacheDirectory, pruned);
  }
  for (const generation of deletable) {
    const directory = `${cacheDirectory}/generations/${generation.generationId}`;
    if (await cacheAdapter.exists(directory)) await cacheAdapter.remove(directory);
  }
  return pruned;
}

async function removeInterruptedStateFiles(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string
): Promise<void> {
  const entries = await cacheAdapter.listDirectory(cacheDirectory);
  await Promise.all(
    entries
      .filter(
        (entry) => entry.startsWith('state.next-') || entry.startsWith('state.previous.next-')
      )
      .map((entry) => cacheAdapter.remove(`${cacheDirectory}/${entry}`))
  );
}

async function removeUnreferencedGenerationDirectories(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string,
  state?: CacheState
): Promise<void> {
  const generationsPath = `${cacheDirectory}/generations`;
  if (!(await cacheAdapter.exists(generationsPath))) return;
  const referenced = new Set([
    ...(state?.generations.map((generation) => generation.generationId) ?? []),
    ...leasedGenerationIds(cacheDirectory),
  ]);
  for (const entry of await cacheAdapter.listDirectory(generationsPath)) {
    if (!referenced.has(entry)) {
      await cacheAdapter.remove(`${generationsPath}/${entry}`);
    }
  }
}

async function reconcileCache(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string,
  policy: Required<CachePolicy>,
  requestedEntryUrl: string,
  securityPolicyFingerprint: string,
  validationCache: GenerationValidationCache,
  verifyPayloads: boolean,
  deferPruning: boolean
): Promise<string> {
  const generationsPath = `${cacheDirectory}/generations`;
  const stagingDirectory = `${cacheDirectory}/staging`;
  if (await cacheAdapter.exists(stagingDirectory)) await cacheAdapter.remove(stagingDirectory);
  await mkdir(cacheAdapter, stagingDirectory);
  await removeInterruptedStateFiles(cacheAdapter, cacheDirectory);

  let state = await readCacheState(cacheAdapter, cacheDirectory);
  if (!state) {
    const leasedIds = leasedGenerationIds(cacheDirectory);
    if (await cacheAdapter.exists(generationsPath)) {
      for (const entry of await cacheAdapter.listDirectory(generationsPath)) {
        if (!leasedIds.has(entry)) await cacheAdapter.remove(`${generationsPath}/${entry}`);
      }
    }
    for (const stateFile of ['state.json', 'state.previous.json']) {
      const path = `${cacheDirectory}/${stateFile}`;
      if (await cacheAdapter.exists(path)) await cacheAdapter.remove(path);
    }
    await mkdir(cacheAdapter, generationsPath);
    return stagingDirectory;
  }

  await mkdir(cacheAdapter, generationsPath);
  if (deferPruning) {
    // A forced refresh keeps every published generation available until the
    // new generation succeeds or fallback selection runs. Unpublished
    // directories are not fallback candidates, so reclaim them immediately
    // while still honoring leases held by mounted WebViews.
    await removeUnreferencedGenerationDirectories(cacheAdapter, cacheDirectory, state);
    return stagingDirectory;
  }
  const matchingCandidates = [...state.generations]
    .filter(
      (generation) =>
        generation.securityPolicyFingerprint === securityPolicyFingerprint &&
        generation.totalBytes <= policy.maxBytes
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const candidate of matchingCandidates) {
    const manifest = verifyPayloads
      ? await cachedValidGeneration(
          cacheAdapter,
          cacheDirectory,
          candidate.generationId,
          securityPolicyFingerprint,
          validationCache
        )
      : await readGenerationManifest(cacheAdapter, cacheDirectory, candidate.generationId);
    if (manifest?.securityPolicyFingerprint !== securityPolicyFingerprint) continue;
    if (!manifest || !generationMatchesEntry(manifest, requestedEntryUrl)) continue;
    if (state.activeGeneration !== candidate.generationId) {
      state = {
        ...state,
        activeGeneration: candidate.generationId,
      };
      // Publish the requested valid generation as active before policy pruning
      // can remove another entry's generation directories.
      await writeCacheState(cacheAdapter, cacheDirectory, state);
    }
    break;
  }
  const active = state.generations.find(
    (generation) => generation.generationId === state.activeGeneration
  );
  if (active && active.totalBytes > policy.maxBytes) {
    const replacement = [...state.generations]
      .filter((generation) => generation.totalBytes <= policy.maxBytes)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (replacement) {
      const recovered = await applyCachePolicy(
        cacheDirectory,
        {
          ...state,
          activeGeneration: replacement.generationId,
        },
        policy,
        cacheAdapter
      );
      await removeUnreferencedGenerationDirectories(cacheAdapter, cacheDirectory, recovered);
      return stagingDirectory;
    }

    // A generation that no longer satisfies the configured policy must not be
    // handed to another WebView. Remove its cache references first, but keep a
    // leased directory alive until its mounted consumer releases it.
    for (const stateFile of ['state.json', 'state.previous.json']) {
      const path = `${cacheDirectory}/${stateFile}`;
      if (await cacheAdapter.exists(path)) await cacheAdapter.remove(path);
    }
    const leasedIds = leasedGenerationIds(cacheDirectory);
    for (const entry of await cacheAdapter.listDirectory(generationsPath)) {
      if (!leasedIds.has(entry)) await cacheAdapter.remove(`${generationsPath}/${entry}`);
    }
    return stagingDirectory;
  }
  const pruned = await applyCachePolicy(cacheDirectory, state, policy, cacheAdapter);
  await removeUnreferencedGenerationDirectories(cacheAdapter, cacheDirectory, pruned);
  return stagingDirectory;
}

async function commitGeneration(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string,
  prepared: PreparedBundle,
  policy: Required<CachePolicy>,
  entryUrl: string,
  securityPolicyFingerprint: string,
  signal?: AbortSignal
): Promise<MirroredWebBundle> {
  throwIfAborted(signal);
  const fileAssets = prepared.remoteAssets.filter((asset) => asset.delivery === 'file');
  const payloadBytes =
    utf8ByteLength(prepared.html) +
    [...new Map(fileAssets.map((asset) => [asset.sha256, asset])).values()].reduce(
      (sum, asset) => sum + asset.size,
      0
    );

  const sourceSha256 = sha256Text(prepared.html);
  const remoteFingerprint = sha256Text(
    JSON.stringify(
      prepared.remoteAssets
        .map((asset) => ({
          contentSecurityPolicy: asset.contentSecurityPolicy,
          contentSecurityPolicyReportOnly: asset.contentSecurityPolicyReportOnly,
          declaredMediaType: asset.declaredMediaType,
          delivery: asset.delivery,
          etag: asset.etag,
          integrity: asset.integrity,
          redirected: asset.redirected,
          responseUrl: asset.responseUrl,
          sha256: asset.sha256,
          size: asset.size,
          url: asset.url,
        }))
        .sort((left, right) => left.url.localeCompare(right.url))
    )
  );
  const generationId = `${Date.now()}-${generationSequence++}-${sourceSha256.slice(
    0,
    8
  )}-${remoteFingerprint.slice(0, 8)}`;
  const generationDirectory = `${cacheDirectory}/generations/${generationId}`;
  const localFiles = new Map<string, string>();
  const finalSource = sourcePath(cacheDirectory, generationId);
  for (const asset of fileAssets) {
    if (!asset.localPath) {
      throw new Error(`Local file is unavailable for streamed asset ${asset.url}`);
    }
    localFiles.set(asset.sha256, `assets/${asset.sha256}`);
  }
  const createdAt = new Date().toISOString();
  // A release-wide ETag makes per-inline-resource revalidation metadata
  // redundant. Keep only the entry (needed for the conditional request) and
  // resources that must remain addressable as files at runtime. The localized
  // HTML already owns every other resource, so a warm mount can parse a much
  // smaller manifest before opening it.
  const manifestAssets = prepared.bundleEtag
    ? prepared.remoteAssets.filter(
        (asset) =>
          asset.delivery === 'file' ||
          canonicalResourceUrl(asset.url) === canonicalResourceUrl(entryUrl)
      )
    : prepared.remoteAssets;
  const remoteAssets = manifestAssets.map((asset) =>
    metadataForAsset(asset, asset.delivery === 'file' ? localFiles.get(asset.sha256) : undefined)
  );
  const manifestForSize = (totalBytes: number): GenerationManifest => ({
    bundleEtag: prepared.bundleEtag,
    createdAt,
    downloadedAssets: prepared.downloadedAssets,
    documentFragment: prepared.documentFragment,
    documentFragmentInherited: prepared.documentFragmentInherited,
    documentUrl: prepared.documentUrl,
    entryUrl: canonicalResourceUrl(entryUrl),
    formatVersion: CACHE_FORMAT_VERSION,
    generationId,
    remoteAssets,
    securityPolicyFingerprint,
    sourceSha256,
    totalBytes,
    validationMode: prepared.bundleEtag ? 'release-etag' : 'content-hash',
  });
  const summaryForSize = (totalBytes: number): GenerationSummary => ({
    createdAt,
    generationId,
    securityPolicyFingerprint,
    totalBytes,
  });
  let totalBytes = payloadBytes;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const nextTotal =
      payloadBytes +
      utf8ByteLength(JSON.stringify(manifestForSize(totalBytes))) +
      2 * utf8ByteLength(JSON.stringify(summaryForSize(totalBytes))) +
      CACHE_STATE_OVERHEAD_BYTES_PER_GENERATION;
    if (nextTotal === totalBytes) break;
    totalBytes = nextTotal;
  }
  const manifest = manifestForSize(totalBytes);
  if (totalBytes > policy.maxBytes) {
    throw new Error(
      `The localized bundle is ${totalBytes} bytes, exceeding maxBytes=${policy.maxBytes}`
    );
  }

  try {
    await mkdir(cacheAdapter, generationDirectory);
    if (fileAssets.length > 0) await mkdir(cacheAdapter, `${generationDirectory}/assets`);
    for (const asset of fileAssets) {
      throwIfAborted(signal);
      const localFile = localFiles.get(asset.sha256)!;
      if (!(await cacheAdapter.exists(`${generationDirectory}/${localFile}`))) {
        await cacheAdapter.moveFile(asset.localPath!, `${generationDirectory}/${localFile}`);
      }
    }

    const nextSource = `${generationDirectory}/index.next.html`;
    const nextManifest = `${generationDirectory}/manifest.next.json`;
    const finalManifest = manifestPath(cacheDirectory, generationId);
    await cacheAdapter.writeFile(nextSource, prepared.html, 'utf8');
    await cacheAdapter.writeFile(nextManifest, JSON.stringify(manifest), 'utf8');
    await cacheAdapter.moveFile(nextSource, finalSource);
    await cacheAdapter.moveFile(nextManifest, finalManifest);
  } catch (error) {
    if (await cacheAdapter.exists(generationDirectory))
      await cacheAdapter.remove(generationDirectory);
    throw error;
  }

  let state: CacheState;
  try {
    throwIfAborted(signal);
    const previousState = await readCacheState(cacheAdapter, cacheDirectory);
    const summary = summaryForSize(totalBytes);
    state = {
      activeGeneration: generationId,
      formatVersion: CACHE_FORMAT_VERSION,
      generations: [
        summary,
        ...(previousState?.generations ?? []).filter(
          (generation) => generation.generationId !== generationId
        ),
      ],
    };
    throwIfAborted(signal);
    await writeCacheState(cacheAdapter, cacheDirectory, state);
  } catch (error) {
    if (await cacheAdapter.exists(generationDirectory))
      await cacheAdapter.remove(generationDirectory);
    throw error;
  }
  const pruned = await applyCachePolicy(cacheDirectory, state, policy, cacheAdapter);

  return {
    baseUrl: documentUrlForRequest(
      prepared.documentUrl,
      prepared.documentFragment,
      prepared.documentFragmentInherited,
      entryUrl
    ),
    downloadedAssets: prepared.downloadedAssets,
    generationId,
    localAssets: localAssetsForGeneration(cacheDirectory, generationId, manifest),
    rollbackAvailable: await hasRollbackForEntry(
      cacheAdapter,
      cacheDirectory,
      pruned.generations,
      generationId,
      securityPolicyFingerprint,
      manifest.entryUrl
    ),
    sourcePath: finalSource,
    totalBytes,
    usedCachedBundle: false,
  };
}

async function prepareByCrawling(
  cacheAdapter: LocalWebViewCacheAdapter,
  stagingDirectory: string,
  virtualUrl: string,
  security: ResolvedSecurityPolicy,
  maxBytes: number,
  maxInlineBytes: number,
  validationMode: WebBundleValidationMode,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<PreparedBundle> {
  const cache = new Map<string, LoadedResource>();
  const retainedTemporaryFiles = new Set<string>();
  let entryDocumentFragment = new URL(virtualUrl).hash;
  let entryDocumentFragmentInherited = true;
  let entryDocumentUrl = canonicalResourceUrl(virtualUrl);
  let entryRuntimeDocumentUrl = virtualUrl;
  let materializedBytes = 0;
  const reserveBytes = (size: number, url: string): void => {
    if (materializedBytes + size > maxBytes) {
      throw new Error(
        `Downloaded bundle resources exceed maxBytes=${maxBytes} while materializing ${url}`
      );
    }
    materializedBytes += size;
  };
  const accountDownloadedBytes = (size: number, url: string, delivery: ResourceDelivery): void => {
    if (delivery === 'file') {
      reserveBytes(size, url);
      return;
    }
    if (size > maxInlineBytes) {
      throw new Error(
        `Inline resource exceeds cachePolicy.maxInlineBytes=${maxInlineBytes}: ${url}`
      );
    }
    const encodedSize = 4 * Math.ceil(size / 3);
    // The downloaded file and its base64 representation coexist during
    // readFile(). Reject before allocating the string when that peak would
    // exceed the configured bundle budget.
    if (materializedBytes + size + encodedSize > maxBytes) {
      throw new Error(
        `Downloaded bundle resources exceed maxBytes=${maxBytes} while materializing ${url}`
      );
    }
    materializedBytes += encodedSize;
  };
  const remainingDownloadBytes = (delivery: ResourceDelivery): number => {
    const remaining = maxBytes - materializedBytes;
    if (delivery === 'file') return remaining;
    // Inline resources transiently retain both the downloaded file and its
    // base64 representation. Find the largest raw response that can fit that
    // peak before allowing the cacheAdapter to start receiving it.
    const completeTriplets = Math.floor(remaining / 7);
    const remainder = remaining - completeTriplets * 7;
    return completeTriplets * 3 + (remainder >= 6 ? 2 : remainder >= 5 ? 1 : 0);
  };

  try {
    const load: ResourceLoader = async (url, options) => {
      throwIfAborted(signal);
      const normalizedUrl = canonicalResourceUrl(url);
      const requestUrl = new URL(normalizedUrl);
      assertTrustedAssetUrl(normalizedUrl, security);
      const delivery = options?.delivery ?? 'inline';
      const cached = cache.get(normalizedUrl);
      if (cached) {
        await ensureResourceIntegrity(cacheAdapter, cached, options?.integrity);
        throwIfAborted(signal);
        if (delivery === 'inline' && cached.content === undefined) {
          if (!cached.localPath) {
            throw new Error(`Cached file asset has no local file: ${normalizedUrl}`);
          }
          if (cached.size > maxInlineBytes) {
            throw new Error(
              `Inline resource exceeds cachePolicy.maxInlineBytes=${maxInlineBytes}: ${normalizedUrl}`
            );
          }
          const encodedSize = 4 * Math.ceil(cached.size / 3);
          reserveBytes(encodedSize, normalizedUrl);
          cached.content = await cacheAdapter.readFile(cached.localPath, 'base64');
          throwIfAborted(signal);
        }
        if (delivery === 'file' && !cached.localPath) {
          if (cached.content === undefined) {
            throw new Error(`Cached inline asset has no readable content: ${normalizedUrl}`);
          }
          reserveBytes(cached.size, normalizedUrl);
          const promotedPath = `${stagingDirectory}/promoted-${Date.now()}-${temporaryFileSequence++}`;
          retainedTemporaryFiles.add(promotedPath);
          await cacheAdapter.writeFile(promotedPath, cached.content, 'base64');
          throwIfAborted(signal);
          const promotedStat = await cacheAdapter.stat(promotedPath);
          throwIfAborted(signal);
          const promotedSize = Number(promotedStat.size);
          const promotedHashes = await canonicalFileHashes(cacheAdapter, promotedPath, [
            'sha256',
            'sha384',
            'sha512',
          ]);
          throwIfAborted(signal);
          const promotedSha256 = promotedHashes.sha256!;
          if (promotedSize !== cached.size || promotedSha256 !== cached.sha256) {
            throw new Error(`Promoted file asset failed integrity verification: ${normalizedUrl}`);
          }
          cached.localPath = promotedPath;
          cached.delivery = 'file';
          cached.integrity ??= {};
          cached.integrity.sha256 ??= hexDigestToBase64(cached.sha256);
          cached.integrity.sha384 = hexDigestToBase64(promotedHashes.sha384!);
          cached.integrity.sha512 = hexDigestToBase64(promotedHashes.sha512!);
        }
        return cached;
      }
      onProgress?.(`Downloading asset: ${requestUrl.pathname}`);
      const entryRequest = normalizedUrl === canonicalResourceUrl(virtualUrl);
      const maxDownloadBytes = Math.min(
        remainingDownloadBytes(delivery),
        delivery === 'inline' ? maxInlineBytes : Number.MAX_SAFE_INTEGER
      );
      let result: DownloadResult;
      try {
        result = await downloadResource(
          cacheAdapter,
          stagingDirectory,
          normalizedUrl,
          security,
          undefined,
          {
            accountDownloadedBytes,
            delivery,
            documentRequestUrl: entryRequest ? url : undefined,
            integrity: options?.integrity,
            maxDownloadBytes,
            preserveFile: delivery === 'file',
            sameOriginRedirectsOnly: entryRequest,
          },
          signal
        );
      } catch (error) {
        if (
          delivery === 'inline' &&
          error instanceof LocalWebViewDownloadLimitError &&
          error.maxBytes === maxInlineBytes
        ) {
          throw new Error(
            `Inline resource exceeds cachePolicy.maxInlineBytes=${maxInlineBytes}: ${normalizedUrl}`
          );
        }
        throw error;
      }
      if (result.status === 'not-modified') {
        throw new Error(`Unexpected 304 without cached content: ${normalizedUrl}`);
      }
      if (entryRequest) {
        const resolvedDocumentUrl = new URL(result.documentUrl);
        entryDocumentFragment = resolvedDocumentUrl.hash;
        setUrlHash(resolvedDocumentUrl, '');
        entryDocumentFragmentInherited = result.documentFragmentInherited;
        entryDocumentUrl = resolvedDocumentUrl.toString();
        entryRuntimeDocumentUrl = result.documentUrl;
      }
      if (result.asset.localPath) retainedTemporaryFiles.add(result.asset.localPath);
      cache.set(normalizedUrl, result.asset);
      return result.asset;
    };
    onProgress?.('Downloading entry HTML…');
    const entry = await load(virtualUrl);
    const bundleEtag =
      validationMode === 'release-etag'
        ? requiredReleaseEtag(entry.etag, entry.responseUrl ?? entry.url)
        : undefined;
    if (entry.content === undefined) {
      throw new Error('Downloaded entry HTML has no readable content');
    }
    if (entry.declaredMediaType !== 'text/html') {
      throw new Error(
        `The entry response must use Content-Type: text/html (received ${entry.declaredMediaType})`
      );
    }
    if (
      (entry.contentSecurityPolicy || entry.contentSecurityPolicyReportOnly) &&
      !security.allowContentSecurityPolicyBypass
    ) {
      throw new ContentSecurityPolicyError(
        'The entry response has a Content-Security-Policy or Content-Security-Policy-Report-Only header. Set allowContentSecurityPolicyBypass to true only when discarding that policy is intentional.'
      );
    }
    const localized = await localizeWebDocument({
      allowContentSecurityPolicyBypass: security.allowContentSecurityPolicyBypass,
      canLoad: (url) => isTrustedAssetUrl(url, security),
      entryUrl: entryRuntimeDocumentUrl,
      html: bytesToUtf8(base64ToBytes(entry.content)),
      load,
      reserveMaterializedBytes: reserveBytes,
    });
    throwIfAborted(signal);
    return {
      bundleEtag,
      downloadedAssets: [...cache.keys()],
      documentFragment: entryDocumentFragment,
      documentFragmentInherited: entryDocumentFragmentInherited,
      documentUrl: entryDocumentUrl,
      html: localized.html,
      remoteAssets: [...cache.values()],
    };
  } catch (error) {
    await Promise.all(
      [...retainedTemporaryFiles].map(async (path) => {
        if (await cacheAdapter.exists(path)) await cacheAdapter.remove(path);
      })
    );
    throw error;
  }
}

async function revalidateBundleEtag(
  cacheAdapter: LocalWebViewCacheAdapter,
  stagingDirectory: string,
  manifest: GenerationManifest,
  requestedEntryUrl: string,
  security: ResolvedSecurityPolicy,
  signal?: AbortSignal
): Promise<boolean> {
  const entry = manifest.remoteAssets.find((asset) => asset.url === manifest.entryUrl);
  if (!entry) {
    throw new RequiredReleaseEtagError(
      `The cached generation has no entry metadata for ${manifest.entryUrl}`
    );
  }
  const etag = requiredReleaseEtag(manifest.bundleEtag, manifest.entryUrl);
  const temporaryPath = `${stagingDirectory}/revalidate-${Date.now()}-${temporaryFileSequence++}`;
  let completedDownload:
    | {
        wroteFile?: boolean;
      }
    | undefined;
  try {
    let result: Awaited<ReturnType<typeof downloadWithoutRedirects>>;
    try {
      result = await downloadWithoutRedirects(
        cacheAdapter,
        requestedEntryUrl,
        temporaryPath,
        {
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
          'If-None-Match': etag,
        },
        security,
        true,
        entry.size,
        undefined,
        signal
      );
    } catch (error) {
      if (error instanceof LocalWebViewDownloadLimitError) return true;
      throw error;
    }
    completedDownload = result;
    throwIfAborted(signal);
    if (result.status === 304) {
      const responseEtag = header(result.headers, 'etag');
      return (
        (responseEtag !== undefined && responseEtag !== etag) ||
        canonicalResourceUrl(result.documentUrl) !== canonicalResourceUrl(manifest.documentUrl) ||
        result.documentFragmentInherited !== manifest.documentFragmentInherited ||
        result.finalUrl !== entry.responseUrl ||
        result.redirected !== entry.redirected
      );
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`HTTP ${result.status} while revalidating ${manifest.entryUrl}`);
    }
    requiredReleaseEtag(header(result.headers, 'etag'), result.finalUrl);
    return true;
  } finally {
    if (completedDownload?.wroteFile === true) {
      await cacheAdapter.remove(temporaryPath);
    } else if (
      completedDownload?.wroteFile === undefined &&
      (await cacheAdapter.exists(temporaryPath))
    ) {
      await cacheAdapter.remove(temporaryPath);
    }
  }
}

async function revalidateAssets(
  cacheAdapter: LocalWebViewCacheAdapter,
  stagingDirectory: string,
  assets: RemoteAssetMetadata[],
  entryUrl: string,
  entryDocumentUrl: string,
  entryDocumentFragmentInherited: boolean,
  requestedEntryUrl: string,
  security: ResolvedSecurityPolicy,
  maxBytes: number,
  signal?: AbortSignal
): Promise<boolean> {
  const revalidateOne = async (
    metadata: RemoteAssetMetadata,
    requestSignal?: AbortSignal
  ): Promise<boolean> => {
    throwIfAborted(requestSignal);
    assertTrustedAssetUrl(metadata.url, security);
    const isEntry = metadata.url === entryUrl;
    let result: DownloadResult;
    try {
      result = await downloadResource(
        cacheAdapter,
        stagingDirectory,
        metadata.url,
        security,
        metadata.etag,
        {
          completeFileIntegrity: false,
          delivery: 'file',
          documentRequestUrl: isEntry ? requestedEntryUrl : undefined,
          maxDownloadBytes: metadata.size,
          sameOriginRedirectsOnly: isEntry,
        },
        requestSignal
      );
    } catch (error) {
      if (error instanceof LocalWebViewDownloadLimitError) {
        // Exceeding the previously verified response size proves that the
        // representation changed. The full refresh receives the origin-wide
        // budget and decides whether the new graph still fits.
        return true;
      }
      throw error;
    }
    const documentChanged =
      isEntry &&
      (result.documentUrl !== entryDocumentUrl ||
        result.documentFragmentInherited !== entryDocumentFragmentInherited);
    if (result.status === 'not-modified') {
      return (
        documentChanged ||
        (result.etag !== undefined && result.etag !== metadata.etag) ||
        result.redirected !== metadata.redirected ||
        result.responseUrl !== metadata.responseUrl ||
        (result.contentSecurityPolicy !== undefined &&
          result.contentSecurityPolicy !== metadata.contentSecurityPolicy) ||
        (result.contentSecurityPolicyReportOnly !== undefined &&
          result.contentSecurityPolicyReportOnly !== metadata.contentSecurityPolicyReportOnly) ||
        (result.declaredMediaType !== undefined &&
          result.declaredMediaType !== metadata.declaredMediaType)
      );
    }
    if (
      isEntry &&
      (result.asset.contentSecurityPolicy || result.asset.contentSecurityPolicyReportOnly) &&
      !security.allowContentSecurityPolicyBypass
    ) {
      throw new ContentSecurityPolicyError(
        'The entry response introduced a Content-Security-Policy or Content-Security-Policy-Report-Only header'
      );
    }
    return (
      documentChanged ||
      result.asset.sha256 !== metadata.sha256 ||
      result.asset.etag !== metadata.etag ||
      result.asset.declaredMediaType !== metadata.declaredMediaType ||
      result.asset.mediaType !== metadata.mediaType ||
      result.asset.redirected !== metadata.redirected ||
      !stringRecordsEqual(result.asset.responseHeaders, metadata.responseHeaders) ||
      result.asset.responseUrl !== metadata.responseUrl ||
      result.asset.contentSecurityPolicy !== metadata.contentSecurityPolicy ||
      result.asset.contentSecurityPolicyReportOnly !== metadata.contentSecurityPolicyReportOnly
    );
  };

  let cursor = 0;
  while (cursor < assets.length) {
    throwIfAborted(signal);
    const batch: RemoteAssetMetadata[] = [];
    let reservedBytes = 0;
    while (cursor < assets.length && batch.length < REVALIDATION_CONCURRENCY) {
      const metadata = assets[cursor]!;
      if (metadata.size > maxBytes) return true;
      if (batch.length > 0 && reservedBytes + metadata.size > maxBytes) {
        break;
      }
      batch.push(metadata);
      reservedBytes += metadata.size;
      cursor += 1;
    }
    const batchController = new AbortController();
    const abortBatch = (): void => batchController.abort();
    signal?.addEventListener('abort', abortBatch, { once: true });
    let hasChanged = false;
    let hasFailure = false;
    let primaryFailure: unknown;
    const results = await Promise.allSettled(
      batch.map(async (metadata) => {
        try {
          const changed = await revalidateOne(metadata, batchController.signal);
          if (changed) {
            hasChanged = true;
            batchController.abort();
          }
          return changed;
        } catch (error) {
          if (hasChanged && batchController.signal.aborted) {
            return false;
          }
          if (!hasFailure) primaryFailure = error;
          hasFailure = true;
          batchController.abort();
          throw error;
        }
      })
    ).finally(() => {
      signal?.removeEventListener('abort', abortBatch);
    });
    throwIfAborted(signal);
    if (hasChanged) return true;
    if (hasFailure) throw primaryFailure;
    if (results.some((result) => result.status === 'fulfilled' && result.value)) {
      return true;
    }
  }
  return false;
}

async function cleanupPreparedBundle(
  cacheAdapter: LocalWebViewCacheAdapter,
  prepared: PreparedBundle | undefined
): Promise<void> {
  if (!prepared) return;
  await Promise.all(
    prepared.remoteAssets.map(async (asset) => {
      if (asset.localPath && (await cacheAdapter.exists(asset.localPath))) {
        await cacheAdapter.remove(asset.localPath);
      }
    })
  );
}

export function cacheDirectoryForOrigin(
  virtualUrl: string,
  cacheAdapter: LocalWebViewCacheAdapter
): string {
  const url = assertHttpsUrl(virtualUrl, 'virtualUrl');
  const originKey = sha256Text(url.origin);
  return `${cacheAdapter.directories.documents}/local-webview/${originKey}`;
}

export function readMirroredWebBundle(
  source: string,
  cacheAdapter: LocalWebViewCacheAdapter
): Promise<string> {
  return cacheAdapter.readFile(source, 'utf8');
}

async function rollbackWebBundleUnlocked(
  cacheAdapter: LocalWebViewCacheAdapter,
  cacheDirectory: string,
  requestedGenerationId?: string,
  requestedUrl?: string
): Promise<MirroredWebBundle | undefined> {
  const state = await readCacheState(cacheAdapter, cacheDirectory);
  if (!state) return undefined;
  const currentGenerationId = requestedGenerationId ?? state.activeGeneration;
  const currentManifest = await readGenerationManifest(
    cacheAdapter,
    cacheDirectory,
    currentGenerationId
  );
  if (!currentManifest) return undefined;
  const currentIndex = state.generations.findIndex(
    (generation) => generation.generationId === currentGenerationId
  );
  const firstOlderIndex = currentIndex < 0 ? 0 : currentIndex + 1;
  const sameEntry = (manifest: GenerationManifest): boolean =>
    canonicalResourceUrl(manifest.entryUrl) === canonicalResourceUrl(currentManifest.entryUrl);

  for (
    let generationIndex = firstOlderIndex;
    generationIndex < state.generations.length;
    generationIndex += 1
  ) {
    const generation = state.generations[generationIndex]!;
    if (
      generation.generationId === currentGenerationId ||
      generation.securityPolicyFingerprint !== currentManifest.securityPolicyFingerprint ||
      (currentIndex < 0 && generation.createdAt >= currentManifest.createdAt)
    ) {
      continue;
    }
    const manifest = await validGeneration(
      cacheAdapter,
      cacheDirectory,
      generation.generationId,
      currentManifest.securityPolicyFingerprint
    );
    if (!manifest || !sameEntry(manifest)) continue;
    const rejected =
      currentIndex < 0
        ? []
        : state.generations
            .slice(currentIndex, generationIndex)
            .filter(
              (candidate) =>
                candidate.securityPolicyFingerprint === currentManifest.securityPolicyFingerprint
            );
    const rejectedIds = new Set(rejected.map((candidate) => candidate.generationId));
    const remaining = state.generations.filter(
      (candidate) => !rejectedIds.has(candidate.generationId)
    );
    await writeCacheState(cacheAdapter, cacheDirectory, {
      ...state,
      activeGeneration: generation.generationId,
      generations: remaining,
    });
    const leasedIds = leasedGenerationIds(cacheDirectory);
    for (const discardedGeneration of rejected) {
      if (leasedIds.has(discardedGeneration.generationId)) continue;
      const directory = `${cacheDirectory}/generations/${discardedGeneration.generationId}`;
      try {
        if (await cacheAdapter.exists(directory)) await cacheAdapter.remove(directory);
      } catch {
        // State no longer references a rejected generation. Reconciliation can
        // reclaim an orphan after transient filesystem failures.
      }
    }
    let rollbackAvailable = false;
    for (const candidate of state.generations.slice(generationIndex + 1)) {
      if (candidate.securityPolicyFingerprint !== currentManifest.securityPolicyFingerprint) {
        continue;
      }
      const candidateManifest = await validGeneration(
        cacheAdapter,
        cacheDirectory,
        candidate.generationId,
        currentManifest.securityPolicyFingerprint
      );
      if (candidateManifest && sameEntry(candidateManifest)) {
        rollbackAvailable = true;
        break;
      }
    }
    return {
      baseUrl: documentUrlForRequest(
        manifest.documentUrl,
        manifest.documentFragment,
        manifest.documentFragmentInherited,
        requestedUrl ?? currentManifest.documentUrl
      ),
      downloadedAssets: manifest.downloadedAssets,
      generationId: generation.generationId,
      localAssets: localAssetsForGeneration(cacheDirectory, generation.generationId, manifest),
      rollbackAvailable,
      sourcePath: sourcePath(cacheDirectory, generation.generationId),
      totalBytes: manifest.totalBytes,
      usedCachedBundle: true,
    };
  }
  return undefined;
}

export function rollbackWebBundle(
  cacheDirectory: string,
  cacheAdapter: LocalWebViewCacheAdapter,
  currentGenerationId?: string,
  requestedUrl?: string
): Promise<MirroredWebBundle | undefined> {
  return withCacheLock(cacheDirectory, () =>
    rollbackWebBundleUnlocked(cacheAdapter, cacheDirectory, currentGenerationId, requestedUrl)
  );
}

async function resolveWebBundleUnlocked({
  cacheAdapter,
  allowContentSecurityPolicyBypass = false,
  virtualUrl,
  cacheDirectory = cacheDirectoryForOrigin(virtualUrl, cacheAdapter),
  cachePolicy,
  forceRefresh = false,
  onCachedBundle,
  onPublishedBundle,
  onProgress,
  signal,
  trustedAssetOrigins,
  validationMode = 'content-hash',
}: ResolveWebBundleOptions): Promise<MirroredWebBundle> {
  throwIfAborted(signal);
  const { generationPolicyFingerprint, policy, security } = resolveBundlePolicy({
    allowContentSecurityPolicyBypass,
    cachePolicy,
    trustedAssetOrigins,
    validationMode,
    virtualUrl,
  });
  const generationValidationCache: GenerationValidationCache = new Map();
  cacheRuntimes.set(cacheDirectory, { cacheAdapter, policy });
  await mkdir(cacheAdapter, cacheDirectory);
  const publishedCached = onPublishedBundle
    ? await readPublishedBundle(
        cacheAdapter,
        cacheDirectory,
        generationPolicyFingerprint,
        virtualUrl,
        policy.maxBytes
      )
    : undefined;
  await onPublishedBundle?.(publishedCached);
  throwIfAborted(signal);
  const stagingDirectory = await reconcileCache(
    cacheAdapter,
    cacheDirectory,
    policy,
    virtualUrl,
    generationPolicyFingerprint,
    generationValidationCache,
    !forceRefresh,
    forceRefresh
  );
  throwIfAborted(signal);

  const availableCached =
    forceRefresh && !onCachedBundle
      ? undefined
      : await readCachedBundle(
          cacheAdapter,
          cacheDirectory,
          generationPolicyFingerprint,
          virtualUrl,
          generationValidationCache
        );
  await onCachedBundle?.(availableCached?.bundle);
  let cached = forceRefresh ? undefined : availableCached;
  if (cached) {
    try {
      onProgress?.(
        validationMode === 'release-etag'
          ? 'Revalidating the release ETag…'
          : 'Revalidating every remote asset with ETag and SHA-256…'
      );
      const changed =
        validationMode === 'release-etag'
          ? await revalidateBundleEtag(
              cacheAdapter,
              stagingDirectory,
              cached.manifest,
              virtualUrl,
              security,
              signal
            )
          : await revalidateAssets(
              cacheAdapter,
              stagingDirectory,
              cached.manifest.remoteAssets,
              cached.manifest.entryUrl,
              cached.bundle.baseUrl,
              cached.manifest.documentFragmentInherited,
              virtualUrl,
              security,
              policy.maxBytes,
              signal
            );
      if (!changed) {
        onProgress?.('The remote bundle is unchanged. Using the current local generation.');
        return cached.bundle;
      }
      onProgress?.(
        validationMode === 'release-etag'
          ? 'The release ETag changed. Building a new cache generation.'
          : 'A remote asset changed. Building a new cache generation.'
      );
    } catch (error) {
      if (signal?.aborted) throw createAbortError();
      if (error instanceof ContentSecurityPolicyError || error instanceof RequiredReleaseEtagError)
        throw error;
      onProgress?.('Revalidation failed. Using the last complete local generation.');
      return cached.bundle;
    }
  }

  try {
    const prepared = await prepareByCrawling(
      cacheAdapter,
      stagingDirectory,
      virtualUrl,
      security,
      policy.maxBytes,
      policy.maxInlineBytes,
      validationMode,
      onProgress,
      signal
    );
    onProgress?.('Committing the new cache generation…');
    try {
      return await commitGeneration(
        cacheAdapter,
        cacheDirectory,
        prepared,
        policy,
        virtualUrl,
        generationPolicyFingerprint,
        signal
      );
    } finally {
      await cleanupPreparedBundle(cacheAdapter, prepared);
    }
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (forceRefresh) {
      await reconcileCache(
        cacheAdapter,
        cacheDirectory,
        policy,
        virtualUrl,
        generationPolicyFingerprint,
        generationValidationCache,
        true,
        false
      );
      if (error instanceof ContentSecurityPolicyError) throw error;
      cached = await readCachedBundle(
        cacheAdapter,
        cacheDirectory,
        generationPolicyFingerprint,
        virtualUrl,
        generationValidationCache
      );
    }
    if (error instanceof ContentSecurityPolicyError || error instanceof RequiredReleaseEtagError)
      throw error;
    if (cached) {
      onProgress?.('Refresh failed. Using the last complete local generation.');
      return cached.bundle;
    }
    throw error;
  }
}

export async function resolveWebBundle(
  options: ResolveWebBundleOptions
): Promise<MirroredWebBundle> {
  const cacheDirectory =
    options.cacheDirectory ?? cacheDirectoryForOrigin(options.virtualUrl, options.cacheAdapter);
  return await withCacheLock(
    cacheDirectory,
    () =>
      resolveWebBundleUnlocked({
        ...options,
        cacheDirectory,
      }),
    options.signal
  );
}
