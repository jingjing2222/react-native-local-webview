import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  NativeLocalWebViewHandle,
  NativeLocalWebViewProps,
} from '../src/NativeLocalWebView.native';
import type { WebViewProps } from '../src/localWebViewTypes';
import {
  ANDROID_WEBVIEW_PROP_NAMES,
  IOS_WEBVIEW_PROP_NAMES,
  SHARED_WEBVIEW_PROP_NAMES,
  WEBVIEW_METHOD_NAMES,
  WINDOWS_WEBVIEW_PROP_NAMES,
  isOriginAllowed,
  nativeConfigurationFromProps,
  viewPropsFromWebViewProps,
} from '../src/webViewCompatibility';

describe('react-native-webview 13.16.0 compatibility inventory', () => {
  it('keeps the complete platform inventory without the reference package at runtime', () => {
    expect(SHARED_WEBVIEW_PROP_NAMES).toHaveLength(32);
    expect(IOS_WEBVIEW_PROP_NAMES).toHaveLength(43);
    expect(ANDROID_WEBVIEW_PROP_NAMES).toHaveLength(29);
    expect(WINDOWS_WEBVIEW_PROP_NAMES).toHaveLength(3);
    expect(WEBVIEW_METHOD_NAMES).toHaveLength(10);
  });

  it('preserves the package history, sourcePath, and rollback API', () => {
    expectTypeOf<NativeLocalWebViewProps>().toHaveProperty('sourcePath');
    expectTypeOf<NativeLocalWebViewProps>().toHaveProperty('onHistoryChange');
    expectTypeOf<NativeLocalWebViewProps>().toHaveProperty('onCacheRollback');
    expectTypeOf<NativeLocalWebViewProps>().toHaveProperty('onBundleStored');
    expectTypeOf<NativeLocalWebViewHandle>().toHaveProperty('getHistoryState');
    expectTypeOf<NativeLocalWebViewHandle>().toHaveProperty('rollback');
  });

  it('forwards every defined native value, including false and zero', () => {
    const onMessage = () => undefined;
    expect(
      nativeConfigurationFromProps({
        javaScriptEnabled: false,
        onMessage,
        textZoom: 0,
        userAgent: '',
      } as WebViewProps)
    ).toEqual({
      javaScriptEnabled: false,
      textZoom: 0,
      userAgent: '',
    });
  });

  it('keeps View props while excluding WebView and package-only props', () => {
    expect(
      viewPropsFromWebViewProps(
        {
          accessibilityLabel: 'game',
          durableCacheEnabled: true,
          javaScriptEnabled: true,
          source: { html: '<html></html>' },
          testID: 'local-webview',
        } as WebViewProps & Record<string, unknown>,
        new Set(['durableCacheEnabled'])
      )
    ).toEqual({
      accessibilityLabel: 'game',
      testID: 'local-webview',
    });
  });

  it('matches complete standard and custom origins without prefix confusion', () => {
    expect(isOriginAllowed('https://example.com/page', ['https://example.com'])).toBe(true);
    expect(isOriginAllowed('https://example.com.evil/page', ['https://example.com'])).toBe(false);
    expect(isOriginAllowed('local-game://bundle/level', ['local-game://*'])).toBe(true);
    expect(isOriginAllowed('about:blank', [])).toBe(true);
  });
});
