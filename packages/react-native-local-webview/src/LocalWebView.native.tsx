import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Linking,
  type NativeSyntheticEvent,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { callback } from 'react-native-nitro-modules';
import { URL } from 'react-native-url-polyfill';
import type {
  FileDownloadEvent,
  ShouldStartLoadRequest,
  WebViewError,
  WebViewErrorEvent,
  WebViewEvent,
  WebViewHttpErrorEvent,
  WebViewMessageEvent,
  WebViewNavigation,
  WebViewNavigationEvent,
  WebViewOpenWindowEvent,
  WebViewProgressEvent,
  WebViewRenderProcessGoneEvent,
  WebViewScrollEvent,
  WebViewSource,
  WebViewSourceUri,
  WebViewTerminatedEvent,
  WebViewProps,
} from './localWebViewTypes';
import { historyStateFromMessage, type LocalWebViewHistoryState } from './historyState';
import { HISTORY_BRIDGE_SCRIPT } from './installHistoryBridge';
import {
  cacheDirectoryForOrigin,
  createWebBundleCacheRequest,
  readMirroredWebBundle,
  resolveWebBundle,
  retainWebBundle,
  rollbackWebBundle,
  type CachePolicy,
  type MirroredWebBundle,
  type WebBundleValidationMode,
} from './mirrorWebBundle';
import { getCacheAdapter } from './nitroCacheAdapter';
import { prepareRuntimeDocument } from './prepareWebViewDocument';
import { LocalWebViewHost, type LocalWebViewHostRef } from './LocalWebViewHost';
import {
  isOriginAllowed,
  configurationFromProps,
  viewPropsFromWebViewProps,
} from './webViewCompatibility';

const DEFAULT_ORIGIN_WHITELIST = ['http://*', 'https://*'] as const;
const BACKGROUND_WORK_SETTLE_MS = 3_000;
const REMOTE_LOAD_INSTALL_TIMEOUT_MS = 10_000;
const CUSTOM_PROP_NAMES = new Set([
  'allowContentSecurityPolicyBypass',
  'cacheDirectory',
  'cachePolicy',
  'durableCacheEnabled',
  'forceRefresh',
  'onBundleError',
  'onBundleReady',
  'onBundleStored',
  'onCacheRollback',
  'onHistoryChange',
  'sourcePath',
  'trustedAssetOrigins',
  'validationMode',
  'virtualUrl',
]);

type AssetManifestEntry = {
  mediaType: string;
  originalUrl: string;
  path: string;
  redirected: boolean;
  responseHeaders: Record<string, string>;
  responseUrl: string;
  size: number;
};

type RuntimeDocument = {
  assetsJson: string;
  baseUrl: string;
  cacheRequestJson: string;
  documentId: string;
  html: string;
  sourceJson: string;
};

type EventEnvelope = {
  nativeEvent: Record<string, unknown>;
  type:
    | 'contentProcessDidTerminate'
    | 'contentSizeChange'
    | 'customMenuSelection'
    | 'error'
    | 'fileDownload'
    | 'httpError'
    | 'load'
    | 'loadProgress'
    | 'loadStart'
    | 'loadSubResourceError'
    | 'message'
    | 'openWindow'
    | 'renderProcessGone'
    | 'runtimeError'
    | 'scroll'
    | 'sourceChanged';
};

function createSyntheticEvent<T extends Record<string, unknown>>(
  type: EventEnvelope['type'],
  nativeEvent: T
): NativeSyntheticEvent<T> {
  let defaultPrevented = false;
  let propagationStopped = false;
  const target = typeof nativeEvent.target === 'number' ? nativeEvent.target : 0;
  const event = {
    bubbles: undefined,
    cancelable: undefined,
    currentTarget: target,
    dispatchConfig: { registrationName: type },
    eventPhase: undefined,
    isDefaultPrevented: () => defaultPrevented,
    isPropagationStopped: () => propagationStopped,
    isTrusted: undefined,
    nativeEvent,
    persist: () => undefined,
    preventDefault: () => {
      defaultPrevented = true;
    },
    stopPropagation: () => {
      propagationStopped = true;
    },
    target,
    timeStamp: Date.now(),
    type,
  };
  Object.defineProperty(event, 'defaultPrevented', {
    enumerable: true,
    get: () => defaultPrevented,
  });
  return event as NativeSyntheticEvent<T>;
}

