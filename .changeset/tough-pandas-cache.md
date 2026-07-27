---
'react-native-local-webview': patch
---

Add the Nitro-backed native WebView runtime with React Native WebView 13.16.0
prop, event, and method compatibility for durable CSR and Unity WebGL bundles.
On a cache miss, display the remote HTTPS page immediately while installing the
verified local generation in the background. Bound iOS local-file delivery to
prevent large Unity payloads from being queued into WebKit faster than its
content process can consume them.
