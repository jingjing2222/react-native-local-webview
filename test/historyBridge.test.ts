import vm from 'node:vm';

import { parse, type Node } from 'parse5';
import { describe, expect, it } from 'vitest';

import { historyStateFromMessage } from '../src/historyState';
import { installHistoryBridge } from '../src/installHistoryBridge';

type HtmlNode = Node;

function injectedHistoryScript(html: string): { count: number; source: string } {
  const document = parse(html);
  let count = 0;
  let source = '';
  const visit = (node: HtmlNode): void => {
    if (
      'tagName' in node &&
      node.tagName === 'script' &&
      node.attrs.some((attribute) => attribute.name === 'data-react-native-local-webview-history')
    ) {
      count += 1;
      source = node.childNodes
        .filter((child) => child.nodeName === '#text' && 'value' in child)
        .map((child) => ('value' in child ? child.value : ''))
        .join('');
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(document);
  return { count, source };
}

type RuntimeHistory = {
  length: number;
  pushState: (state: unknown, title: string, url?: string) => void;
  replaceState: (state: unknown, title: string, url?: string) => void;
  state: unknown;
};

function historyRuntime(
  source: string,
  postMessage?: (payload: string) => void
): {
  history: RuntimeHistory;
  location: { href: string };
  messages: Array<Record<string, unknown>>;
} {
  const location = { href: 'https://app.example/start' };
  const messages: Array<Record<string, unknown>> = [];
  const history: RuntimeHistory = {
    length: 1,
    pushState: () => {},
    replaceState: () => {},
    state: null,
  };
  history.pushState = (state, _title, url) => {
    history.length += 1;
    history.state = state;
    if (url !== undefined) location.href = new URL(url, location.href).href;
  };
  history.replaceState = (state, _title, url) => {
    history.state = state;
    if (url !== undefined) location.href = new URL(url, location.href).href;
  };
  const context: Record<string, unknown> = {
    ReactNativeWebView: {
      postMessage:
        postMessage ??
        ((payload: string) => {
          messages.push(JSON.parse(payload) as Record<string, unknown>);
        }),
    },
    addEventListener: () => {},
    history,
    location,
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return { history, location, messages };
}

describe('History bridge', () => {
  it('runs before the CSR entry and leaves native traversal methods intact', () => {
    const html = installHistoryBridge(
      '<!doctype html><html><head><script type="module" src="/entry.js"></script></head><body></body></html>'
    );

    expect(() => parse(html)).not.toThrow();
    expect(html.indexOf('data-react-native-local-webview-history')).toBeLessThan(
      html.indexOf('src="/entry.js"')
    );
    expect(html).toContain('nativePushState(state, title, url)');
    expect(html).toContain('nativeReplaceState(state, title, url)');
    expect(html).not.toContain('history.back =');
    expect(html).not.toContain('history.forward =');
    expect(html).not.toContain('history.go =');
    expect(html).not.toContain("Object.defineProperty(history, 'length'");
    expect(html).not.toContain('let entries');
    expect(html).not.toContain('let index');
  });

  it('is idempotent', () => {
    const once = installHistoryBridge('<!doctype html><html><head></head><body></body></html>');
    expect(installHistoryBridge(once)).toBe(once);
  });

  it('does not mistake marker text for an installed marker script', () => {
    const marker = 'data-react-native-local-webview-history';
    const original = `<!doctype html><html><head><script>globalThis.marker = ${JSON.stringify(
      marker
    )};</script></head><body></body></html>`;

    const installed = installHistoryBridge(original);

    expect(installed).not.toBe(original);
    expect(injectedHistoryScript(installed).count).toBe(1);
  });

  it('preserves pushState when its valid structured state is not JSON serializable', () => {
    const { source } = injectedHistoryScript(
      installHistoryBridge('<!doctype html><html><head></head><body></body></html>')
    );
    const runtime = historyRuntime(source);
    const state = { revision: 1n };

    expect(() => runtime.history.pushState(state, '', '/next')).not.toThrow();
    expect(runtime.history.state).toBe(state);
    expect(runtime.history.length).toBe(2);
    expect(runtime.location.href).toBe('https://app.example/next');
    expect(runtime.messages).toContainEqual(
      expect.objectContaining({
        length: 2,
        navigationType: 'pushState',
        state: null,
        stateSerializationFailed: true,
        url: 'https://app.example/next',
      })
    );
    expect(
      historyStateFromMessage(JSON.stringify(runtime.messages.at(-1)), {
        canGoBack: true,
        canGoForward: false,
      })
    ).toMatchObject({
      state: null,
      stateSerializationFailed: true,
      url: 'https://app.example/next',
    });
  });

  it.each([
    ['a Map root', new Map([['route', 1]])],
    ['a nested Set', { route: new Set([1]) }],
    ['a Date root', new Date('2026-01-01T00:00:00.000Z')],
    ['a nested typed array', { bytes: new Uint8Array([1, 2, 3]) }],
    ['NaN', Number.NaN],
    ['negative zero', -0],
    ['nested undefined', { route: undefined }],
    ['root undefined', undefined],
  ])('flags JSON-lossy structured state containing %s', (_name, state) => {
    const { source } = injectedHistoryScript(
      installHistoryBridge('<!doctype html><html><head></head><body></body></html>')
    );
    const runtime = historyRuntime(source);

    runtime.history.pushState(state, '', '/lossy');

    expect(runtime.history.state).toBe(state);
    expect(runtime.messages.at(-1)).toMatchObject({
      navigationType: 'pushState',
      state: null,
      stateSerializationFailed: true,
      url: 'https://app.example/lossy',
    });
  });

  it('detects cycles and shared object identity without recursing forever', () => {
    const { source } = injectedHistoryScript(
      installHistoryBridge('<!doctype html><html><head></head><body></body></html>')
    );
    const runtime = historyRuntime(source);
    const shared = { page: 1 };
    const aliased = { first: shared, second: shared };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    runtime.history.pushState(aliased, '', '/aliased');
    runtime.history.pushState(cyclic, '', '/cyclic');

    expect(runtime.messages.slice(-2)).toEqual([
      expect.objectContaining({
        state: null,
        stateSerializationFailed: true,
        url: 'https://app.example/aliased',
      }),
      expect.objectContaining({
        state: null,
        stateSerializationFailed: true,
        url: 'https://app.example/cyclic',
      }),
    ]);
  });

  it('reports nested plain JSON state without a serialization warning', () => {
    const { source } = injectedHistoryScript(
      installHistoryBridge('<!doctype html><html><head></head><body></body></html>')
    );
    const runtime = historyRuntime(source);
    const state = {
      enabled: true,
      route: {
        index: 2,
        segments: ['books', null, 42],
      },
    };

    runtime.history.pushState(state, '', '/plain');

    expect(runtime.messages.at(-1)).toEqual({
      channel: 'react-native-local-webview:history',
      length: 2,
      navigationType: 'pushState',
      state,
      stateSerializationFailed: false,
      url: 'https://app.example/plain',
    });
  });

  it('preserves replaceState when the native message bridge throws', () => {
    const { source } = injectedHistoryScript(
      installHistoryBridge('<!doctype html><html><head></head><body></body></html>')
    );
    const runtime = historyRuntime(source, () => {
      throw new Error('bridge unavailable');
    });
    const state = { page: 2 };

    expect(() => runtime.history.replaceState(state, '', '/replaced')).not.toThrow();
    expect(runtime.history.state).toBe(state);
    expect(runtime.history.length).toBe(1);
    expect(runtime.location.href).toBe('https://app.example/replaced');
  });

  it('uses native traversal flags even when the page message claims different values', () => {
    const state = historyStateFromMessage(
      JSON.stringify({
        canGoBack: false,
        canGoForward: true,
        channel: 'react-native-local-webview:history',
        length: 4,
        navigationType: 'hashchange',
        state: { page: 2 },
        url: 'https://app.example/#two',
      }),
      {
        canGoBack: true,
        canGoForward: false,
      }
    );

    expect(state).toEqual({
      canGoBack: true,
      canGoForward: false,
      length: 4,
      navigationType: 'hashchange',
      state: { page: 2 },
      stateSerializationFailed: false,
      url: 'https://app.example/#two',
    });
  });

  it('reports duplicate-URL traversal from the native event without guessing an index', () => {
    const message = JSON.stringify({
      channel: 'react-native-local-webview:history',
      length: 5,
      navigationType: 'popstate',
      state: null,
      url: 'https://app.example/repeated',
    });

    expect(
      historyStateFromMessage(message, {
        canGoBack: true,
        canGoForward: true,
      })
    ).toMatchObject({
      canGoBack: true,
      canGoForward: true,
      url: 'https://app.example/repeated',
    });
  });
});
