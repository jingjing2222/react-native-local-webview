import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { URL } from 'react-native-url-polyfill';
import {
  WebView,
  type WebViewMessageEvent,
  type WebViewNavigation,
  type WebViewProps,
} from 'react-native-webview';
import { parse, parseFragment, serialize, type Element, type Node } from 'parse5';

import { escapeScriptRawText } from './htmlRawText';
import { historyStateFromMessage, type LocalWebViewHistoryState } from './historyState';
import {
  ASSET_MESSAGE_CHANNEL,
  createAssetBridgeScript,
  type AssetBridgeDescriptor,
} from './installAssetBridge';
import { HISTORY_BRIDGE_SCRIPT, HISTORY_MESSAGE_CHANNEL } from './installHistoryBridge';
import {
  cacheDirectoryForOrigin,
  readMirroredWebBundle,
  retainWebBundle,
  resolveWebBundle,
  rollbackWebBundle,
  type CachePolicy,
  type MirroredWebBundle,
} from './mirrorWebBundle';
import type { LocalWebViewCacheAdapter } from './localWebViewCacheAdapter';
import { prepareWebViewDocument } from './prepareWebViewDocument';

const ASSET_CHUNK_BYTES = 192 * 1024;
const ASSET_ACK_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_ASSET_STREAMS = 4;
const MAX_QUEUED_ASSET_STREAMS = 32;
const CAPABILITY_BOOTSTRAP_MARKER = 'data-react-native-local-webview-capability';

type AssetBridgeMessage = {
  capability?: string;
  channel?: string;
  direction?: string;
  documentId?: string;
  end?: number;
  kind?: string;
  requestId?: string;
  start?: number;
  url?: string;
};

function parseAssetMessage(data: string): AssetBridgeMessage | undefined {
  try {
    const message = JSON.parse(data) as AssetBridgeMessage;
    return message.channel === ASSET_MESSAGE_CHANNEL ? message : undefined;
  } catch {
    return undefined;
  }
}

function createAssetCapability(): string {
  const words = new Uint32Array(4);
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(words);
  } else {
    for (let index = 0; index < words.length; index += 1) {
      words[index] = Math.floor(Math.random() * 0x1_0000_0000);
    }
  }
  return Array.from(words, (word) => word.toString(16).padStart(8, '0')).join('');
}

function createAssetCapabilityBootstrap(capability: string, expectedOrigin: string): string {
  return String.raw`
(() => {
  const capability = ${JSON.stringify(capability)};
  const channel = ${JSON.stringify(ASSET_MESSAGE_CHANNEL)};
  const historyChannel = ${JSON.stringify(HISTORY_MESSAGE_CHANNEL)};
  const expectedOrigin = ${JSON.stringify(expectedOrigin)};
  const createDocumentId = () => {
    const words = new Uint32Array(4);
    const crypto = globalThis.crypto;
    if (crypto && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(words);
    } else {
      for (let index = 0; index < words.length; index += 1) {
        words[index] = Math.floor(Math.random() * 0x100000000);
      }
    }
    return Array.from(words, (word) => word.toString(16).padStart(8, '0')).join('');
  };
  let documentId = createDocumentId();
  if (globalThis.location.origin !== expectedOrigin) return;
  if (globalThis.__REACT_NATIVE_LOCAL_WEBVIEW_CAPABILITY__ === capability) return;
  globalThis.__REACT_NATIVE_LOCAL_WEBVIEW_CAPABILITY__ = capability;
  globalThis.addEventListener(
    'pageshow',
    (event) => {
      if (event.persisted === true) documentId = createDocumentId();
    },
    true
  );
  const rejectUnauthorizedNativeMessage = (event) => {
    if (typeof event.data !== 'string') return;
    try {
      const message = JSON.parse(event.data);
      if (
        message &&
        message.channel === channel &&
        message.direction === 'native' &&
        (globalThis.top !== globalThis || message.capability !== capability)
      ) {
        event.stopImmediatePropagation();
        event.stopPropagation();
      }
    } catch {
      // Non-protocol messages belong to the host application.
    }
  };
  globalThis.addEventListener('message', rejectUnauthorizedNativeMessage, true);
  globalThis.document?.addEventListener('message', rejectUnauthorizedNativeMessage, true);
  if (globalThis.top !== globalThis) return;

  const nativeBridge = globalThis.ReactNativeWebView;
  if (!nativeBridge || typeof nativeBridge.postMessage !== 'function') return;
  const nativePostMessage = nativeBridge.postMessage.bind(nativeBridge);
  nativeBridge.postMessage = (value) => {
    if (typeof value === 'string') {
      try {
        const message = JSON.parse(value);
        if (
          message &&
          ((message.channel === channel && message.direction === 'web') ||
            message.channel === historyChannel)
        ) {
          message.capability = capability;
          message.documentId = documentId;
          return nativePostMessage(JSON.stringify(message));
        }
      } catch {
        // Preserve the native bridge behavior for application messages.
      }
    }
    return nativePostMessage(value);
  };
})();
true;
`;
}

