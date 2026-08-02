import type { ViewProps } from 'react-native';
import type { WebViewProps } from './localWebViewTypes';

export const SHARED_WEBVIEW_PROP_NAMES = [
  'source',
  'javaScriptEnabled',
  'javaScriptCanOpenWindowsAutomatically',
  'containerStyle',
  'renderError',
  'renderLoading',
  'onScroll',
  'onLoad',
  'onLoadEnd',
  'onLoadStart',
  'onError',
  'onHttpError',
  'onNavigationStateChange',
  'onMessage',
  'onLoadProgress',
  'startInLoadingState',
  'injectedJavaScript',
  'injectedJavaScriptBeforeContentLoaded',
  'injectedJavaScriptForMainFrameOnly',
  'injectedJavaScriptBeforeContentLoadedForMainFrameOnly',
  'showsHorizontalScrollIndicator',
  'showsVerticalScrollIndicator',
  'mediaPlaybackRequiresUserAction',
  'originWhitelist',
  'onShouldStartLoadWithRequest',
  'nativeConfig',
  'cacheEnabled',
  'applicationNameForUserAgent',
  'basicAuthCredential',
  'injectedJavaScriptObject',
  'webviewDebuggingEnabled',
  'paymentRequestEnabled',
] as const satisfies readonly (keyof WebViewProps)[];

export const IOS_WEBVIEW_PROP_NAMES = [
  'incognito',
  'bounces',
  'decelerationRate',
  'scrollEnabled',
  'pagingEnabled',
  'automaticallyAdjustContentInsets',
  'automaticallyAdjustsScrollIndicatorInsets',
  'contentInsetAdjustmentBehavior',
  'contentInset',
  'contentMode',
  'dataDetectorTypes',
  'allowsInlineMediaPlayback',
  'allowsPictureInPictureMediaPlayback',
  'allowsAirPlayForMediaPlayback',
  'hideKeyboardAccessoryView',
  'allowsBackForwardNavigationGestures',
  'useSharedProcessPool',
  'userAgent',
  'allowsLinkPreview',
  'sharedCookiesEnabled',
  'ignoreSilentHardwareSwitch',
  'autoManageStatusBarEnabled',
  'directionalLockEnabled',
  'keyboardDisplayRequiresUserAction',
  'allowingReadAccessToURL',
  'allowFileAccessFromFileURLs',
  'allowUniversalAccessFromFileURLs',
  'onContentProcessDidTerminate',
  'onOpenWindow',
  'injectedJavaScriptForMainFrameOnly',
  'injectedJavaScriptBeforeContentLoadedForMainFrameOnly',
  'pullToRefreshEnabled',
  'refreshControlLightMode',
  'indicatorStyle',
  'onFileDownload',
  'limitsNavigationsToAppBoundDomains',
  'textInteractionEnabled',
  'mediaCapturePermissionGrantType',
  'enableApplePay',
  'menuItems',
  'suppressMenuItems',
  'onCustomMenuSelection',
  'fraudulentWebsiteWarningEnabled',
] as const satisfies readonly (keyof WebViewProps)[];

export const ANDROID_WEBVIEW_PROP_NAMES = [
  'onNavigationStateChange',
  'onContentSizeChange',
  'onRenderProcessGone',
  'onOpenWindow',
  'cacheMode',
  'overScrollMode',
  'scalesPageToFit',
  'geolocationEnabled',
  'allowFileAccessFromFileURLs',
  'allowUniversalAccessFromFileURLs',
  'allowFileAccess',
  'saveFormDataDisabled',
  'setSupportMultipleWindows',
  'androidLayerType',
  'thirdPartyCookiesEnabled',
  'domStorageEnabled',
  'userAgent',
  'textZoom',
  'mixedContentMode',
  'allowsFullscreenVideo',
  'forceDarkOn',
  'setBuiltInZoomControls',
  'setDisplayZoomControls',
  'nestedScrollEnabled',
  'minimumFontSize',
  'downloadingMessage',
  'lackPermissionToDownloadMessage',
  'allowsProtectedMedia',
  'onLoadSubResourceError',
] as const satisfies readonly (keyof WebViewProps)[];

export const WINDOWS_WEBVIEW_PROP_NAMES = [
  'useWebView2',
  'onOpenWindow',
  'onSourceChanged',
] as const satisfies readonly (keyof WebViewProps)[];

export const WEBVIEW_PROP_NAMES = [
  ...new Set([
    ...SHARED_WEBVIEW_PROP_NAMES,
    ...IOS_WEBVIEW_PROP_NAMES,
    ...ANDROID_WEBVIEW_PROP_NAMES,
    ...WINDOWS_WEBVIEW_PROP_NAMES,
  ]),
] as readonly (keyof WebViewProps)[];

export const WEBVIEW_EVENT_PROP_NAMES = [
  'onContentProcessDidTerminate',
  'onContentSizeChange',
  'onCustomMenuSelection',
  'onError',
  'onFileDownload',
  'onHttpError',
  'onLoad',
  'onLoadEnd',
  'onLoadProgress',
  'onLoadStart',
  'onLoadSubResourceError',
  'onMessage',
  'onNavigationStateChange',
  'onOpenWindow',
  'onRenderProcessGone',
  'onScroll',
  'onShouldStartLoadWithRequest',
  'onSourceChanged',
] as const satisfies readonly (keyof WebViewProps)[];

export const WEBVIEW_METHOD_NAMES = [
  'clearCache',
  'clearFormData',
  'clearHistory',
  'goBack',
  'goForward',
  'injectJavaScript',
  'postMessage',
  'reload',
  'requestFocus',
  'stopLoading',
] as const;

export const NATIVE_CONFIGURATION_PROP_NAMES = WEBVIEW_PROP_NAMES.filter(
  (name) =>
    ![
      'containerStyle',
      'nativeConfig',
      'originWhitelist',
      'renderError',
      'renderLoading',
      'source',
      ...WEBVIEW_EVENT_PROP_NAMES,
    ].includes(name)
);

const webViewPropNameSet = new Set<string>(WEBVIEW_PROP_NAMES);

export function isOriginAllowed(url: string, whitelist: readonly string[]): boolean {
  const match = /^[A-Za-z][A-Za-z0-9+\-.]+:(\/\/)?[^/]*/.exec(url);
  const origin = url === 'about:blank' ? url : (match?.[0] ?? '');
  return ['about:blank', ...whitelist].some((pattern) => {
    const expression = pattern.replaceAll(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${expression}$`).test(origin);
  });
}

export function configurationFromProps(props: WebViewProps): Record<string, unknown> {
  const configuration: Record<string, unknown> = {};
  for (const name of NATIVE_CONFIGURATION_PROP_NAMES) {
    const value = props[name];
    if (value !== undefined) configuration[name] = value;
  }
  return configuration;
}

export function viewPropsFromWebViewProps(
  props: WebViewProps & Record<string, unknown>,
  customPropNames: ReadonlySet<string>
): ViewProps {
  const viewProps: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    if (!webViewPropNameSet.has(name) && !customPropNames.has(name)) {
      viewProps[name] = value;
    }
  }
  return viewProps as ViewProps;
}