export type LocalWebViewHandle = {
  clearCache: (includeDiskFiles: boolean) => void;
  clearFormData: () => void;
  clearHistory: () => void;
  getHistoryState: () => LocalWebViewHistoryState;
  goBack: () => void;
  goForward: () => void;
  injectJavaScript: (script: string) => void;
  postMessage: (message: string) => void;
  reload: () => void;
  requestFocus: () => void;
  rollback: () => Promise<boolean>;
  stopLoading: () => void;
};

export type LocalWebViewComponent = ReturnType<
  typeof forwardRef<LocalWebViewHandle, LocalWebViewProps>
> & {
  isFileUploadSupported: () => Promise<boolean>;
};

export type LocalWebViewProps = Omit<WebViewProps, 'source'> & {
  allowContentSecurityPolicyBypass?: boolean;
  cacheDirectory?: string;
  cachePolicy?: CachePolicy;
  /**
   * Disable durable bundle mirroring and load the source directly.
   *
   * @default true
   */
  durableCacheEnabled?: boolean;
  forceRefresh?: boolean;
  onBundleError?: (error: Error) => void;
  onBundleReady?: (bundle: MirroredWebBundle) => void;
  onBundleStored?: (bundle: MirroredWebBundle) => void;
  onCacheRollback?: (bundle: MirroredWebBundle) => void;
  onHistoryChange?: (state: LocalWebViewHistoryState) => void;
  source?: WebViewSource;
  sourcePath?: string;
  trustedAssetOrigins?: string[];
  /**
   * Validate every resource with hashes, or require one entry ETag that
   * versions the complete release.
   *
   * @default 'content-hash'
   */
  validationMode?: WebBundleValidationMode;
  virtualUrl?: string;
};

function assertHttpsUrl(virtualUrl: string): void {
  const url = new URL(virtualUrl);
  if (url.protocol !== 'https:' || !url.hostname) {
    throw new Error('virtualUrl or source.uri must be an absolute HTTPS URL');
  }
}

function remoteUrl(props: Pick<LocalWebViewProps, 'source' | 'virtualUrl'>): string {
  if (props.virtualUrl && props.source) {
    throw new Error('Provide either virtualUrl or source, not both');
  }
  if (props.virtualUrl) return props.virtualUrl;
  if (props.source && 'uri' in props.source) return props.source.uri;
  throw new Error('LocalWebView requires virtualUrl or source');
}

function htmlSourceDocument(source: Extract<WebViewSource, { html: string }>): RuntimeDocument {
  const baseUrl = source.baseUrl ?? 'about:blank';
  return {
    assetsJson: '[]',
    baseUrl,
    cacheRequestJson: '',
    documentId: `html:${baseUrl}:${source.html}`,
    html: source.html,
    sourceJson: '',
  };
}

function runtimeDocument(bundle: MirroredWebBundle, sourceHtml: string): RuntimeDocument {
  const assets: AssetManifestEntry[] = [
    ...Object.entries(bundle.localAssets).map(([originalUrl, asset]) => ({
      mediaType: asset.mediaType,
      originalUrl,
      path: asset.path,
      redirected: asset.redirected,
      responseHeaders: asset.responseHeaders ?? {},
      responseUrl: asset.responseUrl,
      size: asset.size,
    })),
    {
      mediaType: 'text/html',
      originalUrl: bundle.baseUrl,
      path: bundle.sourcePath,
      redirected: false,
      responseHeaders: {},
      responseUrl: bundle.baseUrl,
      // The runtime receives the prepared entry separately, so its byte length can
      // differ from the downloaded source after CSP handling.
      size: 0,
    },
  ];
  return {
    assetsJson: JSON.stringify(assets),
    baseUrl: bundle.baseUrl,
    cacheRequestJson: '',
    documentId: bundle.generationId,
    html: sourceHtml,
    sourceJson: '',
  };
}

function directSourceDocument(source: WebViewSourceUri): RuntimeDocument {
  const sourceJson = JSON.stringify({
    body: source.body,
    headers: source.headers,
    method: source.method ?? 'GET',
    uri: source.uri,
  });
  return {
    assetsJson: '[]',
    baseUrl: source.uri,
    cacheRequestJson: '',
    documentId: `source:${sourceJson}`,
    html: '',
    sourceJson,
  };
}

