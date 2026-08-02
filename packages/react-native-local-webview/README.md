# react-native-local-webview

Run CSR and Unity WebGL bundles from durable local storage without giving up their HTTPS origin.

`LocalWebView` displays the real remote page on a first visit, installs a
complete local bundle in the background, and uses that bundle on later visits.
The page keeps its original HTTPS URL, secure context, cookies, CORS behavior,
History API, workers, WASM, and Range requests.

## Installation

```sh
yarn add react-native-local-webview react-native-nitro-modules
```

Then install iOS pods:

```sh
cd ios && pod install
```

Requirements:

- React Native New Architecture
- iOS 16.4 or newer
- Android API 24 or newer
- `react-native-nitro-modules`

React, React Native, and Nitro are peer dependencies with `*` ranges so your
application remains responsible for selecting compatible versions.

## Basic usage

```tsx
import { LocalWebView } from 'react-native-local-webview';

export function Game() {
  return (
    <LocalWebView
      source={{ uri: 'https://game.example.com/' }}
      validationMode="release-etag"
      onMessage={({ nativeEvent }) => {
        console.log(nativeEvent.data);
      }}
      onBundleStored={(bundle) => {
        console.log('Offline generation ready:', bundle.generationId);
      }}
      onBundleError={(error) => {
        console.error('Could not store this release:', error);
      }}
      style={{ flex: 1 }}
    />
  );
}
```

Use `source={{ uri }}` when migrating an existing WebView. Use `virtualUrl`
when the component is dedicated to a single remote entry:

```tsx
<LocalWebView
  virtualUrl="https://game.example.com/"
  validationMode="release-etag"
  style={{ flex: 1 }}
/>
```

Do not pass both `source` and `virtualUrl`.

## Choose a validation mode

### Release ETag

`validationMode="release-etag"` gives the fastest predictable warm path. The
entry response must include an ETag that represents the complete release, not
only `index.html`:

```http
ETag: "game-release-2026-08-03.1"
```

Change this value whenever any captured HTML, JavaScript, CSS, worker, WASM, or
Unity data file changes. On later starts:

- one `If-None-Match` request checks the release;
- `304 Not Modified` keeps the active local generation;
- a successful `200` installs the new release for the next mount;
- a missing ETag reports an error and does not publish an unverifiable generation.

### Content hash

`validationMode="content-hash"` is the default. Use it when your infrastructure
cannot provide a release-wide ETag. It revalidates resources individually and
may read local payloads again, so large bundles and high resource counts have a
more expensive warm path.

## What users experience

### First visit

The remote HTTPS page becomes visible immediately. Bundle installation runs in
the background, and `onBundleStored` fires only after a complete generation is
available for later offline use.

### Warm visit

The last complete generation starts from local storage. A release check happens
behind the visible page. A changed release is installed atomically and becomes
available on the next mount.

### Offline visit

The last complete generation starts without waiting for the network. A failed
background update check does not delete it.

### Failed local generation

If local loading fails, the component can roll back to the previous complete
generation or use the remote document. Observe these transitions with
`onCacheRollback` and `onBundleError`.

## Supported web content

The bundle collector supports:

- module scripts, static imports, and dynamic imports;
- stylesheets, CSS imports, `url(...)`, `src`, and `srcset`;
- preload and module-preload resources;
- Web Workers and worker module graphs;
- WebAssembly URLs;
- Unity loader, framework, `.data`, and `.wasm` files.

Large assets remain as files and support complete and single byte-range
responses. Runtime `fetch()` calls that are not part of the captured graph keep
using the real network.

## Origin and History API

Even when the response bytes come from local storage, the document URL remains
the original HTTPS URL. This preserves:

- `location.origin` and `isSecureContext`;
- relative URL resolution;
- cookies, storage, CORS, and same-origin browser checks;
- `pushState`, `replaceState`, `back`, `forward`, and `go`.

Observe SPA history separately from the WebView back-forward list:

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
        console.log(history.url, history.canGoBack, history.canGoForward);
      }}
    />
  );
}
```

The handle also provides `goBack`, `goForward`, `reload`, `stopLoading`,
`injectJavaScript`, `postMessage`, `clearCache`, `clearHistory`,
`clearFormData`, `requestFocus`, `getHistoryState`, and `rollback`.

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

| Option           | Meaning                                    | Default |
| ---------------- | ------------------------------------------ | ------: |
| `maxBytes`       | Maximum retained bytes for one origin      | 512 MiB |
| `maxGenerations` | Complete generations retained for rollback |       2 |
| `maxInlineBytes` | Largest parser-required text/base64 asset  |  32 MiB |

Downloads stop when a declared or observed response exceeds the configured
limit. A mounted generation is not removed while the WebView is using it.

The default origin-scoped directory is recommended. Set `cacheDirectory` only
when your application needs to control placement:

```tsx
<LocalWebView
  cacheDirectory="/application-owned/persistent/path/game"
  virtualUrl="https://game.example.com/"
/>
```

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

await resolveWebBundle({
  virtualUrl: url,
  forceRefresh: true,
  validationMode: 'release-etag',
});
await rollbackWebBundle(directory);
await clearLocalWebViewCache(url);
```

`resolveWebBundle` runs the same installation and validation lifecycle as the
component without mounting a WebView.

## Bundle events

```tsx
<LocalWebView
  virtualUrl="https://game.example.com/"
  onBundleReady={(bundle) => {
    console.log('Displayed generation:', bundle.generationId);
  }}
  onBundleStored={(bundle) => {
    console.log('Durable generation:', bundle.generationId);
  }}
  onCacheRollback={(bundle) => {
    console.log('Rolled back to:', bundle.generationId);
  }}
  onBundleError={(error) => {
    console.error(error);
  }}
/>
```

- `onBundleReady` reports the local generation selected for display.
- `onBundleStored` reports a newly installed or revalidated generation.
- `onCacheRollback` reports automatic or explicit rollback.
- `onBundleError` reports installation and validation failures. The visible
  remote page or an existing local generation may still be usable.

## Direct WebView behavior

Disable durable mirroring without changing components:

```tsx
<LocalWebView durableCacheEnabled={false} source={{ uri: 'https://game.example.com/' }} />
```

POST requests, request bodies, custom request headers, non-HTTPS URLs, and
inline HTML sources also use direct mode automatically.

The public props, events, and imperative methods track
`react-native-webview@13.16.0`. `nativeConfig.props` can pass extra values to
the built-in view. Replacing the component through `nativeConfig.component` is
not supported because it would bypass the origin-preserving cache lifecycle.

## Security and trust

Only absolute HTTPS entries are mirrored. Cross-origin assets are rejected
unless explicitly allowed:

```tsx
<LocalWebView
  virtualUrl="https://game.example.com/"
  trustedAssetOrigins={['https://cdn.example.com']}
/>
```

Redirects are validated one hop at a time. Subresource Integrity metadata is
enforced when present. Content Security Policy is preserved by default.

Use `allowContentSecurityPolicyBypass` only for content you own and intentionally
permit to run without its original CSP:

```tsx
<LocalWebView allowContentSecurityPolicyBypass virtualUrl="https://game.example.com/" />
```

## Current limitations

- iOS and Android are supported.
- Only statically discoverable resources are mirrored. URLs assembled solely
  from runtime data stay online.
- The request interceptor is not a Service Worker replacement.
- First installation downloads the visible page and durable bundle in parallel,
  so it intentionally uses more traffic than direct loading alone.

For repository internals and validation workflows, see
[CONTRIBUTING.md](../../CONTRIBUTING.md).

## License

MIT
