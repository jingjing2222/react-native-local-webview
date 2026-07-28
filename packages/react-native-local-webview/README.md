# react-native-local-webview

Run CSR and Unity WebGL bundles from durable local storage without giving up their HTTPS origin.

`react-native-local-webview` is a Nitro-powered iOS and Android WebView runtime for applications
that need web content to survive unreliable networks. It shows the real remote page immediately
on a cold install, builds a verified local bundle in the background, and starts from local storage
on later launches while preserving the original `https://` URL, origin, History API, cookies,
workers, WASM, and Range requests.

## Why use it?

A normal WebView cache is intentionally disposable. The operating system may evict it, cache
headers may prevent reuse, and a collection of individually cached responses is not an atomic
offline release.

Loading `file://` content is durable, but changes the security origin and breaks assumptions made
by most production CSR and Unity WebGL builds.

This package keeps those concerns separate:

- WebKit or Android WebView owns the browsing context and reports the real HTTPS URL.
- A versioned, origin-scoped bundle lives in the application's persistent storage.
- Native networking streams response bodies directly to files.
- Native SHA-256, SHA-384, and SHA-512 validate cached files without moving large payloads
  through the React Native bridge.
- The native WebView serves verified local bytes for matching HTTPS requests.

## Installation

```sh
yarn add react-native-local-webview react-native-nitro-modules
```

Install iOS pods after adding the package:

```sh
cd ios && pod install
```

Requirements:

- React Native New Architecture
- iOS 16.4 or newer
- Android API 24 or newer
- `react-native-nitro-modules`

The peer dependency ranges are intentionally `*`; your application owns the React, React Native,
and Nitro versions.

## Quick start

```tsx
import { LocalWebView } from 'react-native-local-webview';

export function Game() {
  return (
    <LocalWebView
      source={{ uri: 'https://game.example.com/' }}
      onMessage={({ nativeEvent }) => {
        console.log(nativeEvent.data);
      }}
      style={{ flex: 1 }}
    />
  );
}
```

You can use `virtualUrl` instead of `source` when the component exists specifically for one
remote entry:

```tsx
<LocalWebView virtualUrl="https://game.example.com/" style={{ flex: 1 }} />
```

Do not pass both.

## What happens on each launch?

### First install

The component opens the remote HTTPS document immediately. In parallel, the native cache
downloads the entry and every statically discoverable dependency into a staging generation.
Only a complete, hashed generation becomes active.

`onBundleStored` fires when that background installation is durable. The first page does not wait
for the full Unity payload to be copied.

### Warm start

The last complete generation is verified and displayed from local storage. Every remote resource
is then revalidated. ETags are checked per asset, not only on `index.html`; resources without an
ETag are downloaded and compared by SHA-256.

If nothing changed, the active local generation stays in place. If anything changed, a new
generation is built and committed atomically for the next mount.

The cache data path avoids redundant work: required SHA-2 digests are computed while downloads are
written, successful downloads return their exact byte count without a second `stat`, and 304
responses do not create temporary files. iOS also reuses one networking session across the bounded
revalidation batch. Persisted files are still fully hashed before a generation is activated.

### Offline start

The last verified generation starts without contacting the origin. A failed refresh never
destroys that generation.

## Unity WebGL and modern CSR bundles

The resource graph understands production HTML, CSS, and JavaScript rather than searching HTML
with regular expressions. It collects or rewrites:

- module scripts and static or dynamic imports
- stylesheets, CSS imports, and `url(...)`
- `src`, `srcset`, preload, and module-preload resources
- Web Workers and worker module graphs
- WebAssembly URLs
- Unity `.data`, `.wasm`, framework, and loader assets

Large artifacts remain as files. The native request interceptor supports complete responses and
single byte ranges, so Unity streaming requests do not require a base64 copy through JS.
Runtime `fetch()` calls that are not part of the mirrored graph continue to use the real HTTPS
network and origin.

## Origin and navigation behavior

The WebView document URL remains the remote HTTPS URL even when its bytes come from local storage.
As a result:

- `location.origin` and `isSecureContext` keep their HTTPS values.
- relative URLs resolve against the original remote document.
- same-origin `fetch`, cookies, storage, and browser security checks see the remote origin.
- `pushState`, `replaceState`, `back`, `forward`, and `go` remain available.

History state is exposed separately because SPA history is not the same thing as the native
WebView back-forward list:

```tsx
import { useRef } from 'react';
import { LocalWebView, type LocalWebViewHandle } from 'react-native-local-webview';

export function App() {
  const ref = useRef<LocalWebViewHandle>(null);

  return (
    <LocalWebView
      ref={ref}
      virtualUrl="https://app.example.com/"
      onHistoryChange={(history) => {
        console.log(history.url, history.canGoBack);
      }}
    />
  );
}
```

`ref.current?.goBack()` and `goForward()` first operate on the WebView runtime. Call
`getHistoryState()` when the native application needs the current SPA state.

