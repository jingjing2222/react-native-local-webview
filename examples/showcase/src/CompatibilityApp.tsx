import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import {
  ANDROID_WEBVIEW_PROP_NAMES,
  IOS_WEBVIEW_PROP_NAMES,
  LocalWebView,
  SHARED_WEBVIEW_PROP_NAMES,
  type LocalWebViewHandle,
  type LocalWebViewProps,
  type WebViewProps,
} from 'react-native-local-webview';

type CompatibilityConfiguration = {
  origin: string;
  platform: 'android' | 'ios';
  profile: string;
  runId: string;
};

type ActiveCase = {
  expectation?:
    | 'basic-auth'
    | 'callbacks'
    | 'direct-html-csp'
    | 'dom-storage'
    | 'file-download'
    | 'frame-injection'
    | 'http-error'
    | 'javascript-disabled'
    | 'load'
    | 'message'
    | 'method-routing'
    | 'methods'
    | 'open-window'
    | 'origin-whitelist'
    | 'prevent-error'
    | 'render-error'
    | 'render-loading'
    | 'scroll'
    | 'should-start'
    | 'subresource-error'
    | 'user-agent';
  id: number;
  name: string;
  props: Partial<WebViewProps>;
  source?: NonNullable<WebViewProps['source']>;
  virtualUrl?: string;
};

type PendingCase = {
  diagnostic?: string;
  reject: (error: Error) => void;
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
};

type CallbackObservations = {
  contentSizeChange: boolean;
  load: boolean;
  loadEnd: boolean;
  loadProgress: boolean;
  loadStart: boolean;
  navigationStateChange: boolean;
  syntheticEvent: boolean;
};

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><main style="height:2000px">compatibility fixture</main></body></html>`;

const METHODS_BEHAVIOR_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body><script>
addEventListener('message', event => {
  window.ReactNativeWebView.postMessage('native:' + event.data);
});
</script></body></html>`;

export function configurationFromCompatibilityUrl(
  value: string | null
): CompatibilityConfiguration | undefined {
  if (!value) return undefined;
  try {
    if (!value.startsWith('local-webview-benchmark://compatibility')) {
      return undefined;
    }
    const url = new URL(value);
    if (url.protocol !== 'local-webview-benchmark:') {
      return undefined;
    }
    const origin = url.searchParams.get('origin');
    const runId = url.searchParams.get('runId');
    const platform = url.searchParams.get('platform');
    if (
      !origin ||
      !runId ||
      new URL(origin).protocol !== 'https:' ||
      (platform !== 'android' && platform !== 'ios')
    ) {
      return undefined;
    }
    return {
      origin: new URL(origin).origin,
      platform,
      profile: url.searchParams.get('profile') || 'default',
      runId,
    };
  } catch {
    return undefined;
  }
}

