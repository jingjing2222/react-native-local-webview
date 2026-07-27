import vm from 'node:vm';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocalWebViewCacheAdapter } from '../src/localWebViewCacheAdapter';
import type { MirroredWebBundle, ResolveWebBundleOptions } from '../src/mirrorWebBundle';

const runtime = vi.hoisted(() => ({
  postMessage: vi.fn<(message: string) => void>(),
  readMirroredWebBundle: vi.fn<(source: string) => Promise<string>>(),
  resolveWebBundle: vi.fn<(options: ResolveWebBundleOptions) => Promise<MirroredWebBundle>>(),
  rollbackWebBundle:
    vi.fn<
      (
        cacheDirectory: string,
        cacheAdapter: LocalWebViewCacheAdapter,
        currentGenerationId?: string,
        requestedUrl?: string
      ) => Promise<MirroredWebBundle | undefined>
    >(),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View',
}));

vi.mock('react-native-webview', async () => {
  const ReactModule = await import('react');
  return {
    WebView: ReactModule.forwardRef(
      (props: Record<string, unknown>, ref: React.ForwardedRef<unknown>) => {
        ReactModule.useImperativeHandle(ref, () => ({
          goBack: vi.fn<() => void>(),
          goForward: vi.fn<() => void>(),
          injectJavaScript: vi.fn<() => void>(),
          postMessage: runtime.postMessage,
          reload: vi.fn<() => void>(),
          stopLoading: vi.fn<() => void>(),
        }));
        return ReactModule.createElement('WebView', props);
      }
    ),
  };
});

vi.mock('../src/mirrorWebBundle', () => ({
  cacheDirectoryForOrigin: () => '/cache/origin',
  readMirroredWebBundle: runtime.readMirroredWebBundle,
  retainWebBundle: () => () => undefined,
  resolveWebBundle: runtime.resolveWebBundle,
  rollbackWebBundle: runtime.rollbackWebBundle,
}));

import {
  LocalWebView as NativeLocalWebView,
  type LocalWebViewHandle,
  type LocalWebViewProps,
} from '../src/LocalWebView.native';

const adapterExists = vi.fn<LocalWebViewCacheAdapter['exists']>();
const adapterReadFile = vi.fn<LocalWebViewCacheAdapter['readFile']>();
const adapterReadFileRange = vi.fn<LocalWebViewCacheAdapter['readFileRange']>();
const adapterRemove = vi.fn<LocalWebViewCacheAdapter['remove']>();
const cacheAdapter: LocalWebViewCacheAdapter = {
  directories: { documents: '/documents' },
  copyFile: vi.fn<LocalWebViewCacheAdapter['copyFile']>(),
  download: vi.fn<LocalWebViewCacheAdapter['download']>(),
  exists: adapterExists,
  hashFile: vi.fn<LocalWebViewCacheAdapter['hashFile']>(),
  listDirectory: vi.fn<LocalWebViewCacheAdapter['listDirectory']>(),
  makeDirectory: vi.fn<LocalWebViewCacheAdapter['makeDirectory']>(),
  moveFile: vi.fn<LocalWebViewCacheAdapter['moveFile']>(),
  readFile: adapterReadFile,
  readFileRange: adapterReadFileRange,
  remove: adapterRemove,
  stat: vi.fn<LocalWebViewCacheAdapter['stat']>(),
  writeFile: vi.fn<LocalWebViewCacheAdapter['writeFile']>(),
};

function LocalWebView(props: Omit<LocalWebViewProps, 'cacheAdapter'>) {
  return <NativeLocalWebView {...props} cacheAdapter={cacheAdapter} />;
}

function bundle(name: string): MirroredWebBundle {
  return {
    baseUrl: `https://${name}.example/`,
    downloadedAssets: [`https://${name}.example/`],
    generationId: name,
    localAssets: {},
    rollbackAvailable: false,
    sourcePath: `/${name}/index.html`,
    totalBytes: 100,
    usedCachedBundle: false,
  };
}

function streamBundle(name: string, assetCount: number): MirroredWebBundle {
  const mirrored = bundle(name);
  for (let index = 0; index < assetCount; index += 1) {
    const url = `https://${name}.example/asset-${index}.data`;
    mirrored.localAssets[url] = {
      integrity: {
        sha256: 'sha256-digest',
        sha384: 'sha384-digest',
        sha512: 'sha512-digest',
      },
      mediaType: 'application/octet-stream',
      path: `/documents/asset-${index}.data`,
      redirected: false,
      responseUrl: url,
      sha256: index.toString(16).padStart(64, '0'),
      size: 4,
      url,
    };
  }
  return mirrored;
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next, fail) => {
    reject = fail;
    resolve = next;
  });
  return { promise, reject, resolve };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

type RenderedWebView = TestRenderer.ReactTestInstance;

function webView(renderer: TestRenderer.ReactTestRenderer): RenderedWebView {
  return renderer.root.find((node) => (node.type as unknown) === 'WebView');
}

function assetCapability(renderedWebView: RenderedWebView): string {
  const html = (renderedWebView.props.source as { html: string }).html;
  const match = /const capability = ("[^"]+");/.exec(html);
  if (!match?.[1]) throw new Error('Asset capability was not injected');
  return JSON.parse(match[1]) as string;
}

function assetCapabilityBootstrap(renderedWebView: RenderedWebView): string {
  const html = (renderedWebView.props.source as { html: string }).html;
  const match = /<script data-react-native-local-webview-capability="">([\s\S]*?)<\/script>/.exec(
    html
  );
  if (!match?.[1]) throw new Error('Asset capability bootstrap was not injected');
  return match[1];
}

