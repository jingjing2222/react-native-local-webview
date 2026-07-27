# react-native-local-webview

[![CI](https://github.com/jingjing2222/react-native-local-webview/actions/workflows/ci.yml/badge.svg)](https://github.com/jingjing2222/react-native-local-webview/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> Run CSR and Unity WebGL bundles from durable local storage without giving up
> their HTTPS origin.

`LocalWebView` mirrors a web application's statically discoverable startup
graph into app-owned storage and runs it in a native WebView at the original
HTTPS URLs. A cache miss does not show an installer or blank loading screen: it
opens the remote HTTPS page immediately, waits for its document load event (or
a bounded fallback), and saves the mirror in the background. That document
keeps running unchanged, and the next mount uses the verified local generation.

It is a Nitro Hybrid View, not a wrapper around the
`react-native-webview` component. `react-native-webview@13.16.0` remains a peer
and the public compatibility contract for props, events, source objects, and
imperative methods.

## Why

`file://` makes storage durable but changes the security origin. Depending only
on WebKit or Chromium cache keeps the origin but gives the app no durability
guarantee.

This package separates the two:

```text
first mount ──▶ remote HTTPS page ──▶ visible immediately
        └────▶ discover + verify ──▶ app storage

later mount ──▶ verified local graph at the original HTTPS URLs
                                            │
                                GET/HEAD ───┴── local
                                unknown/mutating ── network
```

The trade-off is deliberate. This runtime is most useful when a large game must
survive cache eviction or launch fully offline. It is not automatically faster
than a cache-hot WebView: a measured iOS simulator run made a 500 MiB warm graph
17% faster and eliminated its 500 MiB network transfer, while a 50 MiB
cache-hot graph was about 3.7 times slower through local protocol streaming.
The first install also uses roughly twice the network traffic because the
visible remote page and its background durable mirror download independently.
See the [benchmark methodology and snapshot](../../e2e/README.md).

The document still sees:

```js
location.origin; // https://game.example.com
history.pushState({}, '', '/play');
fetch('/api/session'); // normal HTTPS request unless this exact GET is cached
```

## Installation

```sh
yarn add react-native-local-webview react-native-nitro-modules react-native-webview
cd ios && pod install
```

Install one filesystem implementation in the host app. It is intentionally not
a dependency or peer dependency of this package:

```sh
yarn add react-native-blob-util
```

The peer ranges for React, React Native, Nitro Modules, and React Native WebView
are `*`. This repository develops and tests against:

- React Native WebView 13.16.0;
- React Native 0.85.0;
- React Native Nitro Modules 0.36.1;
- iOS 16.4 or newer; and
- Android API 24 or newer.

Windows is not implemented.

If pages request geolocation, camera, or microphone access on Android, declare
the corresponding `ACCESS_FINE_LOCATION`, `CAMERA`, or `RECORD_AUDIO`
permission in the host manifest. The runtime requests declared dangerous
permissions when WebView asks for them. Storage permission for downloads on
Android 9 and older is contributed by this package and requested on demand.

## Quick start

Keep adapter construction next to the component that receives it:

```tsx
import { useMemo } from 'react';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { createReactNativeBlobUtilCacheAdapter, LocalWebView } from 'react-native-local-webview';

export function UnityGame() {
  const cacheAdapter = useMemo(
    () => createReactNativeBlobUtilCacheAdapter(ReactNativeBlobUtil),
    []
  );

  return (
    <LocalWebView
      cacheAdapter={cacheAdapter}
      virtualUrl="https://book.jingjing2222.com/"
      cachePolicy={{
        // Keep this above the complete compressed Unity graph, not only .data.
        maxBytes: 800 * 1024 * 1024,
        maxGenerations: 1,
        maxInlineBytes: 32 * 1024 * 1024,
      }}
      onBundleReady={(bundle) => {
        // Called only when this mount is displaying a local generation.
        console.log(bundle.generationId, bundle.usedCachedBundle);
      }}
      onBundleStored={(bundle) => {
        // First-install download or background revalidation has completed.
        console.log('durable for the next mount', bundle.generationId);
      }}
      onMessage={({ nativeEvent }) => {
        console.log(nativeEvent.data);
      }}
      style={{ flex: 1 }}
    />
  );
}
```

Choose one of the supplied factories:

```ts
createReactNativeBlobUtilCacheAdapter(ReactNativeBlobUtil);
createReactNativeFsCacheAdapter(RNFS, options);
createReactNativeFileAccessCacheAdapter({ Dirs, FileSystem }, options);
createExpoFileSystemCacheAdapter(ExpoFileSystem, options);
```

Or implement `LocalWebViewCacheAdapter` with
`createLocalWebViewCacheAdapter`. The contract includes durable directories,
atomic same-volume moves, hashing, end-exclusive range reads, and abortable
download-to-file.

The React Native FS, File Access, and Expo presets require an app-supplied
downloader because their built-in download APIs follow redirects before the
library can validate every hop. The Blob Util preset includes a bounded
same-origin downloader.

## Runtime architecture

Bundle preparation and cache policy are orchestrated in TypeScript. The chosen
filesystem adapter owns the physical download, file, and hash operations.

After a generation is verified, one Nitro view update sends:

- the prepared entry HTML;
- a compact JSON inventory of canonical HTTPS URL, local path, media type,
  byte size, and the validated runtime response-header subset; and
- WebView configuration derived from React Native WebView props.

No asset bytes are sent through a React Native event or message:

- Android answers `WebViewClient.shouldInterceptRequest` with a
  `WebResourceResponse` backed by `FileInputStream`.
- iOS answers the registered HTTPS `NSURLProtocol` from `FileHandle`.
- `Range` and `HEAD` are handled natively.
- Trusted cross-origin assets retain the CORS/CORP, validator, and timing
  headers required for the browser to accept the synthesized local response;
  mirror requests carry the entry origin, while state-changing headers such as
  `Set-Cookie` are never replayed.
- Android leaves unknown URLs and methods other than GET/HEAD on WebView's
  ordinary network path.
- iOS forwards those requests from `NSURLProtocol` through an ephemeral
  `URLSession`. WebKit omits same-origin asynchronous fetch/XHR upload bodies
  after private HTTPS scheme registration, so a document-start script streams
  those bodies to a native temporary file before dispatch. This communication
  stays between WebKit and native code; it does not cross the React Native
  bridge. Cross-origin requests are not decorated with the internal body token,
  preserving their normal CORS preflight behavior.
- WebView events use a single Nitro JSI callback and are reconstructed as
  React Native-compatible synthetic events in JavaScript.

History remains WebView session history. iOS installs the same document-start
History API notification pattern used by React Native WebView; Android uses
`doUpdateVisitedHistory`. `goBack` and `goForward` operate on the native
back/forward list.

## Source modes

Use exactly one of `virtualUrl` or `source`.

```tsx
// Mirror and run a remote HTTPS graph.
<LocalWebView cacheAdapter={cacheAdapter} virtualUrl="https://game.example.com/" />

// The equivalent React Native WebView source form.
<LocalWebView
  cacheAdapter={cacheAdapter}
  source={{ uri: 'https://game.example.com/' }}
/>

// Ordinary static HTML.
<LocalWebView
  cacheAdapter={cacheAdapter}
  source={{
    baseUrl: 'https://game.example.com/',
    html: '<!doctype html><title>Embedded</title>',
  }}
/>
```

An HTTPS GET `source.uri` without custom headers or body is mirrored. Requests
with headers/body, non-GET requests, non-HTTPS URLs, and file URLs are loaded
as direct React Native WebView-compatible sources.

## React Native WebView compatibility

`LocalWebViewProps` extends the applicable iOS and Android
`WebViewProps` surface from React Native WebView 13.16.0. This includes source
objects, loading/error renderers, navigation policies, JavaScript injection,
user agents, cookies, media, scrolling, downloads, permissions, and
platform-specific settings.

Events:

- `onLoadStart`, `onLoad`, `onLoadEnd`, `onLoadProgress`;
- `onError`, `onHttpError`, and Android `onLoadSubResourceError`;
- `onNavigationStateChange` and `onShouldStartLoadWithRequest`;
- `onMessage`, `onScroll`, and `onOpenWindow`;
- iOS `onContentProcessDidTerminate`, `onFileDownload`, and
  `onCustomMenuSelection`;
- Android `onContentSizeChange` and `onRenderProcessGone`.

The forwarded ref exposes the same ten methods:

```ts
type LocalWebViewHandle = {
  clearCache(includeDiskFiles: boolean): void;
  clearFormData(): void;
  clearHistory(): void;
  goBack(): void;
  goForward(): void;
  injectJavaScript(script: string): void;
  postMessage(message: string): void;
  reload(): void;
  requestFocus(): void;
  stopLoading(): void;
};
```

`LocalWebView.isFileUploadSupported()` is also available.

For compatibility with the 0.0.1 package API, the handle additionally exposes
`getHistoryState()` and `rollback()`. History observations are available through
`onHistoryChange`, while `onCacheRollback` receives the generation selected by
a successful manual rollback.

`nativeConfig.props` is merged into native configuration. Supplying
`nativeConfig.component` replaces the native host by definition, so that
explicit escape hatch selects the bundled `LegacyLocalWebView`/React Native
WebView path. All ordinary usage stays on Nitro and does not instantiate the
React Native WebView component.

The package exports `LegacyLocalWebView` directly for applications that need
the earlier JavaScript asset-stream bridge.

## Package-specific props

| Prop                               | Purpose                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| `cacheAdapter`                     | Host-owned durable file/download/hash implementation                  |
| `virtualUrl`                       | HTTPS entry URL to mirror; mutually exclusive with `source`           |
| `trustedAssetOrigins`              | Additional exact HTTPS origins allowed during static discovery        |
| `allowContentSecurityPolicyBypass` | Explicitly discard incompatible CSP declarations; defaults to `false` |
| `cacheDirectory`                   | Override the origin-specific durable directory                        |
| `cachePolicy`                      | Set byte, generation, and inline-resource limits                      |
| `forceRefresh`                     | Force a background rebuild while any verified current view stays live |
| `onBundleReady`                    | Observe a verified local generation displayed by this mount           |
| `onBundleStored`                   | Observe background installation or revalidation completion            |
| `onBundleError`                    | Observe mirror, validation, or native runtime preparation failures    |
| `onHistoryChange`                  | Observe native URL/back-forward history changes                       |
| `onCacheRollback`                  | Observe a generation selected by `rollback()`                         |
| `sourcePath`                       | Use an existing local entry file together with `virtualUrl`           |

## Discovery and Unity WebGL

HTML is parsed with an HTML5 parser, not a regular expression. The graph
recognizes:

- scripts, stylesheets, preload links, images, media, manifests, objects, and
  `srcset`;
- recursive CSS `@import` and `url(...)`;
- static imports, re-exports, literal dynamic imports, workers,
  `importScripts`, and URL-bearing `new URL(...)`;
- literal fetch/XHR URLs and common Unity configuration fields;
- WASM, `.data`, `.framework.js`, `.unityweb`, symbols, and streaming assets.

Small resources can be materialized into the prepared document. Large files
remain in the active generation and are served by the native range path. A
normal Unity WebGL output therefore uses the same mechanism:

```text
index.html
Build/game.loader.js
Build/game.framework.js[.br|.gz|.unityweb]
Build/game.data[.br|.gz|.unityweb]
Build/game.wasm[.br|.gz|.unityweb]
StreamingAssets/...
```

Runtime-computed URLs that cannot be proven statically fall through to the
network. Assets that must work fully offline need a discoverable reference or
an application-defined catalog represented in the startup graph.

The native response supports one byte range per request. Multithreaded Unity
builds still require `SharedArrayBuffer` and cross-origin isolation support
from the target WebView and server policy; this package does not synthesize
COOP/COEP.

## Revalidation and integrity

Each cached resource records its canonical URL, response URL, media type, byte
size, ETag, and SHA-256 digest. SRI is validated before transformations.

On a later mount:

1. Every resource with an ETag is requested with `If-None-Match`.
2. `304` reuses verified bytes for that resource.
3. A changed resource rebuilds the complete generation.
4. A resource without an ETag is downloaded and hashed again.
5. The active state pointer changes only after all files and the manifest are
   complete.
6. Corrupt or incomplete generations are rejected.
7. A refresh/network failure can reuse the last verified retained generation.

Generations are bounded by `maxBytes` and `maxGenerations`; defaults are
512 MiB and two generations. Mounted generations are leased so pruning cannot
delete a file while native code may still stream it.

This is a local integrity and crash-consistency model, not publisher
authentication. The package does not require a signed web-build manifest.

## Security boundary

`virtualUrl` is privileged configuration: downloaded JavaScript executes with
that origin's authority. Use owned HTTPS origins and a restrictive
`originWhitelist`. Additional asset origins must be named explicitly in
`trustedAssetOrigins`; redirects are revalidated at every hop.

The package cannot faithfully preserve arbitrary response security headers
when it synthesizes a local HTTPS response. Therefore an entry or worker
`Content-Security-Policy`/report-only header, or an effective CSP meta tag,
rejects mirroring by default. `allowContentSecurityPolicyBypass` removes the
policy only after an explicit opt-in, and that choice is part of the cache
generation fingerprint.

Local interception validates the recorded file size and only handles GET/HEAD.
A POST, PUT, PATCH, or DELETE that happens to use the same URL as a cached
asset is sent to the network. On iOS, same-origin asynchronous fetch and XHR
bodies are spooled to a bounded temporary file because the private WebKit
scheme hook otherwise drops them.

## iOS private API warning

iOS keeps the HTTPS origin by registering `https` with `NSURLProtocol` through
the private
`WKBrowsingContextController registerSchemeForCustomProtocol:` selector.

That distinction matters:

- the mechanism works in the simulator and is technically usable on physical
  devices where the SPI is present;
- it is not a public WebKit contract and may change between OS releases; and
- App Store review can reject binaries that use private API.

Treat iOS as a benchmark/PoC or non-App-Store distribution path until a public
interception mechanism replaces it. Android uses only public WebView APIs.

HTTPS protocol and `URLProtocol` registration are process-wide. While a local
view is mounted, Foundation/WebKit requests to one of its registered origins
can traverse this package's forwarding path. Concurrent iOS views targeting the
same exact resource URL should use the same active generation; running
different generations of one origin simultaneously is not supported. The hook
is reference-counted and removed after the last local view is dropped when the
matching private unregister selector is available.

## Verification

The unit suite extracts the exact own-property inventories from the installed
React Native WebView 13.16.0 TypeScript declarations, preventing a newly
missing prop from silently passing review.

The Release showcase E2E individually mounts and completes:

- all 60 applicable Android props on current and low-resource emulators; and
- all 73 applicable iOS props on a simulator.

Grouped semantic cases verify origin/history, both injection phases, frame
targeting, messages, synthetic event methods, navigation blocking, popups,
scrolling, all imperative methods, JavaScript disabling, Basic Auth, HTTP and
subresource errors, downloads, user agents, DOM storage, loading/error
renderers, GET/HEAD-only local interception, and native 206 Range responses.
The method-routing case also proves that same-origin fetch and asynchronous XHR
POST bodies reach the server instead of being served from a cached URL.

```sh
yarn e2e:props:android:latest
yarn e2e:props:android:low
yarn e2e:props:ios
```

The larger manual suite covers 50/200/500 MiB Unity graphs, warm/offline starts,
100/500/1,000-resource revalidation, ETag-free files, cookies, ranges, workers,
and the explicit CSP rejection/bypass path. It runs the same fixtures first as a
plain remote `react-native-webview` and then as the Nitro local runtime, producing
side-by-side page-ready, background-storage, network, offline, and memory
metrics. See
[`../../e2e/README.md`](../../e2e/README.md).

## Development and release

```sh
mise install
mise exec -- corepack yarn install --immutable
mise exec -- corepack yarn check
```

Node 24.15.0 is pinned by mise. `tsdown` with `exports: true` owns the package
output and export map. `oxfmt` and type-aware `oxlint` own formatting and
linting.

Add a Changeset for a package change:

```sh
yarn changeset
```

The **Release** GitHub Actions workflow manages the Changesets version PR and
publishes through npm OIDC after that PR is merged.

## License

MIT
