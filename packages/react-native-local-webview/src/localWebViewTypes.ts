import type { ReactElement } from 'react';
import type {
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  ViewProps,
  ViewStyle,
} from 'react-native';

export interface WebViewNativeEvent {
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  lockIdentifier: number;
  title: string;
  url: string;
}

export interface WebViewNavigation extends WebViewNativeEvent {
  mainDocumentURL?: string;
  navigationType: 'backforward' | 'click' | 'formresubmit' | 'formsubmit' | 'other' | 'reload';
}

export interface ShouldStartLoadRequest extends WebViewNavigation {
  isTopFrame: boolean;
}

export interface WebViewError extends WebViewNativeEvent {
  code: number;
  description: string;
  domain?: string;
}

export interface WebViewSourceUri {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
  uri: string;
}

export interface WebViewSourceHtml {
  baseUrl?: string;
  html: string;
}

export type WebViewSource = WebViewSourceHtml | WebViewSourceUri;
export type WebViewEvent = NativeSyntheticEvent<WebViewNativeEvent>;
export type WebViewNavigationEvent = NativeSyntheticEvent<WebViewNavigation>;
export type WebViewErrorEvent = NativeSyntheticEvent<WebViewError>;
export type WebViewProgressEvent = NativeSyntheticEvent<WebViewNativeEvent & { progress: number }>;
export type WebViewMessageEvent = NativeSyntheticEvent<WebViewNativeEvent & { data: string }>;
export type WebViewHttpErrorEvent = NativeSyntheticEvent<
  WebViewNativeEvent & { description: string; statusCode: number }
>;
export type WebViewOpenWindowEvent = NativeSyntheticEvent<{ targetUrl: string }>;
export type WebViewRenderProcessGoneEvent = NativeSyntheticEvent<{ didCrash: boolean }>;
export type WebViewScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;
export type WebViewTerminatedEvent = NativeSyntheticEvent<WebViewNativeEvent>;
export type FileDownloadEvent = NativeSyntheticEvent<{ downloadUrl: string }>;