function cacheDocument(request: ReturnType<typeof createWebBundleCacheRequest>): RuntimeDocument {
  const cacheRequestJson = JSON.stringify(request);
  return {
    assetsJson: '[]',
    baseUrl: request.virtualUrl,
    cacheRequestJson,
    documentId: `cache:${request.securityPolicyFingerprint}:${request.generationId ?? 'published'}:${request.virtualUrl}`,
    html: '',
    sourceJson: '',
  };
}

function emptyHistoryState(url: string): LocalWebViewHistoryState {
  return {
    canGoBack: false,
    canGoForward: false,
    length: 1,
    navigationType: 'document',
    state: undefined,
    stateSerializationFailed: false,
    url,
  };
}

function androidDocumentStartScript(props: LocalWebViewProps): string | undefined {
  if (Platform.OS !== 'android') return undefined;
  const scripts: string[] = [HISTORY_BRIDGE_SCRIPT];
  if (props.injectedJavaScriptObject !== undefined) {
    const objectJson = JSON.stringify(props.injectedJavaScriptObject);
    scripts.push(`
      window.ReactNativeWebView = window.ReactNativeWebView || {};
      window.ReactNativeWebView.injectedObjectJson = function () {
        return ${JSON.stringify(objectJson)};
      };
    `);
  }
  if (props.injectedJavaScriptBeforeContentLoaded) {
    scripts.push(props.injectedJavaScriptBeforeContentLoaded);
  }
  return scripts.length > 0 ? scripts.join('\n') : undefined;
}