## Cache policy

```tsx
<LocalWebView
  virtualUrl="https://game.example.com/"
  cachePolicy={{
    maxBytes: 800 * 1024 * 1024,
    maxGenerations: 2,
    maxInlineBytes: 4 * 1024 * 1024,
  }}
/>
```

| Option           | Meaning                                                       | Default |
| ---------------- | ------------------------------------------------------------- | ------: |
| `maxBytes`       | Maximum bytes retained by one origin cache                    | 512 MiB |
| `maxGenerations` | Complete generations retained for rollback                    |       2 |
| `maxInlineBytes` | Largest parser-required asset allowed to cross as text/base64 |  32 MiB |

Downloads stop as soon as a declared or observed response body exceeds `maxBytes`. Generation
cleanup never removes a generation that is currently leased by a mounted WebView.

Use a custom persistent path only when the application needs deterministic cache placement:

```tsx
<LocalWebView
  cacheDirectory="/application-owned/persistent/path/game"
  virtualUrl="https://game.example.com/"
/>
```

The built-in default is recommended.

## Cache controls

```ts
import {
  cacheDirectoryForOrigin,
  clearLocalWebViewCache,
  resolveWebBundle,
  rollbackWebBundle,
} from 'react-native-local-webview';

const url = 'https://game.example.com/';
const directory = cacheDirectoryForOrigin(url);

await resolveWebBundle({ virtualUrl: url, forceRefresh: true });
await rollbackWebBundle(directory);
await clearLocalWebViewCache(url);
```

`resolveWebBundle` runs the same cache lifecycle as the component.

## Events

```tsx
<LocalWebView
  virtualUrl="https://game.example.com/"
  onBundleReady={(bundle) => {
    console.log(bundle.usedCachedBundle, bundle.totalBytes);
  }}
  onBundleStored={(bundle) => {
    console.log('durable generation', bundle.generationId);
  }}
  onBundleError={(error) => {
    console.error(error);
  }}
  onCacheRollback={(bundle) => {
    console.log('rolled back to', bundle.generationId);
  }}
/>
```

- `onBundleReady` reports the generation shown by the local runtime.
- `onBundleStored` reports a newly installed or revalidated durable generation.
- `onBundleError` reports mirroring failures. A visible remote page or existing local generation
  may still be running.
- `onCacheRollback` reports automatic or explicit rollback.

## Direct WebView mode

Set `durableCacheEnabled={false}` to use the same native WebView without bundle mirroring:

```tsx
<LocalWebView durableCacheEnabled={false} source={{ uri: 'https://game.example.com/' }} />
```

This is useful for A/B measurement. The repository's production benchmark uses this mode as the
direct WebView baseline, so both sides share the same native view implementation and differ only
in delivery strategy.

POST requests, request bodies, custom request headers, non-HTTPS URLs, and inline HTML sources
also use direct mode automatically.

## React Native WebView compatibility

The public props, events, and imperative methods track `react-native-webview@13.16.0`. Native
behavior is implemented directly with `WKWebView` and Android `WebView`.

`nativeConfig.props` can pass additional values to the built-in Nitro view. Replacing the native
component through `nativeConfig.component` is intentionally unsupported because doing so would
bypass the origin-preserving delivery and cache lifecycle.

## CSP and trust boundaries

Content Security Policy is preserved by default. Mirroring fails if loading HTML as a locally
supplied document would silently weaken an active CSP.

Only use `allowContentSecurityPolicyBypass` for content you own and intentionally permit:

```tsx
<LocalWebView allowContentSecurityPolicyBypass virtualUrl="https://game.example.com/" />
```

Cross-origin assets are rejected unless their origins are explicitly trusted:

```tsx
<LocalWebView
  trustedAssetOrigins={['https://cdn.example.com']}
  virtualUrl="https://game.example.com/"
/>
```

Redirect targets are validated one hop at a time. Cached manifests and files are checked with
SHA-256 before activation, and Subresource Integrity metadata is enforced when present.

## Current scope

- iOS and Android are supported.
- The runtime mirrors statically discoverable resources. API responses and URLs assembled only
  from runtime data remain network requests unless the application includes them in its build
  graph.
- Server behavior that depends on a Service Worker should be tested explicitly; the local request
  interceptor is not a Service Worker replacement.

## Development

The repository uses Node 24.15.0 through mise, Nx, tsdown, oxlint, oxfmt, Vitest, and Changesets.

```sh
mise install
yarn install --immutable
yarn check
```

Run `/e2e` on a pull request to execute the macOS ARM64 runner matrix for low-end and current
Android emulators plus an iOS simulator. It compares direct HTTPS loading with the Nitro local
runtime across Unity-sized bundles, offline starts, resource revalidation, CSP, cookies, Range
requests, workers, and no-ETag files.

## License

MIT