function injectCapabilityBootstrap(html: string, capabilityBootstrap: string): string {
  const document = parse(html);
  let head: Element | undefined;
  const visit = (node: Node): void => {
    if ('tagName' in node && node.tagName === 'head') head = node;
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(document);
  if (!head) throw new Error('HTML document does not contain a <head>');

  const capabilityScript = parseFragment(
    `<script ${CAPABILITY_BOOTSTRAP_MARKER}>${escapeScriptRawText(capabilityBootstrap)}</script>`
  ).childNodes[0];
  if (!capabilityScript || !('tagName' in capabilityScript)) {
    throw new Error('Failed to construct the local document capability bootstrap');
  }
  capabilityScript.parentNode = head;
  head.childNodes.unshift(capabilityScript);
  return serialize(document);
}

function createDocumentStartScript(
  capability: string,
  expectedOrigin: string,
  assets: Record<string, AssetBridgeDescriptor>,
  userSource: string | undefined
): string {
  const localRuntime = [
    createAssetCapabilityBootstrap(capability, expectedOrigin),
    HISTORY_BRIDGE_SCRIPT,
    ...(Object.keys(assets).length > 0 ? [createAssetBridgeScript(assets)] : []),
  ].join('\n');
  return String.raw`
if (
  globalThis.top === globalThis &&
  globalThis.location.origin === ${JSON.stringify(expectedOrigin)}
) {
${localRuntime}
}
${userSource ?? ''}
true;
`;
}

function httpOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function assetStreamKey(capability: string, requestId: string, bundleEpoch: number): string {
  return `${capability}:${bundleEpoch}:${requestId}`;
}

function bridgeMessageEnvelope(
  data: string
): { capability?: string; channel?: string; documentId?: string } | undefined {
  try {
    return JSON.parse(data) as { capability?: string; channel?: string; documentId?: string };
  } catch {
    return undefined;
  }
}

export type { LocalWebViewHistoryState } from './historyState';

export type LocalWebViewHandle = {
  getHistoryState: () => LocalWebViewHistoryState;
  goBack: () => void;
  goForward: () => void;
  injectJavaScript: (script: string) => void;
  reload: () => void;
  rollback: () => Promise<boolean>;
  stopLoading: () => void;
};

export type LocalWebViewProps = Omit<WebViewProps, 'source' | 'renderLoading' | 'renderError'> & {
  cacheAdapter: LocalWebViewCacheAdapter;
  allowContentSecurityPolicyBypass?: boolean;
  cacheDirectory?: string;
  cachePolicy?: CachePolicy;
  forceRefresh?: boolean;
  onBundleError?: (error: Error) => void;
  onBundleReady?: (bundle: MirroredWebBundle) => void;
  onCacheRollback?: (bundle: MirroredWebBundle) => void;
  onHistoryChange?: (state: LocalWebViewHistoryState) => void;
  renderError?: (error: Error) => ReactNode;
  renderLoading?: (status: string) => ReactNode;
  /**
   * Skip origin-based discovery and open an existing local entry directly.
   * Its contents are still passed as HTML with `virtualUrl` as the base URL.
   */
  sourcePath?: string;
  trustedAssetOrigins?: string[];
  virtualUrl: string;
};

function assertHttpsUrl(virtualUrl: string): void {
  const url = new URL(virtualUrl);
  if (url.protocol !== 'https:' || !url.hostname) {
    throw new Error('virtualUrl must be an absolute HTTPS URL');
  }
}

function emptyHistoryState(url: string): LocalWebViewHistoryState {
  return {
    canGoBack: false,
    canGoForward: false,
    length: 1,
    navigationType: 'initial',
    state: null,
    stateSerializationFailed: false,
    url,
  };
}

export const LocalWebView = forwardRef<LocalWebViewHandle, LocalWebViewProps>(function LocalWebView(
  {
    cacheAdapter,
    allowContentSecurityPolicyBypass = false,
    allowsBackForwardNavigationGestures = true,
    cacheDirectory,
    cachePolicy,
    forceRefresh = false,
    injectedJavaScriptBeforeContentLoaded,
    onBundleError,
    onBundleReady,
    onCacheRollback,
    onError,
    onHistoryChange,
    onLoad,
    onLoadStart,
    onMessage,
    onNavigationStateChange,
    renderError,
    renderLoading,
    sourcePath,
    style,
    trustedAssetOrigins,
    virtualUrl,
    ...viewProps
  },
  forwardedRef
) {
  const [html, setHtml] = useState<string>();
  const [documentBaseUrl, setDocumentBaseUrl] = useState(virtualUrl);
  const [status, setStatus] = useState('Looking for a verified local bundle…');
  const [error, setError] = useState<Error>();
  const [assetCapability, setAssetCapability] = useState(createAssetCapability);
  const assetCapabilityRef = useRef(assetCapability);
  const bundleRef = useRef<MirroredWebBundle | undefined>(undefined);
  const webViewRef = useRef<WebView>(null);
  const assetAcknowledgementsRef = useRef(
    new Map<string, { reject: (error: Error) => void; resolve: () => void }>()
  );
  const activeAssetStreamsRef = useRef(new Set<string>());
  const activeDocumentIdRef = useRef<string | undefined>(undefined);
  const retiredDocumentIdsRef = useRef(new Set<string>());
  const queuedAssetStreamsRef = useRef(
    new Map<string, { bundleEpoch: number; resolve: (acquired: boolean) => void }>()
  );
  const cancelledAssetRequestsRef = useRef(new Set<string>());
  const bundleEpochRef = useRef(0);
  const documentObservedBeforeLoadStartRef = useRef(false);
  const loadStartAwaitingDocumentRef = useRef(false);
  const bundleLeaseReleaseRef = useRef<(() => void) | undefined>(undefined);
  const loadEpochRef = useRef(0);
  const initialBundleLoadRef = useRef<'complete' | 'loading' | 'pending'>('complete');
  const rollbackAttemptedRef = useRef(false);
  const historyRef = useRef(emptyHistoryState(virtualUrl));
  const callbacksRef = useRef({
    onBundleError,
    onBundleReady,
    onCacheRollback,
  });
  callbacksRef.current = {
    onBundleError,
    onBundleReady,
    onCacheRollback,
  };
  const cacheRoot = cacheDirectory ?? cacheDirectoryForOrigin(virtualUrl, cacheAdapter);
  const cacheMaxBytes = cachePolicy?.maxBytes;
  const cacheMaxGenerations = cachePolicy?.maxGenerations;
  const cacheMaxInlineBytes = cachePolicy?.maxInlineBytes;
  const trustedAssetOriginsKey = JSON.stringify([...(trustedAssetOrigins ?? [])].sort());

  const invalidateAssetStreams = useCallback((reason: string, clearActiveBundle = true): void => {
    bundleEpochRef.current += 1;
    if (clearActiveBundle) bundleRef.current = undefined;
    for (const acknowledgement of assetAcknowledgementsRef.current.values()) {
      acknowledgement.reject(new Error(reason));
    }
    assetAcknowledgementsRef.current.clear();
    for (const queued of queuedAssetStreamsRef.current.values()) {
      queued.resolve(false);
    }
    queuedAssetStreamsRef.current.clear();
    cancelledAssetRequestsRef.current.clear();
  }, []);

  const acquireAssetStream = useCallback(
    (requestId: string, bundleEpoch: number): Promise<boolean> => {
      if (
        bundleEpochRef.current !== bundleEpoch ||
        cancelledAssetRequestsRef.current.has(requestId)
      ) {
        return Promise.resolve(false);
      }
      if (
        activeAssetStreamsRef.current.has(requestId) ||
        queuedAssetStreamsRef.current.has(requestId)
      ) {
        throw new Error(`Duplicate local asset stream request: ${requestId}`);
      }
      if (activeAssetStreamsRef.current.size < MAX_CONCURRENT_ASSET_STREAMS) {
        activeAssetStreamsRef.current.add(requestId);
        return Promise.resolve(true);
      }
      if (queuedAssetStreamsRef.current.size >= MAX_QUEUED_ASSET_STREAMS) {
        throw new Error(
          `Too many queued local asset streams (maximum ${MAX_QUEUED_ASSET_STREAMS})`
        );
      }
      return new Promise<boolean>((resolve) => {
        queuedAssetStreamsRef.current.set(requestId, { bundleEpoch, resolve });
      });
    },
    []
  );

  const releaseAssetStream = useCallback((requestId: string): void => {
    if (!activeAssetStreamsRef.current.delete(requestId)) return;
    for (const [queuedRequestId, queued] of queuedAssetStreamsRef.current) {
      queuedAssetStreamsRef.current.delete(queuedRequestId);
      if (
        queued.bundleEpoch !== bundleEpochRef.current ||
        cancelledAssetRequestsRef.current.has(queuedRequestId)
      ) {
        queued.resolve(false);
        continue;
      }
      activeAssetStreamsRef.current.add(queuedRequestId);
      queued.resolve(true);
      return;
    }
  }, []);

  const buildBundleHtml = useCallback(
    async (bundle: MirroredWebBundle, capability: string): Promise<string> => {
      const contents = await readMirroredWebBundle(bundle.sourcePath, cacheAdapter);
      const prepared = prepareWebViewDocument(
        contents,
        bundle.localAssets,
        allowContentSecurityPolicyBypass
      );
      return injectCapabilityBootstrap(
        prepared,
        createAssetCapabilityBootstrap(capability, httpOrigin(bundle.baseUrl) ?? '')
      );
    },
    [cacheAdapter, allowContentSecurityPolicyBypass]
  );

  const activateBundle = useCallback(
    (
      bundle: MirroredWebBundle,
      contents: string,
      capability: string,
      preparedLease?: () => void
    ): void => {
      const nextLease =
        preparedLease ??
        (bundle.generationId === 'external'
          ? undefined
          : retainWebBundle(cacheRoot, bundle.generationId));
      const previousLease = bundleLeaseReleaseRef.current;
      bundleLeaseReleaseRef.current = nextLease;
      invalidateAssetStreams('The active local bundle changed');
      activeDocumentIdRef.current = undefined;
      retiredDocumentIdsRef.current.clear();
      documentObservedBeforeLoadStartRef.current = false;
      loadStartAwaitingDocumentRef.current = false;
      initialBundleLoadRef.current = 'pending';
      assetCapabilityRef.current = capability;
      bundleRef.current = bundle;
      setAssetCapability(capability);
      setDocumentBaseUrl(bundle.baseUrl);
      setHtml(contents);
      previousLease?.();
    },
    [cacheRoot, invalidateAssetStreams]
  );

  const postAssetMessage = useCallback((message: Record<string, unknown>): void => {
    webViewRef.current?.postMessage(
      JSON.stringify({
        channel: ASSET_MESSAGE_CHANNEL,
        capability: assetCapabilityRef.current,
        direction: 'native',
        ...message,
      })
    );
  }, []);

  const waitForAssetAcknowledgement = useCallback(
    (streamKey: string, requestId: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          assetAcknowledgementsRef.current.delete(streamKey);
          reject(new Error(`Timed out streaming local asset request ${requestId}`));
        }, ASSET_ACK_TIMEOUT_MS);
        assetAcknowledgementsRef.current.set(streamKey, {
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
          resolve: () => {
            clearTimeout(timeout);
            resolve();
          },
        });
      }),
    []
  );

  const streamLocalAsset = useCallback(
    async (
      streamKey: string,
      requestId: string,
      url: string,
      requestedStart?: number,
      requestedEnd?: number
    ): Promise<void> => {
      const asset = bundleRef.current?.localAssets[url];
      const bundleEpoch = bundleEpochRef.current;
      if (!asset) {
        postAssetMessage({
          kind: 'error',
          message: `No verified local asset for ${url}`,
          requestId,
        });
        return;
      }
      const start = requestedStart ?? 0;
      const end = requestedEnd ?? asset.size;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > asset.size
      ) {
        postAssetMessage({
          kind: 'error',
          message: `Invalid local asset byte range for ${url}`,
          requestId,
        });
        return;
      }
      let acquired = false;
      try {
        acquired = await acquireAssetStream(streamKey, bundleEpoch);
        if (
          !acquired ||
          bundleEpochRef.current !== bundleEpoch ||
          cancelledAssetRequestsRef.current.has(streamKey)
        ) {
          return;
        }
        for (let position = start; position < end; position += ASSET_CHUNK_BYTES) {
          if (
            bundleEpochRef.current !== bundleEpoch ||
            cancelledAssetRequestsRef.current.has(streamKey)
          ) {
            return;
          }
          const length = Math.min(ASSET_CHUNK_BYTES, end - position);
          const data = await cacheAdapter.readFileRange(
            asset.path,
            position,
            position + length,
            'base64'
          );
          if (
            bundleEpochRef.current !== bundleEpoch ||
            cancelledAssetRequestsRef.current.has(streamKey)
          ) {
            return;
          }
          const acknowledgement = waitForAssetAcknowledgement(streamKey, requestId);
          postAssetMessage({ data, kind: 'chunk', requestId });
          await acknowledgement;
        }
        if (bundleEpochRef.current === bundleEpoch) {
          postAssetMessage({ kind: 'end', requestId });
        }
      } catch (reason) {
        if (bundleEpochRef.current === bundleEpoch) {
          const message = reason instanceof Error ? reason.message : String(reason);
          postAssetMessage({ kind: 'error', message, requestId });
        }
      } finally {
        assetAcknowledgementsRef.current.delete(streamKey);
        cancelledAssetRequestsRef.current.delete(streamKey);
        if (acquired) releaseAssetStream(streamKey);
      }
    },
    [
      acquireAssetStream,
      cacheAdapter,
      postAssetMessage,
      releaseAssetStream,
      waitForAssetAcknowledgement,
    ]
  );

  const rollback = useCallback(async (): Promise<boolean> => {
    if (sourcePath) return false;
    const current = bundleRef.current;
    if (!current || current.generationId === 'external') return false;
    const loadEpoch = ++loadEpochRef.current;
    let previous: MirroredWebBundle | undefined;
    try {
      previous = await rollbackWebBundle(cacheRoot, cacheAdapter, current.generationId, virtualUrl);
    } catch (reason) {
      if (loadEpochRef.current !== loadEpoch) return false;
      throw reason;
    }
    if (loadEpochRef.current !== loadEpoch || !previous) return false;
    const preparedLease = retainWebBundle(cacheRoot, previous.generationId);
    const nextCapability = createAssetCapability();
    let contents: string;
    try {
      contents = await buildBundleHtml(previous, nextCapability);
    } catch (reason) {
      preparedLease();
      if (loadEpochRef.current !== loadEpoch) return false;
      throw reason;
    }
    if (loadEpochRef.current !== loadEpoch) {
      preparedLease();
      return false;
    }
    activateBundle(previous, contents, nextCapability, preparedLease);
    callbacksRef.current.onCacheRollback?.(previous);
    return true;
  }, [activateBundle, cacheAdapter, buildBundleHtml, cacheRoot, sourcePath, virtualUrl]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      getHistoryState: () => historyRef.current,
      goBack: () => webViewRef.current?.goBack(),
      goForward: () => webViewRef.current?.goForward(),
      injectJavaScript: (script) => webViewRef.current?.injectJavaScript(script),
      reload: () => webViewRef.current?.reload(),
      rollback,
      stopLoading: () => webViewRef.current?.stopLoading(),
    }),
    [rollback]
  );

  useEffect(
    () => () => {
      loadEpochRef.current += 1;
      invalidateAssetStreams('LocalWebView was unmounted');
      bundleLeaseReleaseRef.current?.();
      bundleLeaseReleaseRef.current = undefined;
    },
    [invalidateAssetStreams]
  );

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const loadEpoch = ++loadEpochRef.current;
    invalidateAssetStreams('The requested local bundle changed');
    bundleLeaseReleaseRef.current?.();
    bundleLeaseReleaseRef.current = undefined;
    rollbackAttemptedRef.current = false;
    initialBundleLoadRef.current = 'complete';
    historyRef.current = emptyHistoryState(virtualUrl);
    setHtml(undefined);
    setError(undefined);
    setStatus('Looking for a verified local bundle…');

    const bundlePromise = Promise.resolve().then(async (): Promise<MirroredWebBundle> => {
      assertHttpsUrl(virtualUrl);
      if (sourcePath) {
        return {
          baseUrl: virtualUrl,
          downloadedAssets: [],
          generationId: 'external',
          localAssets: {},
          rollbackAvailable: false,
          sourcePath,
          totalBytes: 0,
          usedCachedBundle: true,
        };
      }
      const normalizedTrustedOrigins = JSON.parse(trustedAssetOriginsKey) as string[];
      return resolveWebBundle({
        cacheAdapter,
        allowContentSecurityPolicyBypass,
        cacheDirectory,
        cachePolicy:
          cacheMaxBytes === undefined &&
          cacheMaxGenerations === undefined &&
          cacheMaxInlineBytes === undefined
            ? undefined
            : {
                maxBytes: cacheMaxBytes,
                maxGenerations: cacheMaxGenerations,
                maxInlineBytes: cacheMaxInlineBytes,
              },
        forceRefresh,
        onProgress: (message) => {
          if (active && loadEpochRef.current === loadEpoch) setStatus(message);
        },
        signal: controller.signal,
        trustedAssetOrigins:
          normalizedTrustedOrigins.length > 0 ? normalizedTrustedOrigins : undefined,
        virtualUrl,
      });
    });

    bundlePromise
      .then(async (bundle) => {
        const preparedLease =
          bundle.generationId === 'external'
            ? undefined
            : retainWebBundle(cacheRoot, bundle.generationId);
        const nextCapability = createAssetCapability();
        const contents = await buildBundleHtml(bundle, nextCapability).catch((reason: unknown) => {
          preparedLease?.();
          throw reason;
        });
        if (!active || loadEpochRef.current !== loadEpoch) {
          preparedLease?.();
          return;
        }
        activateBundle(bundle, contents, nextCapability, preparedLease);
        callbacksRef.current.onBundleReady?.(bundle);
      })
      .catch((reason: unknown) => {
        if (!active || loadEpochRef.current !== loadEpoch) return;
        const nextError = reason instanceof Error ? reason : new Error(String(reason));
        setError(nextError);
        callbacksRef.current.onBundleError?.(nextError);
      });

    return () => {
      active = false;
      controller.abort();
      if (loadEpochRef.current === loadEpoch) loadEpochRef.current += 1;
    };
  }, [
    activateBundle,
    cacheAdapter,
    allowContentSecurityPolicyBypass,
    buildBundleHtml,
    cacheDirectory,
    cacheRoot,
    cacheMaxBytes,
    cacheMaxGenerations,
    cacheMaxInlineBytes,
    forceRefresh,
    invalidateAssetStreams,
    sourcePath,
    trustedAssetOriginsKey,
    virtualUrl,
  ]);

  const observeDocument = (documentId: string | undefined): boolean => {
    if (typeof documentId !== 'string' || documentId.length < 16 || documentId.length > 128) {
      return false;
    }
    if (activeDocumentIdRef.current === documentId) return true;
    if (retiredDocumentIdsRef.current.has(documentId)) return false;
    if (activeDocumentIdRef.current !== undefined) {
      retiredDocumentIdsRef.current.add(activeDocumentIdRef.current);
    }
    if (loadStartAwaitingDocumentRef.current) {
      loadStartAwaitingDocumentRef.current = false;
    } else {
      invalidateAssetStreams('A new main document started using the local bridge', false);
      documentObservedBeforeLoadStartRef.current = true;
    }
    activeDocumentIdRef.current = documentId;
    return true;
  };

  const handleMessage = (event: WebViewMessageEvent) => {
    const asset = parseAssetMessage(event.nativeEvent.data);
    if (asset) {
      if (
        asset.direction !== 'web' ||
        !asset.requestId ||
        asset.capability !== assetCapabilityRef.current
      ) {
        onMessage?.(event);
        return;
      }
      const bundleOrigin = bundleRef.current && httpOrigin(bundleRef.current.baseUrl);
      const senderOrigin = httpOrigin(event.nativeEvent.url);
      if (!bundleOrigin || senderOrigin !== bundleOrigin) {
        onMessage?.(event);
        return;
      }
      if (!observeDocument(asset.documentId)) {
        onMessage?.(event);
        return;
      }
      const streamKey = assetStreamKey(asset.capability, asset.requestId, bundleEpochRef.current);
      if (asset.kind === 'request' && asset.url) {
        void streamLocalAsset(streamKey, asset.requestId, asset.url, asset.start, asset.end);
      } else if (asset.kind === 'ack') {
        const acknowledgement = assetAcknowledgementsRef.current.get(streamKey);
        assetAcknowledgementsRef.current.delete(streamKey);
        acknowledgement?.resolve();
      } else if (asset.kind === 'cancel') {
        const queued = queuedAssetStreamsRef.current.get(streamKey);
        const active = activeAssetStreamsRef.current.has(streamKey);
        const acknowledgement = assetAcknowledgementsRef.current.get(streamKey);
        if (!queued && !active && !acknowledgement) return;
        cancelledAssetRequestsRef.current.add(streamKey);
        queuedAssetStreamsRef.current.delete(streamKey);
        queued?.resolve(false);
        assetAcknowledgementsRef.current.delete(streamKey);
        acknowledgement?.reject(new Error('Local asset stream was cancelled'));
      }
      return;
    }
    const envelope = bridgeMessageEnvelope(event.nativeEvent.data);
    if (envelope?.channel === HISTORY_MESSAGE_CHANNEL) {
      const bundleOrigin = bundleRef.current && httpOrigin(bundleRef.current.baseUrl);
      const senderOrigin = httpOrigin(event.nativeEvent.url);
      if (
        envelope.capability !== assetCapabilityRef.current ||
        !bundleOrigin ||
        senderOrigin !== bundleOrigin
      ) {
        onMessage?.(event);
        return;
      }
      if (!observeDocument(envelope.documentId)) {
        onMessage?.(event);
        return;
      }
    }
    const nextHistory = historyStateFromMessage(event.nativeEvent.data, event.nativeEvent);
    if (nextHistory) {
      historyRef.current = nextHistory;
      onHistoryChange?.(nextHistory);
      return;
    }
    onMessage?.(event);
  };

  const handleNavigationStateChange = (navigation: WebViewNavigation) => {
    const bundleOrigin = bundleRef.current && httpOrigin(bundleRef.current.baseUrl);
    const navigationOrigin = httpOrigin(navigation.url);
    if (bundleOrigin && navigationOrigin && navigationOrigin !== bundleOrigin) {
      invalidateAssetStreams('The main document left the active bundle origin', false);
      initialBundleLoadRef.current = 'complete';
      historyRef.current = {
        ...emptyHistoryState(navigation.url),
        canGoBack: navigation.canGoBack,
        canGoForward: navigation.canGoForward,
        navigationType: 'document',
      };
    } else {
      historyRef.current = {
        ...historyRef.current,
        canGoBack: navigation.canGoBack,
        canGoForward: navigation.canGoForward,
        url: navigation.url,
      };
    }
    onHistoryChange?.(historyRef.current);
    onNavigationStateChange?.(navigation);
  };

  const handleLoadStart: NonNullable<WebViewProps['onLoadStart']> = (event) => {
    if (initialBundleLoadRef.current === 'pending') {
      const bundleOrigin = bundleRef.current && httpOrigin(bundleRef.current.baseUrl);
      initialBundleLoadRef.current =
        bundleOrigin && httpOrigin(event.nativeEvent.url) === bundleOrigin ? 'loading' : 'complete';
    } else if (initialBundleLoadRef.current === 'loading') {
      initialBundleLoadRef.current = 'complete';
    }
    if (documentObservedBeforeLoadStartRef.current) {
      documentObservedBeforeLoadStartRef.current = false;
      loadStartAwaitingDocumentRef.current = false;
    } else {
      invalidateAssetStreams('The main document started a new load', false);
      if (activeDocumentIdRef.current !== undefined) {
        retiredDocumentIdsRef.current.add(activeDocumentIdRef.current);
      }
      activeDocumentIdRef.current = undefined;
      loadStartAwaitingDocumentRef.current = true;
    }
    onLoadStart?.(event);
  };

  const handleLoad: NonNullable<WebViewProps['onLoad']> = (event) => {
    initialBundleLoadRef.current = 'complete';
    onLoad?.(event);
  };

  const handleError: NonNullable<WebViewProps['onError']> = (event) => {
    onError?.(event);
    const bundleOrigin = bundleRef.current && httpOrigin(bundleRef.current.baseUrl);
    const failedOrigin = httpOrigin(event.nativeEvent.url);
    const failedInitialBundleLoad =
      initialBundleLoadRef.current === 'loading' &&
      bundleOrigin !== undefined &&
      failedOrigin === bundleOrigin;
    initialBundleLoadRef.current = 'complete';
    if (
      failedInitialBundleLoad &&
      bundleRef.current?.rollbackAvailable &&
      !rollbackAttemptedRef.current
    ) {
      rollbackAttemptedRef.current = true;
      void rollback().catch((reason: unknown) => {
        const nextError = reason instanceof Error ? reason : new Error(String(reason));
        setError(nextError);
        callbacksRef.current.onBundleError?.(nextError);
      });
    }
  };

  if (error) {
    return renderError ? (
      renderError(error)
    ) : (
      <View style={[styles.center, style]}>
        <Text style={styles.error}>{error.message}</Text>
      </View>
    );
  }

  if (!html) {
    return renderLoading ? (
      renderLoading(status)
    ) : (
      <View style={[styles.center, style]}>
        <ActivityIndicator />
        <Text style={styles.status}>{status}</Text>
      </View>
    );
  }

  const documentStartScript = createDocumentStartScript(
    assetCapability,
    httpOrigin(documentBaseUrl) ?? '',
    bundleRef.current?.localAssets ?? {},
    injectedJavaScriptBeforeContentLoaded
  );

  return (
    <WebView
      {...viewProps}
      allowsBackForwardNavigationGestures={allowsBackForwardNavigationGestures}
      injectedJavaScriptBeforeContentLoaded={documentStartScript}
      key={assetCapability}
      onError={handleError}
      onLoad={handleLoad}
      onLoadStart={handleLoadStart}
      onMessage={handleMessage}
      onNavigationStateChange={handleNavigationStateChange}
      ref={webViewRef}
      source={{ baseUrl: documentBaseUrl, html }}
      style={style}
    />
  );
});

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    backgroundColor: '#f7f4ed',
    justifyContent: 'center',
    padding: 32,
  },
  error: {
    color: '#a32929',
    textAlign: 'center',
  },
  status: {
    color: '#302d29',
    marginTop: 12,
    textAlign: 'center',
  },
});
