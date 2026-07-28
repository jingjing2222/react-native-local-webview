---
'react-native-local-webview': patch
---

Move durable downloads, file operations, range reads, and SHA-2 hashing into
the Nitro native runtime. Keep the React Native WebView 13.16.0-compatible prop,
event, and method surface on the built-in iOS and Android WebViews.