const LocalWebViewImplementation = forwardRef<LocalWebViewHandle, LocalWebViewProps>(
  function LocalWebView(props, forwardedRef) {
    const {
      allowContentSecurityPolicyBypass = false,
      cacheDirectory,
      cachePolicy,
      containerStyle,
      durableCacheEnabled = true,
      forceRefresh = false,
      renderError,
      renderLoading,
      source,
      sourcePath,
      startInLoadingState = false,
      style,
      trustedAssetOrigins,
      validationMode = 'content-hash',
      virtualUrl,
    } = props;
    const cacheAdapter = getCacheAdapter();
    if (virtualUrl !== undefined && source !== undefined) {
      throw new Error('Provide either virtualUrl or source, not both');
    }
    if (sourcePath !== undefined && virtualUrl === undefined) {
      throw new Error('sourcePath requires virtualUrl');
    }
    const [document, setDocument] = useState<RuntimeDocument>();
    const [error, setError] = useState<WebViewError>();
    const [pageLoading, setPageLoading] = useState(startInLoadingState);
    const [status, setStatus] = useState('Looking for a durable local bundle…');
    const hostRef = useRef<LocalWebViewHostRef | undefined>(undefined);
    const leaseReleaseRef = useRef<(() => void) | undefined>(undefined);
    const bundleRef = useRef<MirroredWebBundle | undefined>(undefined);
    const documentEpochRef = useRef(0);
    const rollbackAttemptedRef = useRef(false);
    const rollbackRef = useRef<() => Promise<boolean>>(async () => false);
    const backgroundWorkGateRef = useRef<
      | {
          release: () => void;
          releaseWhenSettled: () => void;
        }
      | undefined
    >(undefined);
    const historyRef = useRef(
      emptyHistoryState(
        virtualUrl ??
          (source && 'uri' in source
            ? source.uri
            : source && 'html' in source
              ? (source.baseUrl ?? 'about:blank')
              : 'about:blank')
      )
    );
    const callbacksRef = useRef(props);
    callbacksRef.current = props;
    const sourceRef = useRef(source);
    sourceRef.current = source;

    const documentStartScript = androidDocumentStartScript(props);
    const configurationJson = useMemo(() => {
      const configuration = configurationFromProps(props);
      if (props.nativeConfig?.props) {
        Object.assign(configuration, props.nativeConfig.props);
      }
      configuration.hasOnShouldStartLoadWithRequest =
        props.onShouldStartLoadWithRequest !== undefined;
      configuration.hasOnContentSizeChange = props.onContentSizeChange !== undefined;
      configuration.hasOnFileDownload = props.onFileDownload !== undefined;
      configuration.hasOnMessage = props.onMessage !== undefined;
      configuration.hasOnOpenWindow = props.onOpenWindow !== undefined;
      configuration.hasOnScroll = props.onScroll !== undefined;
      configuration.isDirectHtmlSource =
        (props.source !== undefined && 'html' in props.source) ||
        (props.source === undefined && props.virtualUrl === undefined);
      configuration.messagingEnabled = Platform.OS === 'android' || props.onMessage !== undefined;
      configuration.documentStartScript = documentStartScript;
      configuration.originWhitelist = props.originWhitelist ?? DEFAULT_ORIGIN_WHITELIST;
      return JSON.stringify(configuration);
    }, [documentStartScript, props]);
    const forwardedViewProps = viewPropsFromWebViewProps(
      props as LocalWebViewProps & Record<string, unknown>,
      CUSTOM_PROP_NAMES
    );
    const preparation = useMemo((): {
      document?: RuntimeDocument;
      error?: Error;
    } => {
      if (
        !document ||
        document.cacheRequestJson ||
        document.sourceJson ||
        document.documentId.startsWith('html:')
      ) {
        return { document };
      }
      try {
        return {
          document: {
            ...document,
            html: prepareRuntimeDocument(
              document.html,
              allowContentSecurityPolicyBypass,
              documentStartScript
            ),
          },
        };
      } catch (reason) {
        return {
          error: reason instanceof Error ? reason : new Error(String(reason)),
        };
      }
    }, [allowContentSecurityPolicyBypass, document, documentStartScript]);
    useEffect(() => {
      if (!preparation.error) return;
      callbacksRef.current.onBundleError?.(preparation.error);
      setPageLoading(false);
      setError({
        canGoBack: false,
        canGoForward: false,
        code: -1,
        description: preparation.error.message,
        domain: 'ReactNativeLocalWebView',
        loading: false,
        lockIdentifier: 0,
        title: '',
        url: document?.baseUrl ?? 'about:blank',
      });
    }, [document?.baseUrl, preparation.error]);
    const preparedDocument = preparation.document;

    const handleEvent = useCallback((serialized: string) => {
      let envelope: EventEnvelope;
      try {
        envelope = JSON.parse(serialized) as EventEnvelope;
      } catch {
        return;
      }
      const current = callbacksRef.current;
      const event = createSyntheticEvent(envelope.type, envelope.nativeEvent) as unknown;
      const updateHistory = (fallbackNavigationType: string) => {
        const nativeEvent = envelope.nativeEvent;
        historyRef.current = {
          ...historyRef.current,
          canGoBack:
            typeof nativeEvent.canGoBack === 'boolean'
              ? nativeEvent.canGoBack
              : historyRef.current.canGoBack,
          canGoForward:
            typeof nativeEvent.canGoForward === 'boolean'
              ? nativeEvent.canGoForward
              : historyRef.current.canGoForward,
          navigationType:
            typeof nativeEvent.navigationType === 'string'
              ? nativeEvent.navigationType
              : fallbackNavigationType,
          url: typeof nativeEvent.url === 'string' ? nativeEvent.url : historyRef.current.url,
        };
        current.onHistoryChange?.(historyRef.current);
      };
      switch (envelope.type) {
        case 'contentProcessDidTerminate':
          current.onContentProcessDidTerminate?.(event as WebViewTerminatedEvent);
          return;
        case 'contentSizeChange':
          current.onContentSizeChange?.(event as WebViewEvent);
          return;
        case 'customMenuSelection':
          current.onCustomMenuSelection?.(
            event as Parameters<NonNullable<WebViewProps['onCustomMenuSelection']>>[0]
          );
          return;
        case 'error': {
          backgroundWorkGateRef.current?.release();
          const nextError = envelope.nativeEvent as unknown as WebViewError;
          const errorEvent = event as WebViewErrorEvent;
          setPageLoading(false);
          errorEvent.persist();
          current.onError?.(errorEvent);
          current.onLoadEnd?.(errorEvent);
          if (!errorEvent.isDefaultPrevented()) setError(nextError);
          if (bundleRef.current?.rollbackAvailable && !rollbackAttemptedRef.current) {
            rollbackAttemptedRef.current = true;
            void rollbackRef.current().catch((reason: unknown) => {
              const rollbackError = reason instanceof Error ? reason : new Error(String(reason));
              callbacksRef.current.onBundleError?.(rollbackError);
            });
          }
          return;
        }
        case 'fileDownload':
          current.onFileDownload?.(event as FileDownloadEvent);
          return;
        case 'httpError':
          current.onHttpError?.(event as WebViewHttpErrorEvent);
          return;
        case 'load':
          if (
            bundleRef.current !== undefined &&
            (current.validationMode ?? 'content-hash') === 'release-etag'
          ) {
            backgroundWorkGateRef.current?.release();
          } else {
            backgroundWorkGateRef.current?.releaseWhenSettled();
          }
          setPageLoading(false);
          setError(undefined);
          updateHistory('document');
          current.onLoad?.(event as WebViewNavigationEvent);
          current.onLoadEnd?.(event as WebViewNavigationEvent);
          current.onNavigationStateChange?.(envelope.nativeEvent as unknown as WebViewNavigation);
          return;
        case 'loadProgress':
          current.onLoadProgress?.(event as WebViewProgressEvent);
          return;
        case 'loadStart':
          updateHistory('document');
          current.onLoadStart?.(event as WebViewNavigationEvent);
          current.onNavigationStateChange?.(envelope.nativeEvent as unknown as WebViewNavigation);
          return;
        case 'loadSubResourceError':
          current.onLoadSubResourceError?.(event as WebViewErrorEvent);
          return;
        case 'message':
          if (typeof envelope.nativeEvent.data === 'string') {
            const history = historyStateFromMessage(envelope.nativeEvent.data, {
              canGoBack:
                typeof envelope.nativeEvent.canGoBack === 'boolean'
                  ? envelope.nativeEvent.canGoBack
                  : false,
              canGoForward:
                typeof envelope.nativeEvent.canGoForward === 'boolean'
                  ? envelope.nativeEvent.canGoForward
                  : false,
            });
            if (history) {
              historyRef.current = history;
              current.onHistoryChange?.(history);
              return;
            }
          }
          current.onMessage?.(event as WebViewMessageEvent);
          return;
        case 'openWindow':
          current.onOpenWindow?.(event as WebViewOpenWindowEvent);
          return;
        case 'renderProcessGone':
          current.onRenderProcessGone?.(event as WebViewRenderProcessGoneEvent);
          return;
        case 'runtimeError': {
          const description = envelope.nativeEvent.description;
          const message = typeof description === 'string' ? description : 'WebView runtime error';
          const nextError = new Error(message);
          current.onBundleError?.(nextError);
          return;
        }
        case 'scroll':
          current.onScroll?.(event as WebViewScrollEvent);
          return;
        case 'sourceChanged':
          current.onSourceChanged?.(event as WebViewNavigationEvent);
      }
    }, []);

    const eventCallback = useMemo(
      () => callback((event: string) => handleEvent(event)),
      [handleEvent]
    );
    const shouldStartCallback = useMemo(
      () =>
        callback((serialized: string): boolean => {
          let request: ShouldStartLoadRequest;
          try {
            request = JSON.parse(serialized) as ShouldStartLoadRequest;
          } catch {
            return false;
          }
          const current = callbacksRef.current;
          if (current.onShouldStartLoadWithRequest?.(request) === false) return false;
          const whitelist = current.originWhitelist ?? DEFAULT_ORIGIN_WHITELIST;
          if (isOriginAllowed(request.url, whitelist)) return true;
          void Linking.openURL(request.url).catch(() => undefined);
          return false;
        }),
      []
    );

    const sourceIsHtml = source !== undefined && 'html' in source;
    const sourceIsUri = source !== undefined && 'uri' in source;
    const sourceIsEmpty = source === undefined && virtualUrl === undefined;
    const usesDirectSource =
      (sourceIsUri &&
        (!durableCacheEnabled ||
          (source.method !== undefined && source.method.toUpperCase() !== 'GET') ||
          source.body !== undefined ||
          source.headers !== undefined ||
          !source.uri.startsWith('https://'))) ||
      (!durableCacheEnabled && virtualUrl !== undefined);
    const effectiveVirtualUrl =
      sourceIsHtml || sourceIsEmpty || usesDirectSource
        ? undefined
        : remoteUrl({ source, virtualUrl });
    const initialHistoryUrl =
      effectiveVirtualUrl ??
      (sourceIsUri
        ? source.uri
        : sourceIsHtml
          ? (source.baseUrl ?? 'about:blank')
          : (virtualUrl ?? 'about:blank'));
    const sourceKey = JSON.stringify(source ?? null);
    const cacheRoot =
      effectiveVirtualUrl === undefined
        ? undefined
        : (cacheDirectory ?? cacheDirectoryForOrigin(effectiveVirtualUrl, cacheAdapter));
    const cacheMaxBytes = cachePolicy?.maxBytes;
    const cacheMaxGenerations = cachePolicy?.maxGenerations;
    const cacheMaxInlineBytes = cachePolicy?.maxInlineBytes;
    const trustedAssetOriginsKey = JSON.stringify([...(trustedAssetOrigins ?? [])].sort());

    const rollback = useCallback(async (): Promise<boolean> => {
      const current = bundleRef.current;
      if (
        !current ||
        current.generationId === 'external' ||
        cacheRoot === undefined ||
        effectiveVirtualUrl === undefined
      ) {
        return false;
      }
      const operationEpoch = ++documentEpochRef.current;
      const previous = await rollbackWebBundle(
        cacheRoot,
        cacheAdapter,
        current.generationId,
        effectiveVirtualUrl
      );
      if (!previous || documentEpochRef.current !== operationEpoch) return false;
      const preparedLease = retainWebBundle(cacheRoot, previous.generationId);
      const nextDocument = cacheDocument(
        createWebBundleCacheRequest({
          allowContentSecurityPolicyBypass,
          cacheDirectory: cacheRoot,
          cachePolicy,
          generationId: previous.generationId,
          trustedAssetOrigins,
          validationMode,
          virtualUrl: effectiveVirtualUrl,
        })
      );
      if (documentEpochRef.current !== operationEpoch) {
        preparedLease();
        return false;
      }
      leaseReleaseRef.current?.();
      leaseReleaseRef.current = preparedLease;
      bundleRef.current = previous;
      setError(undefined);
      setDocument(nextDocument);
      callbacksRef.current.onCacheRollback?.(previous);
      return true;
    }, [
      allowContentSecurityPolicyBypass,
      cacheAdapter,
      cachePolicy,
      cacheRoot,
      effectiveVirtualUrl,
      trustedAssetOrigins,
      validationMode,
    ]);
    rollbackRef.current = rollback;

    useImperativeHandle(
      forwardedRef,
      () => ({
        clearCache: (includeDiskFiles) => hostRef.current?.clearCache(includeDiskFiles),
        clearFormData: () => hostRef.current?.clearFormData(),
        clearHistory: () => {
          hostRef.current?.clearHistory();
          historyRef.current = emptyHistoryState(historyRef.current.url);
          callbacksRef.current.onHistoryChange?.(historyRef.current);
        },
        getHistoryState: () => historyRef.current,
        goBack: () => hostRef.current?.goBack(),
        goForward: () => hostRef.current?.goForward(),
        injectJavaScript: (script) => hostRef.current?.injectJavaScript(script),
        postMessage: (message) => hostRef.current?.postMessage(message),
        reload: () => {
          setError(undefined);
          setPageLoading(true);
          hostRef.current?.reload();
        },
        requestFocus: () => hostRef.current?.requestFocus(),
        rollback,
        stopLoading: () => hostRef.current?.stopLoading(),
      }),
      [rollback]
    );

    useEffect(() => {
      let active = true;
      const controller = new AbortController();
      const documentEpoch = ++documentEpochRef.current;
      bundleRef.current = undefined;
      rollbackAttemptedRef.current = false;
      setDocument(undefined);
      setError(undefined);
      setStatus('Looking for a durable local bundle…');
      historyRef.current = emptyHistoryState(initialHistoryUrl);
      if (sourceIsEmpty) {
        setDocument(htmlSourceDocument({ html: '' }));
        return () => {
          active = false;
          controller.abort();
        };
      }
      if (sourceIsHtml) {
        const currentSource = sourceRef.current;
        if (!currentSource || !('html' in currentSource)) return;
        setDocument(htmlSourceDocument(currentSource));
        return () => {
          active = false;
          controller.abort();
        };
      }
      if (usesDirectSource) {
        const currentSource = sourceRef.current;
        if (currentSource && 'uri' in currentSource) {
          setDocument(directSourceDocument(currentSource));
        } else if (virtualUrl !== undefined) {
          setDocument(directSourceDocument({ uri: virtualUrl }));
        }
        return () => {
          active = false;
          controller.abort();
        };
      }
      const nextVirtualUrl = effectiveVirtualUrl!;
      assertHttpsUrl(nextVirtualUrl);

      const cacheRequest = createWebBundleCacheRequest({
        allowContentSecurityPolicyBypass,
        cacheDirectory: cacheRoot!,
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
        trustedAssetOrigins: JSON.parse(trustedAssetOriginsKey) as string[],
        validationMode,
        virtualUrl: nextVirtualUrl,
      });
      let publishedGenerationId: string | undefined;
      const waitForVisibleDocument = (): Promise<void> =>
        new Promise<void>((resolve) => {
          let released = false;
          let settleTimeout: ReturnType<typeof setTimeout> | undefined;
          const timeout = setTimeout(() => {
            release();
          }, REMOTE_LOAD_INSTALL_TIMEOUT_MS);
          const release = () => {
            if (released) return;
            released = true;
            clearTimeout(timeout);
            if (settleTimeout) clearTimeout(settleTimeout);
            if (backgroundWorkGateRef.current?.release === release) {
              backgroundWorkGateRef.current = undefined;
            }
            resolve();
          };
          const releaseWhenSettled = () => {
            if (released || settleTimeout) return;
            settleTimeout = setTimeout(release, BACKGROUND_WORK_SETTLE_MS);
          };
          backgroundWorkGateRef.current = { release, releaseWhenSettled };
        });
      let initialVisibleLoad: Promise<void> | undefined;
      if (sourcePath === undefined) {
        initialVisibleLoad = waitForVisibleDocument();
        setStatus('Opening the durable local bundle…');
        setDocument(cacheDocument(cacheRequest));
      }
      const registerLocalBundle = (bundle: MirroredWebBundle): void => {
        const preparedLease =
          bundle.generationId === 'external' || cacheRoot === undefined
            ? undefined
            : retainWebBundle(cacheRoot, bundle.generationId);
        if (!active || documentEpochRef.current !== documentEpoch) {
          preparedLease?.();
          return;
        }
        leaseReleaseRef.current?.();
        leaseReleaseRef.current = preparedLease;
        bundleRef.current = bundle;
        callbacksRef.current.onBundleReady?.(bundle);
      };
      const showRemoteDocument = (): void => {
        if (!active || documentEpochRef.current !== documentEpoch) return;
        leaseReleaseRef.current?.();
        leaseReleaseRef.current = undefined;
        bundleRef.current = undefined;
        rollbackAttemptedRef.current = false;
        setStatus('Loading the remote site while its durable copy is saved in the background…');
        setDocument(directSourceDocument({ uri: nextVirtualUrl }));
      };
      const showValidatedGeneration = (bundle: MirroredWebBundle): void => {
        registerLocalBundle(bundle);
        if (bundle.generationId === publishedGenerationId) return;
        setDocument(
          cacheDocument({
            ...cacheRequest,
            generationId: bundle.generationId,
          })
        );
      };

      if (sourcePath !== undefined) {
        void readMirroredWebBundle(sourcePath, cacheAdapter)
          .then((sourceHtml) => {
            const bundle: MirroredWebBundle = {
              baseUrl: nextVirtualUrl,
              downloadedAssets: [],
              generationId: 'external',
              localAssets: {},
              rollbackAvailable: false,
              sourcePath,
              totalBytes: 0,
              usedCachedBundle: true,
            };
            registerLocalBundle(bundle);
            setDocument(runtimeDocument(bundle, sourceHtml));
          })
          .catch((reason: unknown) => {
            if (!active || controller.signal.aborted) return;
            const nextError = reason instanceof Error ? reason : new Error(String(reason));
            callbacksRef.current.onBundleError?.(nextError);
            setError({
              canGoBack: false,
              canGoForward: false,
              code: -1,
              description: nextError.message,
              domain: 'ReactNativeLocalWebView',
              loading: false,
              lockIdentifier: 0,
              title: '',
              url: nextVirtualUrl,
            });
          });
      } else {
        void resolveWebBundle({
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
          onPublishedBundle: async (publishedBundle) => {
            publishedGenerationId = publishedBundle?.generationId;
            if (publishedBundle) {
              registerLocalBundle(publishedBundle);
              await initialVisibleLoad;
            } else {
              // The native loader already falls back to this URL on a cache miss.
              await initialVisibleLoad;
            }
          },
          onCachedBundle: async (cachedBundle) => {
            if (cachedBundle) {
              if (cachedBundle.generationId === publishedGenerationId) return;
              const loaded = waitForVisibleDocument();
              showValidatedGeneration(cachedBundle);
              await loaded;
            } else if (publishedGenerationId === undefined) {
              // The native cache miss is already displaying the remote document.
            } else {
              showRemoteDocument();
            }
          },
          onProgress: (message) => {
            if (active) setStatus(message);
          },
          signal: controller.signal,
          trustedAssetOrigins: JSON.parse(trustedAssetOriginsKey) as string[],
          validationMode,
          virtualUrl: nextVirtualUrl,
        })
          .then((bundle) => {
            if (!active || documentEpochRef.current !== documentEpoch) return;
            callbacksRef.current.onBundleStored?.(bundle);
          })
          .catch((reason: unknown) => {
            if (!active || controller.signal.aborted) return;
            const nextError = reason instanceof Error ? reason : new Error(String(reason));
            callbacksRef.current.onBundleError?.(nextError);
          });
      }

      return () => {
        active = false;
        backgroundWorkGateRef.current?.release();
        controller.abort();
        documentEpochRef.current += 1;
        leaseReleaseRef.current?.();
        leaseReleaseRef.current = undefined;
        bundleRef.current = undefined;
      };
    }, [
      allowContentSecurityPolicyBypass,
      cacheAdapter,
      cacheDirectory,
      durableCacheEnabled,
      cacheMaxBytes,
      cacheMaxGenerations,
      cacheMaxInlineBytes,
      cacheRoot,
      effectiveVirtualUrl,
      forceRefresh,
      initialHistoryUrl,
      sourceKey,
      sourceIsEmpty,
      sourceIsHtml,
      sourcePath,
      trustedAssetOriginsKey,
      usesDirectSource,
      validationMode,
      virtualUrl,
    ]);

    const loading = pageLoading;
    const errorView = error
      ? renderError?.(error.domain, error.code, error.description)
      : undefined;
    return (
      <View style={[styles.container, containerStyle]}>
        {preparedDocument ? (
          <LocalWebViewHost
            {...forwardedViewProps}
            assetsJson={preparedDocument.assetsJson}
            baseUrl={preparedDocument.baseUrl}
            cacheRequestJson={preparedDocument.cacheRequestJson}
            configurationJson={configurationJson}
            documentId={preparedDocument.documentId}
            html={preparedDocument.html}
            hybridRef={callback((ref) => {
              hostRef.current = ref;
            })}
            onEvent={eventCallback}
            onShouldStartLoadWithRequest={shouldStartCallback}
            sourceJson={preparedDocument.sourceJson}
            style={[styles.webView, style]}
            {...(props.nativeConfig?.props as Record<string, unknown> | undefined)}
          />
        ) : null}
        {error
          ? (errorView ?? (
              <View style={styles.center}>
                <Text style={styles.error}>{error.description}</Text>
              </View>
            ))
          : loading
            ? (renderLoading?.() ?? (
                <View style={styles.center}>
                  <ActivityIndicator />
                  <Text style={styles.status}>{status}</Text>
                </View>
              ))
            : null}
      </View>
    );
  }
);

export const LocalWebView = Object.assign(LocalWebViewImplementation, {
  isFileUploadSupported: async (): Promise<boolean> => true,
}) as LocalWebViewComponent;

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    backgroundColor: '#f7f4ed',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  error: {
    color: '#b00020',
    padding: 16,
  },
  status: {
    marginTop: 8,
    paddingHorizontal: 16,
    textAlign: 'center',
  },
  webView: {
    flex: 1,
  },
});