function sendAssetMessage(
  renderedWebView: RenderedWebView,
  message: Record<string, unknown>,
  options: { capability?: string; documentId?: string; url?: string } = {}
): void {
  const source = renderedWebView.props.source as { baseUrl: string };
  const onMessage = renderedWebView.props.onMessage as (event: {
    nativeEvent: { data: string; url: string };
  }) => void;
  onMessage({
    nativeEvent: {
      data: JSON.stringify({
        capability: options.capability ?? assetCapability(renderedWebView),
        channel: 'react-native-local-webview:asset',
        direction: 'web',
        documentId: options.documentId ?? 'test-document-id',
        ...message,
      }),
      url: options.url ?? source.baseUrl,
    },
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  runtime.readMirroredWebBundle.mockReset();
  runtime.resolveWebBundle.mockReset();
  runtime.rollbackWebBundle.mockReset();
  runtime.postMessage.mockReset();
  adapterExists.mockReset();
  adapterReadFile.mockReset();
  adapterReadFileRange.mockReset();
  adapterRemove.mockReset();
});

describe('LocalWebView loading lifecycle', () => {
  it('does not reload for equivalent inline policies and calls the latest callback', async () => {
    const pending = deferred<MirroredWebBundle>();
    const firstReady = vi.fn<(bundle: MirroredWebBundle) => void>();
    const latestReady = vi.fn<(bundle: MirroredWebBundle) => void>();
    runtime.resolveWebBundle.mockReturnValue(pending.promise);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>stable</body></html>'
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LocalWebView
          cachePolicy={{ maxBytes: 1024, maxGenerations: 2, maxInlineBytes: 512 }}
          onBundleReady={firstReady}
          trustedAssetOrigins={['https://cdn.example']}
          virtualUrl="https://app.example/"
        />
      );
    });
    await act(async () => {
      renderer.update(
        <LocalWebView
          cachePolicy={{ maxBytes: 1024, maxGenerations: 2, maxInlineBytes: 512 }}
          onBundleReady={latestReady}
          trustedAssetOrigins={['https://cdn.example']}
          virtualUrl="https://app.example/"
        />
      );
    });
    pending.resolve(bundle('stable'));
    await flush();

    expect(runtime.resolveWebBundle).toHaveBeenCalledTimes(1);
    expect(firstReady).not.toHaveBeenCalled();
    expect(latestReady).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  it('reloads when maxInlineBytes changes', async () => {
    runtime.resolveWebBundle.mockResolvedValue(bundle('inline-limit'));
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>inline</body></html>'
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LocalWebView
          cachePolicy={{ maxInlineBytes: 1024 }}
          virtualUrl="https://inline-limit.example/"
        />
      );
    });
    await flush();
    await act(async () => {
      renderer.update(
        <LocalWebView
          cachePolicy={{ maxInlineBytes: 2048 }}
          virtualUrl="https://inline-limit.example/"
        />
      );
    });
    await flush();

    expect(runtime.resolveWebBundle).toHaveBeenCalledTimes(2);
    expect(runtime.resolveWebBundle.mock.calls.at(-1)?.[0].cachePolicy).toMatchObject({
      maxInlineBytes: 2048,
    });
    await act(async () => {
      renderer.unmount();
    });
  });

  it('uses the resolved hash-route document URL as the WebView base URL', async () => {
    runtime.resolveWebBundle.mockResolvedValue({
      ...bundle('route'),
      baseUrl: 'https://route.example/releases/index.html#/books/42',
    });
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>route</body></html>'
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LocalWebView virtualUrl="https://route.example/#/books/42" />
      );
    });
    await flush();

    expect((webView(renderer).props.source as { baseUrl: string }).baseUrl).toBe(
      'https://route.example/releases/index.html#/books/42'
    );
    await act(async () => {
      renderer.unmount();
    });
  });

  it('cannot commit an older source after a newer source is ready', async () => {
    const staleRead = deferred<string>();
    const signals: AbortSignal[] = [];
    runtime.resolveWebBundle.mockImplementation(
      async ({ signal, virtualUrl }: ResolveWebBundleOptions) => {
        if (signal) signals.push(signal);
        return virtualUrl.includes('first') ? bundle('first') : bundle('second');
      }
    );
    runtime.readMirroredWebBundle.mockImplementation((path: string) =>
      path.includes('first')
        ? staleRead.promise
        : Promise.resolve('<!doctype html><html><head></head><body>SECOND_BUNDLE</body></html>')
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<LocalWebView virtualUrl="https://first.example/" />);
    });
    await flush();
    await act(async () => {
      renderer.update(<LocalWebView virtualUrl="https://second.example/" />);
    });
    await flush();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    const renderedWebView = renderer.root.find((node) => (node.type as unknown) === 'WebView');
    expect((renderedWebView.props.source as { html: string }).html).toContain('SECOND_BUNDLE');

    staleRead.resolve('<!doctype html><html><head></head><body>STALE_FIRST_BUNDLE</body></html>');
    await flush();
    const finalHtml = (
      renderer.root.find((node) => (node.type as unknown) === 'WebView').props.source as {
        html: string;
      }
    ).html;
    expect(finalHtml).toContain('SECOND_BUNDLE');
    expect(finalHtml).not.toContain('STALE_FIRST_BUNDLE');
    await act(async () => {
      renderer.unmount();
    });
    expect(signals[1]?.aborted).toBe(true);
  });

  it('runs the user document-start script after the early local runtime on every document', async () => {
    runtime.resolveWebBundle.mockResolvedValue(streamBundle('ordered', 1));
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head><script data-page-script>window.pageRan = true</script></head><body></body></html>'
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LocalWebView
          injectedJavaScriptBeforeContentLoaded={'window.userRan = "</script>";'}
          virtualUrl="https://ordered.example/"
        />
      );
    });
    await flush();

    const html = (webView(renderer).props.source as { html: string }).html;
    const capabilityIndex = html.indexOf('data-react-native-local-webview-capability');
    const historyIndex = html.indexOf('data-react-native-local-webview-history');
    const assetIndex = html.indexOf('data-react-native-local-webview-assets');
    const pageIndex = html.indexOf('data-page-script');
    expect(capabilityIndex).toBeGreaterThanOrEqual(0);
    expect(historyIndex).toBeGreaterThan(capabilityIndex);
    expect(assetIndex).toBeGreaterThan(historyIndex);
    expect(pageIndex).toBeGreaterThan(assetIndex);
    expect(html).not.toContain('window.userRan');

    const documentStart = webView(renderer).props.injectedJavaScriptBeforeContentLoaded as string;
    const earlyCapabilityIndex = documentStart.indexOf('__REACT_NATIVE_LOCAL_WEBVIEW_CAPABILITY__');
    const earlyHistoryIndex = documentStart.indexOf('__REACT_NATIVE_LOCAL_WEBVIEW_HISTORY__');
    const earlyAssetIndex = documentStart.indexOf('__REACT_NATIVE_LOCAL_WEBVIEW_ASSETS__');
    const userIndex = documentStart.indexOf('window.userRan = "</script>";');
    expect(earlyCapabilityIndex).toBeGreaterThanOrEqual(0);
    expect(earlyHistoryIndex).toBeGreaterThan(earlyCapabilityIndex);
    expect(earlyAssetIndex).toBeGreaterThan(earlyHistoryIndex);
    expect(userIndex).toBeGreaterThan(earlyAssetIndex);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('issues a new document id before a persisted BFCache document reports pageshow', async () => {
    runtime.resolveWebBundle.mockResolvedValue(bundle('bfcache'));
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>BFCache</body></html>'
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<LocalWebView virtualUrl="https://bfcache.example/" />);
    });
    await flush();

    type BootstrapEvent = {
      data?: string;
      persisted?: boolean;
      stopImmediatePropagation?: () => void;
      stopPropagation?: () => void;
    };
    type BootstrapListener = (event: BootstrapEvent) => void;
    const listeners = new Map<string, BootstrapListener[]>();
    const addListener = (name: string, listener: BootstrapListener): void => {
      const current = listeners.get(name) ?? [];
      current.push(listener);
      listeners.set(name, current);
    };
    const outbound: string[] = [];
    let randomGeneration = 0;
    const nativeBridge = {
      postMessage: (message: string): void => {
        outbound.push(message);
      },
    };
    const scope: {
      ReactNativeWebView: typeof nativeBridge;
      addEventListener: (name: string, listener: BootstrapListener) => void;
      crypto: { getRandomValues: (words: Uint32Array) => Uint32Array };
      document: { addEventListener: (name: string, listener: BootstrapListener) => void };
      location: { origin: string };
      top?: unknown;
    } = {
      ReactNativeWebView: nativeBridge,
      addEventListener: addListener,
      crypto: {
        getRandomValues(words) {
          words.fill(++randomGeneration);
          return words;
        },
      },
      document: { addEventListener: addListener },
      location: { origin: 'https://bfcache.example' },
    };
    scope.top = scope;
    vm.runInNewContext(assetCapabilityBootstrap(webView(renderer)), scope);

    const postHistory = (): { documentId?: string } => {
      scope.ReactNativeWebView.postMessage(
        JSON.stringify({
          channel: 'react-native-local-webview:history',
          navigationType: 'pageshow',
        })
      );
      return JSON.parse(outbound.at(-1)!) as { documentId?: string };
    };
    const initial = postHistory();
    for (const listener of listeners.get('pageshow') ?? []) {
      listener({ persisted: false });
    }
    expect(postHistory().documentId).toBe(initial.documentId);

    for (const listener of listeners.get('pageshow') ?? []) {
      listener({ persisted: true });
    }
    expect(postHistory().documentId).not.toBe(initial.documentId);
    expect(randomGeneration).toBe(2);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not let a stale rollback replace a newer source', async () => {
    const pendingRollback = deferred<MirroredWebBundle | undefined>();
    const first = bundle('first');
    const older = bundle('older');
    const second = bundle('second');
    runtime.resolveWebBundle.mockImplementation(async ({ virtualUrl }) =>
      virtualUrl.includes('first') ? first : second
    );
    runtime.rollbackWebBundle.mockReturnValue(pendingRollback.promise);
    runtime.readMirroredWebBundle.mockImplementation(async (source) =>
      source.includes('second')
        ? '<!doctype html><html><head></head><body>SECOND</body></html>'
        : '<!doctype html><html><head></head><body>FIRST</body></html>'
    );
    const ref = React.createRef<LocalWebViewHandle>();

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <NativeLocalWebView
          cacheAdapter={cacheAdapter}
          ref={ref}
          virtualUrl="https://first.example/#/books/42"
        />
      );
    });
    await flush();

    let rollbackResult!: Promise<boolean>;
    await act(async () => {
      rollbackResult = ref.current!.rollback();
      await Promise.resolve();
    });
    expect(runtime.rollbackWebBundle).toHaveBeenCalledWith(
      '/cache/origin',
      cacheAdapter,
      'first',
      'https://first.example/#/books/42'
    );

    await act(async () => {
      renderer.update(
        <NativeLocalWebView
          cacheAdapter={cacheAdapter}
          ref={ref}
          virtualUrl="https://second.example/"
        />
      );
    });
    await flush();
    pendingRollback.resolve(older);
    await expect(rollbackResult).resolves.toBe(false);
    await flush();

    const html = (webView(renderer).props.source as { html: string }).html;
    expect(html).toContain('SECOND');
    expect(html).not.toContain('FIRST');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('ignores a stale automatic rollback rejection after a newer source loads', async () => {
    const pendingRollback = deferred<MirroredWebBundle | undefined>();
    const first = { ...bundle('first'), rollbackAvailable: true };
    const second = bundle('second');
    const onBundleError = vi.fn<(error: Error) => void>();
    runtime.resolveWebBundle.mockImplementation(async ({ virtualUrl }) =>
      virtualUrl.includes('first') ? first : second
    );
    runtime.rollbackWebBundle.mockReturnValue(pendingRollback.promise);
    runtime.readMirroredWebBundle.mockImplementation(async (source) =>
      source.includes('second')
        ? '<!doctype html><html><head></head><body>SECOND</body></html>'
        : '<!doctype html><html><head></head><body>FIRST</body></html>'
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LocalWebView
          onBundleError={onBundleError}
          virtualUrl="https://first.example/#/automatic"
        />
      );
    });
    await flush();
    await act(async () => {
      const renderedWebView = webView(renderer);
      const onLoadStart = renderedWebView.props.onLoadStart as (event: {
        nativeEvent: { url: string };
      }) => void;
      const onError = renderedWebView.props.onError as (event: {
        nativeEvent: { url: string };
      }) => void;
      onLoadStart({ nativeEvent: { url: 'https://first.example/#/automatic' } });
      onError({ nativeEvent: { url: 'https://first.example/#/automatic' } });
      await Promise.resolve();
    });
    expect(runtime.rollbackWebBundle).toHaveBeenCalledWith(
      '/cache/origin',
      cacheAdapter,
      'first',
      'https://first.example/#/automatic'
    );

    await act(async () => {
      renderer.update(
        <LocalWebView onBundleError={onBundleError} virtualUrl="https://second.example/" />
      );
    });
    await flush();
    pendingRollback.reject(new Error('stale rollback failed'));
    await flush();

    expect(onBundleError).not.toHaveBeenCalled();
    expect((webView(renderer).props.source as { html: string }).html).toContain('SECOND');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('does not roll back a local generation for a failed cross-origin navigation', async () => {
    runtime.resolveWebBundle.mockResolvedValue({
      ...bundle('first'),
      rollbackAvailable: true,
    });
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>FIRST</body></html>'
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<LocalWebView virtualUrl="https://first.example/" />);
    });
    await flush();
    const renderedWebView = webView(renderer);
    const onLoadStart = renderedWebView.props.onLoadStart as (event: {
      nativeEvent: { url: string };
    }) => void;
    const navigate = renderedWebView.props.onNavigationStateChange as (navigation: {
      canGoBack: boolean;
      canGoForward: boolean;
      url: string;
    }) => void;
    const onError = renderedWebView.props.onError as (event: {
      nativeEvent: { url: string };
    }) => void;

    await act(async () => {
      onLoadStart({ nativeEvent: { url: 'https://first.example/' } });
      navigate({
        canGoBack: true,
        canGoForward: false,
        url: 'https://unavailable.example/',
      });
      // WKWebView reports its current URL for provisional failures, which can
      // still be the prior document rather than the failed destination.
      onError({ nativeEvent: { url: 'https://first.example/' } });
      await Promise.resolve();
    });

    expect(runtime.rollbackWebBundle).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });

  it('requires the active document capability and origin for asset requests', async () => {
    const mirrored = streamBundle('trusted', 1);
    const localRead = deferred<string>();
    const onMessage = vi.fn<NonNullable<LocalWebViewProps['onMessage']>>();
    runtime.resolveWebBundle.mockResolvedValue(mirrored);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>trusted</body></html>'
    );
    adapterReadFileRange.mockReturnValue(localRead.promise);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LocalWebView onMessage={onMessage} virtualUrl="https://trusted.example/" />
      );
    });
    await flush();
    const renderedWebView = webView(renderer);
    const html = (renderedWebView.props.source as { html: string }).html;
    expect(html).toContain('const expectedOrigin = "https://trusted.example";');
    expect(html).toContain('globalThis.location.origin !== expectedOrigin');
    expect(renderedWebView.props.injectedJavaScriptBeforeContentLoaded).toContain(
      'globalThis.location.origin === "https://trusted.example"'
    );
    const request = {
      kind: 'request',
      requestId: 'trusted-request',
      url: 'https://trusted.example/asset-0.data',
    };

    sendAssetMessage(renderedWebView, request, { capability: 'wrong-capability' });
    sendAssetMessage(renderedWebView, request, { url: 'https://evil.example/frame.html' });
    expect(adapterReadFileRange).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(2);

    await act(async () => {
      sendAssetMessage(renderedWebView, request);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(adapterReadFileRange).toHaveBeenCalledWith('/documents/asset-0.data', 0, 4, 'base64');

    await act(async () => {
      renderer.unmount();
      localRead.resolve('AAECAw==');
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('does not post a chunk when its local read is cancelled in flight', async () => {
    const assetUrl = 'https://stream.example/game.data';
    const localRead = deferred<string>();
    const mirrored = bundle('stream');
    mirrored.localAssets[assetUrl] = {
      integrity: {
        sha256: 'sha256-digest',
        sha384: 'sha384-digest',
        sha512: 'sha512-digest',
      },
      mediaType: 'application/octet-stream',
      path: '/documents/game.data',
      redirected: false,
      responseUrl: assetUrl,
      sha256: '00'.repeat(32),
      size: 4,
      url: assetUrl,
    };
    runtime.resolveWebBundle.mockResolvedValue(mirrored);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>stream</body></html>'
    );
    adapterReadFileRange.mockReturnValue(localRead.promise);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<LocalWebView virtualUrl="https://stream.example/" />);
    });
    await flush();
    const renderedWebView = webView(renderer);
    const requestId = 'cancelled-read';

    await act(async () => {
      sendAssetMessage(renderedWebView, {
        kind: 'request',
        requestId,
        url: assetUrl,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(adapterReadFileRange).toHaveBeenCalledOnce();

    await act(async () => {
      sendAssetMessage(renderedWebView, {
        kind: 'cancel',
        requestId,
      });
      localRead.resolve('AAECAw==');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runtime.postMessage).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });

  it('cancels an old stream on same-origin document loads, forwards onLoadStart, and streams after back', async () => {
    const mirrored = streamBundle('same-origin', 1);
    const firstRead = deferred<string>();
    const onLoadStart = vi.fn<NonNullable<LocalWebViewProps['onLoadStart']>>();
    runtime.resolveWebBundle.mockResolvedValue(mirrored);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>same origin</body></html>'
    );
    adapterReadFileRange.mockReturnValueOnce(firstRead.promise).mockResolvedValueOnce('AAECAw==');

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LocalWebView onLoadStart={onLoadStart} virtualUrl="https://same-origin.example/" />
      );
    });
    await flush();
    const renderedWebView = webView(renderer);
    const request = {
      kind: 'request',
      requestId: 'same-origin-request',
      url: 'https://same-origin.example/asset-0.data',
    };
    const loadStart = renderedWebView.props.onLoadStart as NonNullable<
      LocalWebViewProps['onLoadStart']
    >;
    const navigationEvent = (url: string) =>
      ({
        nativeEvent: {
          canGoBack: true,
          canGoForward: false,
          loading: true,
          target: 1,
          title: '',
          url,
        },
      }) as unknown as Parameters<typeof loadStart>[0];

    await act(async () => {
      loadStart(navigationEvent('https://same-origin.example/'));
      onLoadStart.mockClear();
      sendAssetMessage(renderedWebView, request);
      await Promise.resolve();
      await Promise.resolve();
      loadStart(navigationEvent('https://same-origin.example/chapter'));
      firstRead.resolve('AAECAw==');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onLoadStart).toHaveBeenCalledOnce();
    expect(onLoadStart).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeEvent: expect.objectContaining({
          url: 'https://same-origin.example/chapter',
        }),
      })
    );
    expect(runtime.postMessage).not.toHaveBeenCalled();

    await act(async () => {
      loadStart(navigationEvent('https://same-origin.example/'));
      sendAssetMessage(renderedWebView, request, {
        documentId: 'returned-document-id-0001',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapterReadFileRange).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(runtime.postMessage.mock.calls[0]![0]) as {
        capability?: string;
        kind?: string;
      }
    ).toMatchObject({
      capability: assetCapability(renderedWebView),
      kind: 'chunk',
    });

    await act(async () => {
      sendAssetMessage(renderedWebView, {
        kind: 'ack',
        requestId: 'same-origin-request',
        documentId: 'returned-document-id-0001',
      });
      await Promise.resolve();
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('keeps an initial document stream when its onLoadStart signal is delayed', async () => {
    const mirrored = streamBundle('initial-load-start', 1);
    const localRead = deferred<string>();
    runtime.resolveWebBundle.mockResolvedValue(mirrored);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>initial load start</body></html>'
    );
    adapterReadFileRange.mockReturnValue(localRead.promise);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LocalWebView virtualUrl="https://initial-load-start.example/" />
      );
    });
    await flush();
    const renderedWebView = webView(renderer);
    const loadStart = renderedWebView.props.onLoadStart as NonNullable<
      LocalWebViewProps['onLoadStart']
    >;

    await act(async () => {
      sendAssetMessage(renderedWebView, {
        kind: 'request',
        requestId: 'initial-document-request',
        url: 'https://initial-load-start.example/asset-0.data',
      });
      await Promise.resolve();
      await Promise.resolve();
      loadStart({
        nativeEvent: {
          canGoBack: false,
          canGoForward: false,
          loading: true,
          target: 1,
          title: '',
          url: 'https://initial-load-start.example/',
        },
      } as unknown as Parameters<typeof loadStart>[0]);
      localRead.resolve('AAECAw==');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      runtime.postMessage.mock.calls
        .map(([message]) => JSON.parse(message) as { kind?: string; requestId?: string })
        .some(
          (message) => message.kind === 'chunk' && message.requestId === 'initial-document-request'
        )
    ).toBe(true);

    await act(async () => {
      sendAssetMessage(renderedWebView, {
        kind: 'ack',
        requestId: 'initial-document-request',
      });
      await Promise.resolve();
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('does not cancel a new document stream when onLoadStart arrives after document-start JavaScript', async () => {
    const mirrored = streamBundle('delayed-load-start', 1);
    const oldRead = deferred<string>();
    const newRead = deferred<string>();
    runtime.resolveWebBundle.mockResolvedValue(mirrored);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>delayed load start</body></html>'
    );
    adapterReadFileRange.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LocalWebView virtualUrl="https://delayed-load-start.example/" />
      );
    });
    await flush();
    const renderedWebView = webView(renderer);
    const loadStart = renderedWebView.props.onLoadStart as NonNullable<
      LocalWebViewProps['onLoadStart']
    >;
    const navigationEvent = {
      nativeEvent: {
        canGoBack: true,
        canGoForward: false,
        loading: true,
        target: 1,
        title: '',
        url: 'https://delayed-load-start.example/next',
      },
    } as unknown as Parameters<typeof loadStart>[0];

    await act(async () => {
      sendAssetMessage(renderedWebView, {
        kind: 'request',
        requestId: 'old-document-request',
        url: 'https://delayed-load-start.example/asset-0.data',
      });
      await Promise.resolve();
      await Promise.resolve();
      sendAssetMessage(
        renderedWebView,
        {
          kind: 'request',
          requestId: 'new-document-request',
          url: 'https://delayed-load-start.example/asset-0.data',
        },
        { documentId: 'new-document-id-0001' }
      );
      await Promise.resolve();
      await Promise.resolve();
      loadStart(navigationEvent);
      oldRead.resolve('AAECAw==');
      newRead.resolve('AAECAw==');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const messages = runtime.postMessage.mock.calls.map(
      ([message]) => JSON.parse(message) as { kind?: string; requestId?: string }
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        kind: 'chunk',
        requestId: 'new-document-request',
      })
    );
    expect(messages).not.toContainEqual(
      expect.objectContaining({
        kind: 'chunk',
        requestId: 'old-document-request',
      })
    );

    await act(async () => {
      sendAssetMessage(
        renderedWebView,
        {
          kind: 'ack',
          requestId: 'new-document-request',
        },
        { documentId: 'new-document-id-0001' }
      );
      await Promise.resolve();
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('rejects a retired document message when onLoadStart arrives before the next document', async () => {
    const mirrored = streamBundle('load-start-first', 3);
    const oldRead = deferred<string>();
    const nextRead = deferred<string>();
    runtime.resolveWebBundle.mockResolvedValue(mirrored);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>load start first</body></html>'
    );
    adapterReadFileRange.mockImplementation((path) => {
      if (path.endsWith('asset-0.data')) return oldRead.promise;
      if (path.endsWith('asset-2.data')) return nextRead.promise;
      return Promise.resolve('AAECAw==');
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LocalWebView virtualUrl="https://load-start-first.example/" />
      );
    });
    await flush();
    const renderedWebView = webView(renderer);
    const loadStart = renderedWebView.props.onLoadStart as NonNullable<
      LocalWebViewProps['onLoadStart']
    >;
    const navigationEvent = (url: string) =>
      ({
        nativeEvent: {
          canGoBack: true,
          canGoForward: false,
          loading: true,
          target: 1,
          title: '',
          url,
        },
      }) as unknown as Parameters<typeof loadStart>[0];
    const oldDocumentId = 'old-document-id-0001';
    const nextDocumentId = 'next-document-id-0001';

    await act(async () => {
      loadStart(navigationEvent('https://load-start-first.example/'));
      sendAssetMessage(
        renderedWebView,
        {
          kind: 'request',
          requestId: 'old-request',
          url: 'https://load-start-first.example/asset-0.data',
        },
        { documentId: oldDocumentId }
      );
      await Promise.resolve();
      await Promise.resolve();

      loadStart(navigationEvent('https://load-start-first.example/next'));
      sendAssetMessage(
        renderedWebView,
        {
          kind: 'request',
          requestId: 'late-old-request',
          url: 'https://load-start-first.example/asset-1.data',
        },
        { documentId: oldDocumentId }
      );
      sendAssetMessage(
        renderedWebView,
        {
          kind: 'request',
          requestId: 'next-request',
          url: 'https://load-start-first.example/asset-2.data',
        },
        { documentId: nextDocumentId }
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapterReadFileRange.mock.calls.some(([path]) => path.endsWith('asset-1.data'))).toBe(
      false
    );
    expect(adapterReadFileRange).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldRead.resolve('AAECAw==');
      nextRead.resolve('AAECAw==');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const messages = runtime.postMessage.mock.calls.map(
      ([message]) => JSON.parse(message) as { kind?: string; requestId?: string }
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ kind: 'chunk', requestId: 'next-request' })
    );
    expect(messages).not.toContainEqual(
      expect.objectContaining({ kind: 'chunk', requestId: 'old-request' })
    );

    await act(async () => {
      sendAssetMessage(
        renderedWebView,
        { kind: 'ack', requestId: 'next-request' },
        { documentId: nextDocumentId }
      );
      await Promise.resolve();
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('does not let a late retired message replace a document observed before onLoadStart', async () => {
    const mirrored = streamBundle('message-first', 3);
    const oldRead = deferred<string>();
    const nextRead = deferred<string>();
    runtime.resolveWebBundle.mockResolvedValue(mirrored);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>message first</body></html>'
    );
    adapterReadFileRange.mockImplementation((path) => {
      if (path.endsWith('asset-0.data')) return oldRead.promise;
      if (path.endsWith('asset-2.data')) return nextRead.promise;
      return Promise.resolve('AAECAw==');
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<LocalWebView virtualUrl="https://message-first.example/" />);
    });
    await flush();
    const renderedWebView = webView(renderer);
    const loadStart = renderedWebView.props.onLoadStart as NonNullable<
      LocalWebViewProps['onLoadStart']
    >;
    const navigationEvent = (url: string) =>
      ({
        nativeEvent: {
          canGoBack: true,
          canGoForward: false,
          loading: true,
          target: 1,
          title: '',
          url,
        },
      }) as unknown as Parameters<typeof loadStart>[0];
    const oldDocumentId = 'old-document-id-0001';
    const nextDocumentId = 'next-document-id-0001';

    await act(async () => {
      loadStart(navigationEvent('https://message-first.example/'));
      sendAssetMessage(
        renderedWebView,
        {
          kind: 'request',
          requestId: 'old-request',
          url: 'https://message-first.example/asset-0.data',
        },
        { documentId: oldDocumentId }
      );
      await Promise.resolve();
      await Promise.resolve();

      sendAssetMessage(
        renderedWebView,
        {
          kind: 'request',
          requestId: 'next-request',
          url: 'https://message-first.example/asset-2.data',
        },
        { documentId: nextDocumentId }
      );
      sendAssetMessage(
        renderedWebView,
        {
          kind: 'request',
          requestId: 'late-old-request',
          url: 'https://message-first.example/asset-1.data',
        },
        { documentId: oldDocumentId }
      );
      loadStart(navigationEvent('https://message-first.example/next'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapterReadFileRange.mock.calls.some(([path]) => path.endsWith('asset-1.data'))).toBe(
      false
    );
    expect(adapterReadFileRange).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldRead.resolve('AAECAw==');
      nextRead.resolve('AAECAw==');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const messages = runtime.postMessage.mock.calls.map(
      ([message]) => JSON.parse(message) as { kind?: string; requestId?: string }
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ kind: 'chunk', requestId: 'next-request' })
    );
    expect(messages).not.toContainEqual(
      expect.objectContaining({ kind: 'chunk', requestId: 'old-request' })
    );

    await act(async () => {
      sendAssetMessage(
        renderedWebView,
        { kind: 'ack', requestId: 'next-request' },
        { documentId: nextDocumentId }
      );
      await Promise.resolve();
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('keeps an active asset stream across a pushState history message', async () => {
    const mirrored = streamBundle('push-state', 1);
    const localRead = deferred<string>();
    runtime.resolveWebBundle.mockResolvedValue(mirrored);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>push state</body></html>'
    );
    adapterReadFileRange.mockReturnValue(localRead.promise);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<LocalWebView virtualUrl="https://push-state.example/" />);
    });
    await flush();
    const renderedWebView = webView(renderer);
    const requestId = 'push-state-request';

    await act(async () => {
      sendAssetMessage(renderedWebView, {
        kind: 'request',
        requestId,
        url: 'https://push-state.example/asset-0.data',
      });
      await Promise.resolve();
      await Promise.resolve();
      const onWebViewMessage = renderedWebView.props.onMessage as (event: {
        nativeEvent: {
          canGoBack: boolean;
          canGoForward: boolean;
          data: string;
          url: string;
        };
      }) => void;
      onWebViewMessage({
        nativeEvent: {
          canGoBack: true,
          canGoForward: false,
          data: JSON.stringify({
            capability: assetCapability(renderedWebView),
            channel: 'react-native-local-webview:history',
            documentId: 'test-document-id',
            length: 2,
            navigationType: 'pushState',
            state: null,
            url: 'https://push-state.example/chapter',
          }),
          url: 'https://push-state.example/chapter',
        },
      });
      localRead.resolve('AAECAw==');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      runtime.postMessage.mock.calls
        .map(([message]) => JSON.parse(message) as { kind?: string })
        .some((message) => message.kind === 'chunk')
    ).toBe(true);

    await act(async () => {
      sendAssetMessage(renderedWebView, {
        kind: 'ack',
        requestId,
      });
      await Promise.resolve();
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('cancels streams on cross-origin navigation and restores them after going back', async () => {
    const mirrored = streamBundle('returning', 1);
    const firstRead = deferred<string>();
    runtime.resolveWebBundle.mockResolvedValue(mirrored);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>returning</body></html>'
    );
    adapterReadFileRange.mockReturnValueOnce(firstRead.promise).mockResolvedValueOnce('AAECAw==');

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<LocalWebView virtualUrl="https://returning.example/" />);
    });
    await flush();
    const renderedWebView = webView(renderer);
    const request = {
      kind: 'request',
      requestId: 'reused-request',
      url: 'https://returning.example/asset-0.data',
    };

    await act(async () => {
      sendAssetMessage(renderedWebView, request);
      await Promise.resolve();
      await Promise.resolve();
    });
    const navigate = renderedWebView.props.onNavigationStateChange as (navigation: {
      canGoBack: boolean;
      canGoForward: boolean;
      url: string;
    }) => void;
    await act(async () => {
      navigate({
        canGoBack: true,
        canGoForward: false,
        url: 'https://evil.example/',
      });
      firstRead.resolve('AAECAw==');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(runtime.postMessage).not.toHaveBeenCalled();

    await act(async () => {
      navigate({
        canGoBack: false,
        canGoForward: true,
        url: 'https://returning.example/',
      });
      sendAssetMessage(renderedWebView, request);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(adapterReadFileRange).toHaveBeenCalledTimes(2);
    const chunk = JSON.parse(runtime.postMessage.mock.calls[0]![0]) as {
      capability?: string;
      kind?: string;
    };
    expect(chunk).toMatchObject({
      capability: assetCapability(renderedWebView),
      kind: 'chunk',
    });

    await act(async () => {
      sendAssetMessage(renderedWebView, {
        kind: 'ack',
        requestId: 'reused-request',
      });
      await Promise.resolve();
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('rejects a previous document capability after switching bundles', async () => {
    runtime.resolveWebBundle.mockImplementation(async ({ virtualUrl }) =>
      virtualUrl.includes('first') ? streamBundle('first', 1) : streamBundle('second', 1)
    );
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>bundle</body></html>'
    );
    adapterReadFileRange.mockResolvedValue('AAECAw==');
    const onMessage = vi.fn<NonNullable<LocalWebViewProps['onMessage']>>();

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LocalWebView onMessage={onMessage} virtualUrl="https://first.example/" />
      );
    });
    await flush();
    const previousCapability = assetCapability(webView(renderer));

    await act(async () => {
      renderer.update(<LocalWebView onMessage={onMessage} virtualUrl="https://second.example/" />);
    });
    await flush();
    const currentWebView = webView(renderer);
    expect(assetCapability(currentWebView)).not.toBe(previousCapability);

    sendAssetMessage(
      currentWebView,
      {
        kind: 'request',
        requestId: 'stale-document',
        url: 'https://second.example/asset-0.data',
      },
      { capability: previousCapability }
    );
    expect(adapterReadFileRange).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledOnce();
    await act(async () => {
      renderer.unmount();
    });
  });

  it('only consumes history messages from the active capable document', async () => {
    const onHistoryChange = vi.fn<NonNullable<LocalWebViewProps['onHistoryChange']>>();
    const onMessage = vi.fn<NonNullable<LocalWebViewProps['onMessage']>>();
    runtime.resolveWebBundle.mockResolvedValue(bundle('history'));
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>history</body></html>'
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LocalWebView
          onHistoryChange={onHistoryChange}
          onMessage={onMessage}
          virtualUrl="https://history.example/"
        />
      );
    });
    await flush();
    const renderedWebView = webView(renderer);
    const onWebViewMessage = renderedWebView.props.onMessage as (event: {
      nativeEvent: {
        canGoBack: boolean;
        canGoForward: boolean;
        data: string;
        url: string;
      };
    }) => void;
    const send = (capability: string, url: string) =>
      onWebViewMessage({
        nativeEvent: {
          canGoBack: true,
          canGoForward: false,
          data: JSON.stringify({
            capability,
            channel: 'react-native-local-webview:history',
            documentId: 'test-document-id',
            length: 2,
            navigationType: 'pushState',
            state: { route: 1 },
            url: 'https://history.example/route',
          }),
          url,
        },
      });

    send('wrong-capability', 'https://history.example/');
    send(assetCapability(renderedWebView), 'https://evil.example/');
    expect(onHistoryChange).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(2);

    send(assetCapability(renderedWebView), 'https://history.example/');
    expect(onHistoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        canGoBack: true,
        navigationType: 'pushState',
        url: 'https://history.example/route',
      })
    );
    expect(onMessage).toHaveBeenCalledTimes(2);

    const navigate = renderedWebView.props.onNavigationStateChange as (navigation: {
      canGoBack: boolean;
      canGoForward: boolean;
      url: string;
    }) => void;
    navigate({
      canGoBack: true,
      canGoForward: true,
      url: 'https://other.example/',
    });
    expect(onHistoryChange).toHaveBeenLastCalledWith({
      canGoBack: true,
      canGoForward: true,
      length: 1,
      navigationType: 'document',
      state: null,
      stateSerializationFailed: false,
      url: 'https://other.example/',
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('bounds native asset streams and skips a cancelled queued request', async () => {
    const mirrored = streamBundle('bounded', 6);
    const reads = Array.from({ length: 6 }, () => deferred<string>());
    runtime.resolveWebBundle.mockResolvedValue(mirrored);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>bounded</body></html>'
    );
    let readIndex = 0;
    adapterReadFileRange.mockImplementation(
      () => reads[readIndex++]?.promise ?? Promise.resolve('AAECAw==')
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<LocalWebView virtualUrl="https://bounded.example/" />);
    });
    await flush();
    const renderedWebView = webView(renderer);
    const send = (kind: string, requestId: string, url?: string) =>
      sendAssetMessage(renderedWebView, { kind, requestId, url });

    await act(async () => {
      for (let index = 0; index < 6; index += 1) {
        send('request', `request-${index}`, `https://bounded.example/asset-${index}.data`);
      }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapterReadFileRange).toHaveBeenCalledTimes(4);
    expect(adapterReadFileRange.mock.calls.map(([source]) => source).sort()).toEqual(
      [
        '/documents/asset-0.data',
        '/documents/asset-1.data',
        '/documents/asset-2.data',
        '/documents/asset-3.data',
      ].sort()
    );

    await act(async () => {
      send('cancel', 'request-4');
      send('cancel', 'request-0');
      reads[0]!.resolve('AAECAw==');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapterReadFileRange).toHaveBeenCalledTimes(5);
    expect(adapterReadFileRange.mock.calls.at(-1)?.[0]).toBe('/documents/asset-5.data');
    expect(
      adapterReadFileRange.mock.calls.some(([source]) => source === '/documents/asset-4.data')
    ).toBe(false);

    await act(async () => {
      renderer.unmount();
      for (const read of reads) read.resolve('AAECAw==');
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('drops queued asset streams when the active bundle changes', async () => {
    const pendingReads = Array.from({ length: 4 }, () => deferred<string>());
    runtime.resolveWebBundle.mockImplementation(async ({ virtualUrl }) =>
      virtualUrl.includes('first') ? streamBundle('first', 5) : bundle('second')
    );
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>bundle</body></html>'
    );
    let readIndex = 0;
    adapterReadFileRange.mockImplementation(
      () => pendingReads[readIndex++]?.promise ?? Promise.resolve('AAECAw==')
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<LocalWebView virtualUrl="https://first.example/" />);
    });
    await flush();
    const renderedWebView = webView(renderer);

    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        sendAssetMessage(renderedWebView, {
          kind: 'request',
          requestId: `old-${index}`,
          url: `https://first.example/asset-${index}.data`,
        });
      }
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(adapterReadFileRange).toHaveBeenCalledTimes(4);

    await act(async () => {
      renderer.update(<LocalWebView virtualUrl="https://second.example/" />);
      await Promise.resolve();
      await Promise.resolve();
      for (const read of pendingReads) read.resolve('AAECAw==');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapterReadFileRange).toHaveBeenCalledTimes(4);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('rejects asset requests beyond the bounded queue capacity', async () => {
    const mirrored = streamBundle('queue-limit', 40);
    const reads = Array.from({ length: 4 }, () => deferred<string>());
    runtime.resolveWebBundle.mockResolvedValue(mirrored);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>queue</body></html>'
    );
    let readIndex = 0;
    adapterReadFileRange.mockImplementation(
      () => reads[readIndex++]?.promise ?? Promise.resolve('AAECAw==')
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<LocalWebView virtualUrl="https://queue-limit.example/" />);
    });
    await flush();
    const renderedWebView = webView(renderer);

    await act(async () => {
      for (let index = 0; index < 40; index += 1) {
        sendAssetMessage(renderedWebView, {
          kind: 'request',
          requestId: `queue-${index}`,
          url: `https://queue-limit.example/asset-${index}.data`,
        });
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    const errors = runtime.postMessage.mock.calls
      .map(([message]) => JSON.parse(message) as { kind?: string; message?: string })
      .filter((message) => message.kind === 'error');
    expect(adapterReadFileRange).toHaveBeenCalledTimes(4);
    expect(errors).toHaveLength(4);
    expect(errors.every((message) => message.message?.includes('maximum 32'))).toBe(true);

    await act(async () => {
      renderer.unmount();
      for (const read of reads) read.resolve('AAECAw==');
      await Promise.resolve();
    });
  });

  it('ignores cancellation for an unknown request id', async () => {
    const mirrored = streamBundle('unknown-cancel', 1);
    runtime.resolveWebBundle.mockResolvedValue(mirrored);
    runtime.readMirroredWebBundle.mockResolvedValue(
      '<!doctype html><html><head></head><body>cancel</body></html>'
    );
    adapterReadFileRange.mockResolvedValue('AAECAw==');

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<LocalWebView virtualUrl="https://unknown-cancel.example/" />);
    });
    await flush();
    const renderedWebView = webView(renderer);
    const send = (kind: string, url?: string) =>
      sendAssetMessage(renderedWebView, {
        kind,
        requestId: 'future-request',
        url,
      });

    await act(async () => {
      send('cancel');
      send('request', 'https://unknown-cancel.example/asset-0.data');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adapterReadFileRange).toHaveBeenCalledOnce();
    await act(async () => {
      renderer.unmount();
    });
  });
});