export interface WebViewProps extends ViewProps {
  allowFileAccess?: boolean;
  allowFileAccessFromFileURLs?: boolean;
  allowUniversalAccessFromFileURLs?: boolean;
  allowingReadAccessToURL?: string;
  allowsAirPlayForMediaPlayback?: boolean;
  allowsBackForwardNavigationGestures?: boolean;
  allowsFullscreenVideo?: boolean;
  allowsInlineMediaPlayback?: boolean;
  allowsLinkPreview?: boolean;
  allowsPictureInPictureMediaPlayback?: boolean;
  allowsProtectedMedia?: boolean;
  androidLayerType?: 'hardware' | 'none' | 'software';
  applicationNameForUserAgent?: string;
  autoManageStatusBarEnabled?: boolean;
  automaticallyAdjustContentInsets?: boolean;
  automaticallyAdjustsScrollIndicatorInsets?: boolean;
  basicAuthCredential?: { password: string; username: string };
  bounces?: boolean;
  cacheEnabled?: boolean;
  cacheMode?: 'LOAD_CACHE_ELSE_NETWORK' | 'LOAD_CACHE_ONLY' | 'LOAD_DEFAULT' | 'LOAD_NO_CACHE';
  containerStyle?: StyleProp<ViewStyle>;
  contentInset?: { bottom?: number; left?: number; right?: number; top?: number };
  contentInsetAdjustmentBehavior?: 'always' | 'automatic' | 'never' | 'scrollableAxes';
  contentMode?: 'desktop' | 'mobile' | 'recommended';
  dataDetectorTypes?: string | string[];
  decelerationRate?: 'fast' | 'normal' | number;
  directionalLockEnabled?: boolean;
  domStorageEnabled?: boolean;
  downloadingMessage?: string;
  enableApplePay?: boolean;
  forceDarkOn?: boolean;
  fraudulentWebsiteWarningEnabled?: boolean;
  geolocationEnabled?: boolean;
  hideKeyboardAccessoryView?: boolean;
  ignoreSilentHardwareSwitch?: boolean;
  incognito?: boolean;
  indicatorStyle?: 'black' | 'default' | 'white';
  injectedJavaScript?: string;
  injectedJavaScriptBeforeContentLoaded?: string;
  injectedJavaScriptBeforeContentLoadedForMainFrameOnly?: boolean;
  injectedJavaScriptForMainFrameOnly?: boolean;
  injectedJavaScriptObject?: object;
  javaScriptCanOpenWindowsAutomatically?: boolean;
  javaScriptEnabled?: boolean;
  keyboardDisplayRequiresUserAction?: boolean;
  lackPermissionToDownloadMessage?: string;
  limitsNavigationsToAppBoundDomains?: boolean;
  mediaCapturePermissionGrantType?:
    | 'deny'
    | 'grant'
    | 'grantIfSameHostElseDeny'
    | 'grantIfSameHostElsePrompt'
    | 'prompt';
  mediaPlaybackRequiresUserAction?: boolean;
  menuItems?: Array<{ key: string; label: string }>;
  minimumFontSize?: number;
  mixedContentMode?: 'always' | 'compatibility' | 'never';
  nativeConfig?: {
    /**
     * Extra properties for the built-in Nitro native view.
     * Replacing the component itself is intentionally unsupported.
     */
    props?: Record<string, unknown>;
  };
  nestedScrollEnabled?: boolean;
  onContentProcessDidTerminate?: (event: WebViewTerminatedEvent) => void;
  onContentSizeChange?: (event: WebViewEvent) => void;
  onCustomMenuSelection?: (event: {
    nativeEvent: { key: string; label: string; selectedText: string };
  }) => void;
  onError?: (event: WebViewErrorEvent) => void;
  onFileDownload?: (event: FileDownloadEvent) => void;
  onHttpError?: (event: WebViewHttpErrorEvent) => void;
  onLoad?: (event: WebViewNavigationEvent) => void;
  onLoadEnd?: (event: WebViewErrorEvent | WebViewNavigationEvent) => void;
  onLoadProgress?: (event: WebViewProgressEvent) => void;
  onLoadStart?: (event: WebViewNavigationEvent) => void;
  onLoadSubResourceError?: (event: WebViewErrorEvent) => void;
  onMessage?: (event: WebViewMessageEvent) => void;
  onNavigationStateChange?: (event: WebViewNavigation) => void;
  onOpenWindow?: (event: WebViewOpenWindowEvent) => void;
  onRenderProcessGone?: (event: WebViewRenderProcessGoneEvent) => void;
  onScroll?: (event: WebViewScrollEvent) => void;
  onShouldStartLoadWithRequest?: (event: ShouldStartLoadRequest) => boolean;
  onSourceChanged?: (event: WebViewNavigationEvent) => void;
  originWhitelist?: string[];
  overScrollMode?: 'always' | 'content' | 'never';
  pagingEnabled?: boolean;
  paymentRequestEnabled?: boolean;
  pullToRefreshEnabled?: boolean;
  refreshControlLightMode?: boolean;
  renderError?: (
    errorDomain: string | undefined,
    errorCode: number,
    errorDescription: string
  ) => ReactElement;
  renderLoading?: () => ReactElement;
  saveFormDataDisabled?: boolean;
  scalesPageToFit?: boolean;
  scrollEnabled?: boolean;
  setBuiltInZoomControls?: boolean;
  setDisplayZoomControls?: boolean;
  setSupportMultipleWindows?: boolean;
  sharedCookiesEnabled?: boolean;
  showsHorizontalScrollIndicator?: boolean;
  showsVerticalScrollIndicator?: boolean;
  source?: WebViewSource;
  startInLoadingState?: boolean;
  suppressMenuItems?: string[];
  textInteractionEnabled?: boolean;
  textZoom?: number;
  thirdPartyCookiesEnabled?: boolean;
  useSharedProcessPool?: boolean;
  useWebView2?: boolean;
  userAgent?: string;
  webviewDebuggingEnabled?: boolean;
}
