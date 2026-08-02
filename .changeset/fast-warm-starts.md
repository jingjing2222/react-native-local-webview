---
'react-native-local-webview': patch
---

Make warm `release-etag` generations single-document-first: keep inline
resource bytes only in `index.html`, omit their redundant validation metadata,
and avoid creating an empty `assets` directory. Stream the cached entry file on
iOS and supported Android System WebViews instead of materializing it into a
native byte buffer; retain the existing Android fallback for WebViews without
document-start script support.
