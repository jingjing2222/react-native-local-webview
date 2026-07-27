import { parse, parseFragment, serialize, type Element, type Node } from 'parse5';

import { escapeScriptRawText } from './htmlRawText';

export const HISTORY_MESSAGE_CHANNEL = 'react-native-local-webview:history';

export const HISTORY_BRIDGE_SCRIPT = String.raw`
(() => {
  if (window.__REACT_NATIVE_LOCAL_WEBVIEW_HISTORY__) return;

  const channel = ${JSON.stringify(HISTORY_MESSAGE_CHANNEL)};
  const nativePushState = history.pushState.bind(history);
  const nativeReplaceState = history.replaceState.bind(history);

  const isJsonLosslessState = (root) => {
    const seen = new WeakSet();
    const visit = (value) => {
      if (value === null) return true;
      const type = typeof value;
      if (type === 'string' || type === 'boolean') return true;
      if (type === 'number') {
        return Number.isFinite(value) && !Object.is(value, -0);
      }
      if (type !== 'object') return false;
      if (seen.has(value)) return false;
      seen.add(value);
      if (typeof value.toJSON === 'function') return false;

      if (Array.isArray(value)) {
        if (Object.getOwnPropertySymbols(value).length !== 0) return false;
        const keys = Object.keys(value);
        const names = Object.getOwnPropertyNames(value);
        if (keys.length !== value.length || names.length !== keys.length + 1) return false;
        for (let position = 0; position < keys.length; position += 1) {
          if (keys[position] !== String(position) || !visit(value[position])) return false;
        }
        return true;
      }

      const prototype = Object.getPrototypeOf(value);
      if (
        prototype !== null &&
        (typeof prototype !== 'object' || Object.getPrototypeOf(prototype) !== null)
      ) {
        return false;
      }
      if (Object.getOwnPropertySymbols(value).length !== 0) return false;
      const keys = Object.keys(value);
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== keys.length) return false;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
        if (!visit(descriptor.value)) return false;
      }
      return true;
    };

    try {
      return visit(root);
    } catch {
      return false;
    }
  };

  const notify = (navigationType) => {
    const state = history.state;
    const stateSerializationFailed = !isJsonLosslessState(state);
    const message = {
      channel,
      length: history.length,
      navigationType,
      state: stateSerializationFailed ? null : state,
      stateSerializationFailed,
      url: location.href
    };
    let payload;
    try {
      payload = JSON.stringify(message);
    } catch {
      try {
        payload = JSON.stringify({
          ...message,
          state: null,
          stateSerializationFailed: true
        });
      } catch {
        return;
      }
    }
    try {
      window.ReactNativeWebView?.postMessage(payload);
    } catch {}
  };

  history.pushState = function pushState(state, title, url) {
    nativePushState(state, title, url);
    notify('pushState');
  };

  history.replaceState = function replaceState(state, title, url) {
    nativeReplaceState(state, title, url);
    notify('replaceState');
  };

  addEventListener('popstate', () => notify('popstate'));
  addEventListener('hashchange', () => notify('hashchange'));
  addEventListener('pageshow', () => notify('pageshow'));

  window.__REACT_NATIVE_LOCAL_WEBVIEW_HISTORY__ = {
    notify: () => notify('manual')
  };
})();
`;

export const HISTORY_BRIDGE_MARKER = 'data-react-native-local-webview-history';

/**
 * Observes the browser's real History API without replacing its stack.
 */
export function installHistoryBridge(html: string): string {
  const document = parse(html);
  let installed = false;
  let head: Element | undefined;
  const visit = (node: Node): void => {
    if ('tagName' in node) {
      if (node.tagName === 'head') head = node;
      if (
        node.tagName === 'script' &&
        node.attrs.some((attribute) => attribute.name === HISTORY_BRIDGE_MARKER)
      ) {
        installed = true;
      }
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(document);
  if (installed) return html;
  if (!head) throw new Error('HTML document does not contain a <head>');

  const fragment = parseFragment(
    `<script ${HISTORY_BRIDGE_MARKER}>${escapeScriptRawText(HISTORY_BRIDGE_SCRIPT)}</script>`
  );
  const script = fragment.childNodes[0];
  if (!script) throw new Error('Failed to construct the History bridge');
  if ('parentNode' in script) script.parentNode = head;
  head.childNodes.unshift(script);
  return serialize(document);
}
