# react-native-local-webview

## 0.0.2

### Patch Changes

- [#2](https://github.com/jingjing2222/react-native-local-webview/pull/2) [`ca7f6e1`](https://github.com/jingjing2222/react-native-local-webview/commit/ca7f6e19e6d4edcc35768b870f001790410bfeb5) Thanks [@jingjing2222](https://github.com/jingjing2222)! - Move durable downloads, file operations, range reads, and SHA-2 hashing into
  the Nitro WebView runtime. Keep the React Native WebView 13.16.0-compatible prop,
  event, and method surface on the built-in iOS and Android WebViews. Compute
  download digests while streaming, avoid temporary-file work for 304 responses,
  reuse the iOS networking session, and start warm local navigations before
  background validation. Make the WebView select and open published cache
  generations directly, without routing cached HTML or asset manifests through
  React state, and start warm release-ETag revalidation immediately after the
  local page load instead of applying the cold-install settle delay. Add
  `validationMode="release-etag"` for origins that
  expose one release validator, eliminating warm payload rehashes and per-resource
  requests.

  Use `LocalWebView` consistently across the public API, Nitro view, platform
  implementations, cache requests, and benchmark reports. Remove the transitional
  `NativeLocalWebView` aliases and rename manifest delivery from `bridge` to
  `file` so names describe the durable runtime instead of an implementation
  migration that no longer exists.
