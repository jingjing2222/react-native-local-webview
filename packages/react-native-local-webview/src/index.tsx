export { LocalWebView as LegacyLocalWebView } from './LocalWebView.native';
export {
  NativeLocalWebView,
  NativeLocalWebView as LocalWebView,
} from './NativeLocalWebView.native';
export {
  createExpoFileSystemCacheAdapter,
  createReactNativeBlobUtilCacheAdapter,
  createReactNativeFileAccessCacheAdapter,
  createReactNativeFsCacheAdapter,
} from './cacheAdapterPresets';
export type {
  CacheAdapterPresetOptions,
  ExpoFileSystemLike,
  ReactNativeBlobUtilCacheAdapterOptions,
  ReactNativeBlobUtilLike,
  ReactNativeFileAccessLike,
  ReactNativeFsLike,
} from './cacheAdapterPresets';
export type {
  LocalWebViewHandle as LegacyLocalWebViewHandle,
  LocalWebViewHistoryState,
  LocalWebViewProps as LegacyLocalWebViewProps,
} from './LocalWebView.native';
export type {
  NativeLocalWebViewComponent,
  NativeLocalWebViewHandle,
  NativeLocalWebViewHandle as LocalWebViewHandle,
  NativeLocalWebViewProps,
  NativeLocalWebViewProps as LocalWebViewProps,
} from './NativeLocalWebView.native';
export type {
  CreateLocalWebViewCacheAdapterOptions,
  LocalWebViewCacheAdapter,
  LocalWebViewDirectories,
  LocalWebViewDownloadOptions,
  LocalWebViewDownloadResult,
  LocalWebViewFileEncoding,
  LocalWebViewFileDigests,
  LocalWebViewFileStat,
  LocalWebViewHashAlgorithm,
} from './localWebViewCacheAdapter';
export {
  createLocalWebViewCacheAdapter,
  LocalWebViewDownloadLimitError,
} from './localWebViewCacheAdapter';
export {
  cacheDirectoryForOrigin,
  readMirroredWebBundle,
  retainWebBundle,
  rollbackWebBundle,
  resolveWebBundle,
} from './mirrorWebBundle';
export {
  ANDROID_WEBVIEW_PROP_NAMES,
  IOS_WEBVIEW_PROP_NAMES,
  SHARED_WEBVIEW_PROP_NAMES,
  WEBVIEW_EVENT_PROP_NAMES,
  WEBVIEW_METHOD_NAMES,
  WEBVIEW_PROP_NAMES,
  WINDOWS_WEBVIEW_PROP_NAMES,
} from './webViewCompatibility';
export type {
  CachePolicy,
  MirroredLocalAsset,
  MirroredWebBundle,
  ResolveWebBundleOptions,
} from './mirrorWebBundle';