async function postJson(origin: string, path: string, value: unknown): Promise<void> {
  const response = await fetch(`${origin}${path}`, {
    body: JSON.stringify(value),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
}

function callbackProp(name: string): boolean {
  return name.startsWith('on') || name === 'renderError' || name === 'renderLoading';
}

function valueForProp(name: string, origin: string): unknown {
  if (callbackProp(name)) {
    if (name === 'onShouldStartLoadWithRequest') return () => true;
    if (name === 'renderError') return () => <View testID="render-error" />;
    if (name === 'renderLoading') return () => <View testID="render-loading" />;
    return () => undefined;
  }
  switch (name) {
    case 'source':
      return { baseUrl: `${origin}/compatibility/source/`, html: HTML };
    case 'containerStyle':
      return { flex: 1 };
    case 'injectedJavaScript':
    case 'injectedJavaScriptBeforeContentLoaded':
      return 'globalThis.__localWebViewCompatibility = true; true;';
    case 'injectedJavaScriptObject':
      return { compatibility: true };
    case 'originWhitelist':
      return ['https://*'];
    case 'nativeConfig':
      return {
        props: { accessibilityLabel: 'native-config-compatibility' },
      };
    case 'applicationNameForUserAgent':
      return 'LocalWebViewCompatibility';
    case 'basicAuthCredential':
      return { password: 'password', username: 'user' };
    case 'decelerationRate':
      return 'normal';
    case 'contentInset':
      return { bottom: 1, left: 2, right: 3, top: 4 };
    case 'contentInsetAdjustmentBehavior':
      return 'never';
    case 'contentMode':
      return 'recommended';
    case 'dataDetectorTypes':
      return ['none'];
    case 'userAgent':
      return 'LocalWebViewCompatibility/1.0';
    case 'allowingReadAccessToURL':
      return origin;
    case 'indicatorStyle':
      return 'default';
    case 'mediaCapturePermissionGrantType':
      return 'deny';
    case 'menuItems':
      return [{ key: 'compatibility', label: 'Compatibility' }];
    case 'suppressMenuItems':
      return ['copy'];
    case 'cacheMode':
      return 'LOAD_DEFAULT';
    case 'overScrollMode':
      return 'always';
    case 'androidLayerType':
      return 'none';
    case 'textZoom':
      return 100;
    case 'mixedContentMode':
      return 'never';
    case 'minimumFontSize':
      return 8;
    case 'downloadingMessage':
      return 'Downloading compatibility fixture';
    case 'lackPermissionToDownloadMessage':
      return 'Download permission unavailable';
    case 'useWebView2':
      return true;
    default:
      return ![
        'enableApplePay',
        'forceDarkOn',
        'incognito',
        'limitsNavigationsToAppBoundDomains',
        'paymentRequestEnabled',
        'pullToRefreshEnabled',
        'refreshControlLightMode',
        'setDisplayZoomControls',
        'startInLoadingState',
      ].includes(name);
  }
}

function propCases(platform: CompatibilityConfiguration['platform'], origin: string): ActiveCase[] {
  const names = [
    ...new Set([
      ...SHARED_WEBVIEW_PROP_NAMES,
      ...(platform === 'ios' ? IOS_WEBVIEW_PROP_NAMES : ANDROID_WEBVIEW_PROP_NAMES),
    ]),
  ];
  return names.map((name, index) => {
    const value = valueForProp(name, origin);
    const props = name === 'source' ? {} : ({ [name]: value } as Partial<WebViewProps>);
    return {
      id: index + 1,
      name,
      props,
      source:
        name === 'source'
          ? (value as NonNullable<WebViewProps['source']>)
          : { baseUrl: `${origin}/compatibility/${name}/`, html: HTML },
    };
  });
}

function behaviorCases(
  origin: string,
  firstId: number,
  platform: CompatibilityConfiguration['platform']
): ActiveCase[] {
  const shared: ActiveCase[] = [
    {
      expectation: 'message',
      id: firstId,
      name: 'behavior:injection-message-history-origin',
      props: {
        injectedJavaScriptBeforeContentLoaded: 'globalThis.__beforeContentLoaded = true; true;',
        injectedJavaScriptObject: { compatibility: true },
      },
      virtualUrl: `${origin}/compatibility/index.html`,
    },
    {
      expectation: 'should-start',
      id: firstId + 1,
      name: 'behavior:should-start',
      props: {},
      source: {
        baseUrl: `${origin}/compatibility/navigation/`,
        html: `<!doctype html><a id="next" href="${origin}/compatibility/blocked">next</a>
<script>setTimeout(() => document.querySelector('#next').click(), 20)</script>`,
      },
    },
    {
      expectation: 'open-window',
      id: firstId + 2,
      name: 'behavior:open-window',
      props: {
        javaScriptCanOpenWindowsAutomatically: true,
        setSupportMultipleWindows: true,
      },
      source: {
        baseUrl: `${origin}/compatibility/window/`,
        html: `<!doctype html><script>
addEventListener('DOMContentLoaded', () =>
  window.open('${origin}/compatibility/popup', '_blank'));</script>`,
      },
    },
    {
      expectation: 'scroll',
      id: firstId + 3,
      name: 'behavior:scroll',
      props: {},
      source: {
        baseUrl: `${origin}/compatibility/scroll/`,
        html: `${HTML}<script>setTimeout(() => scrollTo(0, 600), 30)</script>`,
      },
    },
    {
      expectation: 'methods',
      id: firstId + 4,
      name: 'behavior:imperative-methods',
      props: {},
      source: {
        baseUrl: `${origin}/compatibility/methods/`,
        html: METHODS_BEHAVIOR_HTML,
      },
    },
    {
      expectation: 'callbacks',
      id: firstId + 5,
      name: 'behavior:load-callbacks',
      props: {},
      source: {
        baseUrl: `${origin}/compatibility/callbacks/`,
        html: '<!doctype html><html><head><title>callbacks</title></head><body>callbacks</body></html>',
      },
    },
    {
      expectation: 'javascript-disabled',
      id: firstId + 6,
      name: 'behavior:javascript-disabled',
      props: { javaScriptEnabled: false },
      source: {
        baseUrl: `${origin}/compatibility/javascript-disabled/`,
        html: `<!doctype html><script>
          window.ReactNativeWebView.postMessage('javascript-ran');
        </script>`,
      },
    },
    {
      expectation: 'frame-injection',
      id: firstId + 7,
      name: 'behavior:frame-targeted-injection',
      props: {
        injectedJavaScript: `
          globalThis.__injectedAtDocumentEnd = true;
          if (window !== top) {
            parent.postMessage({
              channel: 'frame-injection',
              frame: true,
              atEnd: globalThis.__injectedAtDocumentEnd === true,
              before: globalThis.__injectedBeforeContent === true
            }, '*');
          } else if (${JSON.stringify(platform)} === 'android') {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              channel: 'frame-injection',
              frame: false,
              atEnd: true,
              before: globalThis.__injectedBeforeContent === true
            }));
          }
          true;
        `,
        injectedJavaScriptBeforeContentLoaded: 'globalThis.__injectedBeforeContent = true; true;',
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly: platform !== 'ios',
        injectedJavaScriptForMainFrameOnly: platform !== 'ios',
      },
      source: {
        baseUrl: `${origin}/compatibility/frame-injection/`,
        html: `<!doctype html><script>
          addEventListener('message', event => {
            if (event.data?.channel === 'frame-injection') {
              window.ReactNativeWebView.postMessage(JSON.stringify(event.data));
            }
          });
          addEventListener('DOMContentLoaded', () => {
            const frame = document.querySelector('iframe');
            setTimeout(() => {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                channel: 'frame-injection',
                frame: true,
                atEnd: frame.contentWindow.__injectedAtDocumentEnd === true,
                before: frame.contentWindow.__injectedBeforeContent === true
              }));
            }, 100);
          });
        </script><iframe src="${origin}/compatibility/frame-child"></iframe>`,
      },
    },
    {
      expectation: 'origin-whitelist',
      id: firstId + 8,
      name: 'behavior:origin-whitelist',
      props: { originWhitelist: ['https://*'] },
      source: {
        baseUrl: `${origin}/compatibility/origin-whitelist/`,
        html: `<!doctype html><a id="blocked" href="local-webview-blocked://outside">blocked</a>
          <script>
            setTimeout(() => document.querySelector('#blocked').click(), 20);
            setTimeout(() => window.ReactNativeWebView.postMessage(
              'origin-after-block:' + location.href
            ), 400);
          </script>`,
      },
    },
    {
      expectation: 'http-error',
      id: firstId + 9,
      name: 'behavior:http-error',
      props: {},
      source: { headers: {}, uri: `${origin}/compatibility/http-error` },
    },
    {
      expectation: 'basic-auth',
      id: firstId + 10,
      name: 'behavior:basic-auth',
      props: {
        basicAuthCredential: {
          password: 'password',
          username: 'compatibility',
        },
      },
      source: { headers: {}, uri: `${origin}/compatibility/basic-auth` },
    },
    {
      expectation: 'user-agent',
      id: firstId + 11,
      name: 'behavior:user-agent',
      props: { userAgent: 'LocalWebView-E2E/13.16.0' },
      source: {
        baseUrl: `${origin}/compatibility/user-agent/`,
        html: `<!doctype html><script>
          window.ReactNativeWebView.postMessage('user-agent:' + navigator.userAgent);
        </script>`,
      },
    },
    {
      expectation: 'dom-storage',
      id: firstId + 12,
      name: 'behavior:dom-storage',
      props: { domStorageEnabled: true },
      source: {
        baseUrl: `${origin}/compatibility/dom-storage/`,
        html: `<!doctype html><script>
          localStorage.setItem('local-webview-e2e', 'ok');
          window.ReactNativeWebView.postMessage(
            'dom-storage:' + localStorage.getItem('local-webview-e2e')
          );
        </script>`,
      },
    },
    {
      expectation: 'render-loading',
      id: firstId + 13,
      name: 'behavior:render-loading',
      props: { startInLoadingState: true },
      source: {
        baseUrl: `${origin}/compatibility/render-loading/`,
        html: HTML,
      },
    },
    {
      expectation: 'render-error',
      id: firstId + 14,
      name: 'behavior:render-error',
      props: {},
      source: {
        headers: {},
        uri:
          platform === 'ios'
            ? 'https://react-native-local-webview.invalid/expected-error'
            : 'https://127.0.0.1:1/expected-error',
      },
    },
  ];
  if (platform === 'android') {
    shared.push({
      expectation: 'subresource-error',
      id: firstId + 15,
      name: 'behavior:subresource-error',
      props: {},
      source: {
        baseUrl: `${origin}/compatibility/subresource-error/`,
        html: '<html><body><img src="https://127.0.0.1:1/compatibility/missing-image.png"></body></html>',
      },
    });
  } else {
    shared.push({
      expectation: 'file-download',
      id: firstId + 15,
      name: 'behavior:file-download',
      props: {},
      source: { headers: {}, uri: `${origin}/compatibility/download` },
    });
  }
  shared.push({
    expectation: 'method-routing',
    id: firstId + 16,
    name: 'behavior:local-assets-only-intercept-get-and-head',
    props: {},
    virtualUrl: `${origin}/compatibility/method-routing?fixture=fetch-xhr-range-v4`,
  });
  shared.push({
    expectation: 'prevent-error',
    id: firstId + 17,
    name: 'behavior:prevent-default-error-renderer',
    props: {},
    source: {
      headers: {},
      uri:
        platform === 'ios'
          ? 'https://react-native-local-webview.invalid/prevented-error'
          : 'https://127.0.0.1:1/prevented-error',
    },
  });
  shared.push({
    expectation: 'direct-html-csp',
    id: firstId + 18,
    name: 'behavior:direct-html-preserves-csp',
    props: {},
    source: {
      baseUrl: `${origin}/compatibility/direct-html-csp/`,
      html: `<!doctype html><html><head>
        <meta http-equiv="Content-Security-Policy" content="script-src 'none'">
        </head><body><script>
          window.ReactNativeWebView.postMessage('csp-inline-ran');
        </script></body></html>`,
    },
  });
  return shared;
}

export default function CompatibilityApp({
  configuration,
}: {
  configuration: CompatibilityConfiguration;
}) {
  const cases = useMemo(
    () => propCases(configuration.platform, configuration.origin),
    [configuration.origin, configuration.platform]
  );
  const behaviors = useMemo(
    () => behaviorCases(configuration.origin, cases.length + 1, configuration.platform),
    [cases.length, configuration.origin, configuration.platform]
  );
  const [active, setActive] = useState<ActiveCase>();
  const [failure, setFailure] = useState<string>();
  const [status, setStatus] = useState('Preparing prop compatibility E2E…');
  const pending = useRef<PendingCase | undefined>(undefined);
  const webViewRef = useRef<LocalWebViewHandle>(null);
  const methodPhase = useRef(0);
  const callbackObservations = useRef<CallbackObservations>({
    contentSizeChange: false,
    load: false,
    loadEnd: false,
    loadProgress: false,
    loadStart: false,
    navigationStateChange: false,
    syntheticEvent: false,
  });

  const mount = useCallback((test: ActiveCase) => {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const diagnostic = pending.current?.diagnostic;
        pending.current = undefined;
        setActive(undefined);
        reject(
          new Error(
            `Timed out mounting prop: ${test.name}${
              diagnostic ? `; last event: ${diagnostic}` : ''
            }`
          )
        );
      }, 15_000);
      pending.current = { reject, resolve, timeout };
      setActive(test);
    });
  }, []);

  const settle = useCallback(async () => {
    const current = pending.current;
    if (!current) return;
    clearTimeout(current.timeout);
    pending.current = undefined;
    setActive(undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    current.resolve();
  }, []);

  const run = useCallback(async () => {
    const { origin, platform, profile, runId } = configuration;
    await postJson(origin, '/__control/reset', { runId });
    const startedAt = Date.now();
    const passed: string[] = [];
    for (const test of cases) {
      setStatus(`Prop ${passed.length + 1}/${cases.length}: ${test.name}`);
      await mount(test);
      passed.push(test.name);
    }
    const missing = cases.map(({ name }) => name).filter((name) => !passed.includes(name));
    if (missing.length > 0) {
      throw new Error(`Props without a completed native mount: ${missing.join(', ')}`);
    }
    const fileUploadSupported = await LocalWebView.isFileUploadSupported();
    if (!fileUploadSupported) throw new Error('Native file upload support is unavailable.');
    const behaviorPassed: string[] = [];
    for (const test of behaviors) {
      setStatus(`Behavior ${behaviorPassed.length + 1}/${behaviors.length}: ${test.name}`);
      methodPhase.current = 0;
      callbackObservations.current = {
        contentSizeChange: false,
        load: false,
        loadEnd: false,
        loadProgress: false,
        loadStart: false,
        navigationStateChange: false,
        syntheticEvent: false,
      };
      await mount(test);
      behaviorPassed.push(test.name);
    }
    await postJson(origin, '/__control/report', {
      behaviorPassed,
      behaviorTotal: behaviors.length,
      durationMilliseconds: Date.now() - startedAt,
      kind: 'webview-prop-compatibility',
      passed,
      platform,
      profile,
      runId,
      total: cases.length,
    });
    await postJson(origin, '/__control/complete', {
      kind: 'complete',
      platform,
      profile,
      runId,
      suite: 'webview-props',
    });
    setStatus(`All ${cases.length} applicable WebView props mounted successfully.`);
  }, [behaviors, cases, configuration, mount]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run().catch(async (reason: unknown) => {
      const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
      setFailure(message);
      setStatus('Prop compatibility E2E failed');
      setActive(undefined);
      await postJson(configuration.origin, '/__control/complete', {
        error: message,
        kind: 'complete',
        platform: configuration.platform,
        profile: configuration.profile,
        runId: configuration.runId,
        suite: 'webview-props',
      }).catch(() => undefined);
    });
  }, [configuration, run]);

  const activeProps = active?.props as Partial<LocalWebViewProps> | undefined;
  const settleCallbacksIfComplete = () => {
    const observations = callbackObservations.current;
    if (pending.current) {
      pending.current.diagnostic = `callbacks=${JSON.stringify(observations)}`;
    }
    if (
      observations.load &&
      observations.loadEnd &&
      observations.loadProgress &&
      observations.loadStart &&
      observations.navigationStateChange &&
      observations.syntheticEvent &&
      (configuration.platform === 'ios' || observations.contentSizeChange)
    ) {
      void settle();
    }
  };
  return (
    <View style={styles.container}>
      {active ? (
        <LocalWebView
          {...activeProps}
          key={active.id}
          ref={webViewRef}
          renderError={(domain, code, description) => {
            const rendered = activeProps?.renderError?.(domain, code, description);
            if (active.expectation === 'render-error') {
              setTimeout(() => void settle(), 0);
            } else if (active.expectation === 'prevent-error') {
              setTimeout(() => {
                pending.current?.reject(
                  new Error('preventDefault() did not suppress the default error renderer')
                );
              }, 0);
            }
            return rendered ?? <View testID="compatibility-render-error" />;
          }}
          renderLoading={() => {
            const rendered = activeProps?.renderLoading?.();
            if (active.expectation === 'render-loading') {
              setTimeout(() => void settle(), 0);
            }
            return rendered ?? <View testID="compatibility-render-loading" />;
          }}
          onBundleError={(reason) => {
            const current = pending.current;
            if (!current) return;
            clearTimeout(current.timeout);
            pending.current = undefined;
            current.reject(new Error(`${active.name}: ${reason.message}`));
          }}
          onError={(event) => {
            const { nativeEvent } = event;
            activeProps?.onError?.(event);
            const current = pending.current;
            if (!current) return;
            current.diagnostic = `${nativeEvent.domain} ${nativeEvent.code} ${nativeEvent.description}`;
            if (active.expectation === 'render-error') return;
            if (active.expectation === 'prevent-error') {
              event.preventDefault();
              setTimeout(() => void settle(), 250);
              return;
            }
            clearTimeout(current.timeout);
            pending.current = undefined;
            current.reject(
              new Error(
                `${active.name}: ${nativeEvent.domain} ${nativeEvent.code} ${nativeEvent.description}`
              )
            );
          }}
          onHttpError={(event) => {
            activeProps?.onHttpError?.(event);
            if (active.expectation === 'http-error' && event.nativeEvent.statusCode === 418) {
              void settle();
            }
          }}
          onLoad={(event) => {
            activeProps?.onLoad?.(event);
            if (active.expectation === 'callbacks') {
              callbackObservations.current.load = true;
              event.persist();
              event.preventDefault();
              const prevented = event.defaultPrevented === true && event.isDefaultPrevented();
              event.stopPropagation();
              callbackObservations.current.syntheticEvent =
                prevented && event.isPropagationStopped();
              settleCallbacksIfComplete();
            }
          }}
          onLoadStart={(event) => {
            activeProps?.onLoadStart?.(event);
            if (active.expectation === 'callbacks') {
              callbackObservations.current.loadStart = true;
              settleCallbacksIfComplete();
            }
          }}
          onLoadProgress={(event) => {
            activeProps?.onLoadProgress?.(event);
            if (active.expectation === 'callbacks') {
              callbackObservations.current.loadProgress = true;
              settleCallbacksIfComplete();
            }
          }}
          onNavigationStateChange={(navigation) => {
            activeProps?.onNavigationStateChange?.(navigation);
            if (active.expectation === 'callbacks') {
              callbackObservations.current.navigationStateChange = true;
              settleCallbacksIfComplete();
            }
          }}
          onContentSizeChange={(event) => {
            activeProps?.onContentSizeChange?.(event);
            if (
              active.expectation === 'callbacks' &&
              Number((event.nativeEvent as unknown as { height?: number }).height) > 0
            ) {
              callbackObservations.current.contentSizeChange = true;
              settleCallbacksIfComplete();
            }
          }}
          onLoadEnd={(event) => {
            activeProps?.onLoadEnd?.(event);
            if ((active.expectation ?? 'load') === 'load') {
              void settle();
              return;
            }
            if (active.expectation === 'callbacks') {
              callbackObservations.current.loadEnd = true;
              settleCallbacksIfComplete();
              return;
            }
            if (active.expectation === 'javascript-disabled') {
              setTimeout(() => {
                const diagnostic = pending.current?.diagnostic;
                if (diagnostic === 'javascript-ran') {
                  pending.current?.reject(
                    new Error('javaScriptEnabled={false} still executed page JavaScript')
                  );
                } else {
                  void settle();
                }
              }, 250);
              return;
            }
            if (active.expectation === 'direct-html-csp') {
              setTimeout(() => {
                if (pending.current?.diagnostic === 'csp-inline-ran') {
                  pending.current.reject(
                    new Error('Direct HTML Content-Security-Policy was bypassed')
                  );
                } else {
                  void settle();
                }
              }, 250);
              return;
            }
            if (active.expectation === 'methods') {
              if (methodPhase.current === 0) {
                methodPhase.current = 1;
                const handle = webViewRef.current;
                const historyState = handle?.getHistoryState();
                if (!historyState?.url.endsWith('/compatibility/methods/')) {
                  pending.current?.reject(
                    new Error(`getHistoryState() returned ${historyState?.url ?? 'no state'}`)
                  );
                  return;
                }
                void handle
                  ?.rollback()
                  .then((rolledBack) => {
                    if (rolledBack) {
                      pending.current?.reject(
                        new Error('rollback() unexpectedly accepted an embedded HTML source')
                      );
                      return;
                    }
                    handle.clearCache(false);
                    handle.clearFormData();
                    handle.clearHistory();
                    handle.requestFocus();
                    handle.stopLoading();
                    handle.injectJavaScript(`
                      history.pushState({step:1}, '', '/compatibility/methods/one');
                      history.pushState({step:2}, '', '/compatibility/methods/two');
                      window.ReactNativeWebView.postMessage('injected');
                      true;
                    `);
                  })
                  .catch((reason: unknown) => {
                    pending.current?.reject(
                      reason instanceof Error ? reason : new Error(String(reason))
                    );
                  });
              } else if (methodPhase.current === 3) {
                methodPhase.current = 4;
                void settle();
              }
            }
          }}
          onMessage={({ nativeEvent }) => {
            activeProps?.onMessage?.({ nativeEvent } as never);
            if (pending.current) pending.current.diagnostic = nativeEvent.data;
            if (active.expectation === 'message') {
              const result = JSON.parse(nativeEvent.data) as {
                before?: boolean;
                channel?: string;
                history?: boolean;
                object?: boolean;
                origin?: string;
              };
              if (
                result.channel === 'compatibility' &&
                result.before &&
                result.history &&
                result.object &&
                result.origin === configuration.origin
              ) {
                void settle();
              }
              return;
            }
            if (active.expectation === 'javascript-disabled') {
              pending.current?.reject(
                new Error(`JavaScript unexpectedly posted: ${nativeEvent.data}`)
              );
              return;
            }
            if (active.expectation === 'direct-html-csp') {
              pending.current?.reject(
                new Error(`CSP-blocked inline script unexpectedly posted: ${nativeEvent.data}`)
              );
              return;
            }
            if (active.expectation === 'frame-injection') {
              const result = JSON.parse(nativeEvent.data) as {
                atEnd?: boolean;
                before?: boolean;
                channel?: string;
                frame?: boolean;
              };
              if (
                result.channel === 'frame-injection' &&
                result.atEnd &&
                result.before &&
                result.frame === (configuration.platform === 'ios')
              ) {
                void settle();
              }
              return;
            }
            if (
              active.expectation === 'origin-whitelist' &&
              nativeEvent.data.startsWith('origin-after-block:')
            ) {
              const url = nativeEvent.data.slice('origin-after-block:'.length);
              if (url === `${configuration.origin}/compatibility/origin-whitelist/`) {
                void settle();
              } else {
                pending.current?.reject(new Error(`originWhitelist allowed navigation to ${url}`));
              }
              return;
            }
            if (active.expectation === 'basic-auth' && nativeEvent.data === 'basic-auth-ok') {
              void settle();
              return;
            }
            if (
              active.expectation === 'user-agent' &&
              nativeEvent.data === 'user-agent:LocalWebView-E2E/13.16.0'
            ) {
              void settle();
              return;
            }
            if (active.expectation === 'dom-storage' && nativeEvent.data === 'dom-storage:ok') {
              void settle();
              return;
            }
            if (
              active.expectation === 'method-routing' &&
              nativeEvent.data === 'method-routing:fetch-ok,xhr-ok,range-ok'
            ) {
              void settle();
              return;
            }
            if (
              active.expectation === 'should-start' &&
              nativeEvent.data.startsWith('navigation-after-deny:')
            ) {
              const url = nativeEvent.data.slice('navigation-after-deny:'.length);
              if (url === `${configuration.origin}/compatibility/navigation/`) {
                void settle();
              } else {
                pending.current?.reject(new Error(`Denied navigation reached ${url}`));
              }
              return;
            }
            if (active.expectation !== 'methods') return;
            if (methodPhase.current === 1 && nativeEvent.data === 'injected') {
              methodPhase.current = 2;
              webViewRef.current?.goBack();
              webViewRef.current?.goForward();
              webViewRef.current?.postMessage('roundtrip');
            } else if (methodPhase.current === 2 && nativeEvent.data === 'native:roundtrip') {
              methodPhase.current = 3;
              webViewRef.current?.reload();
            }
          }}
          onOpenWindow={({ nativeEvent }) => {
            activeProps?.onOpenWindow?.({ nativeEvent } as never);
            if (
              active.expectation === 'open-window' &&
              nativeEvent.targetUrl.endsWith('/compatibility/popup')
            ) {
              void settle();
            }
          }}
          onScroll={({ nativeEvent }) => {
            activeProps?.onScroll?.({ nativeEvent } as never);
            if (active.expectation === 'scroll' && nativeEvent.contentOffset.y > 0) {
              void settle();
            }
          }}
          onFileDownload={(event) => {
            activeProps?.onFileDownload?.(event);
            if (
              active.expectation === 'file-download' &&
              event.nativeEvent.downloadUrl.endsWith('/compatibility/download')
            ) {
              void settle();
            }
          }}
          onLoadSubResourceError={(event) => {
            activeProps?.onLoadSubResourceError?.(event);
            if (
              active.expectation === 'subresource-error' &&
              event.nativeEvent.url.endsWith('/compatibility/missing-image.png')
            ) {
              void settle();
            }
          }}
          onShouldStartLoadWithRequest={(request) => {
            const propDecision = activeProps?.onShouldStartLoadWithRequest?.(request);
            if (propDecision === false) return false;
            if (
              active.expectation === 'should-start' &&
              request.url.endsWith('/compatibility/blocked')
            ) {
              setTimeout(() => {
                webViewRef.current?.injectJavaScript(`
                  window.ReactNativeWebView.postMessage(
                    'navigation-after-deny:' + location.href
                  );
                  true;
                `);
              }, 350);
              return false;
            }
            return true;
          }}
          {...(active.source ? { source: active.source } : { virtualUrl: active.virtualUrl })}
          style={styles.webView}
        />
      ) : (
        <View style={styles.placeholder} />
      )}
      <View style={styles.status}>
        <Text style={styles.statusText}>
          {Platform.OS} · {status}
        </Text>
        {failure ? <Text style={styles.failure}>{failure}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  failure: { color: '#ffb4ab', fontSize: 11, marginTop: 6 },
  placeholder: { flex: 1 },
  status: {
    backgroundColor: '#211a16',
    bottom: 20,
    left: 20,
    padding: 12,
    position: 'absolute',
    right: 20,
  },
  statusText: { color: '#fff', fontSize: 12 },
  webView: { flex: 1 },
});
