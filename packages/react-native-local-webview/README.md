# react-native-local-webview

[![CI](https://github.com/jingjing2222/react-native-local-webview/actions/workflows/ci.yml/badge.svg)](https://github.com/jingjing2222/react-native-local-webview/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node 24.15.0](https://img.shields.io/badge/node-24.15.0-339933.svg)](../../mise.toml)

> Run CSR and Unity WebGL bundles from durable local storage without giving up
> their HTTPS origin.

`react-native-local-webview` mirrors a site's statically discoverable resource
graph into persistent application storage, then runs the mirrored bundle
through `react-native-webview` as its original HTTPS site. The files are local;
`location.origin`, same-origin URLs, CORS behavior, and browser history still
belong to the public origin.

```tsx
<LocalWebView cacheAdapter={cacheAdapter} virtualUrl="https://book.jingjing2222.com/" />
```

## Why this exists

The two obvious approaches each give up something important:

- Leaving everything to WebKit or Chromium keeps normal web semantics, but its
  cache can be evicted independently of the application.
- Loading a downloaded site with `file://` makes storage explicit, but changes
  the origin and complicates CORS, routing, workers, WASM, and runtime fetches.

This package separates storage from the browsing context:

```text
remote HTTPS site ── mirror + revalidate ──▶ durable app storage
        │                                      │
        └── HTTPS origin ──▶ WebView ◀── local bundle
```

After the first successful mirror, the page shell and its discovered static
dependencies can start from local files. URLs absent from the local inventory
continue through normal WebView networking, so runtime API requests and
statically unknowable assets are not forced into an offline-only model.

## What stays intact

- The configured HTTPS `location.origin`, instead of `file://`.
- WebView session history for CSR routing and native back navigation.
- Normal network and CORS behavior for URLs that are not locally mirrored.
- Standard `react-native-webview` props and imperative methods.

## What becomes durable

- The discovered HTML, JavaScript, CSS, image, worker, WASM, and WebGL resource
  graph.
- Per-resource ETag and SHA-256 revalidation, including assets whose URLs did
  not change.
- Atomic cache generations, bounded retention, and rollback to a retained
  verified generation.
- Local streaming for large `.data` and `.wasm` files used by WebGL builds.

The primary target is a CSR application or Unity WebGL game whose startup files
must survive WebView cache eviction without pretending that the whole web
runtime is a filesystem.

`react-native-local-webview` is a TypeScript package. It ships no iOS or Android
native module, and it has no filesystem package in either `dependencies` or
`peerDependencies`. Your application supplies one provider-neutral
`LocalWebViewCacheAdapter`.

## Installation

```sh
yarn add react-native-local-webview react-native-webview@13.16.0
```

The peer ranges for React, React Native, and React Native WebView are `*`, so
the host application owns version selection. Development and the example app
pin `react-native-webview@13.16.0`.

## Quick start

The ready-to-run preset uses `react-native-blob-util`. It is installed by the
application, not by this package:

```sh
yarn add react-native-blob-util
```

Create the cache adapter next to the `LocalWebView` that receives it. Memoizing
keeps the cache adapter identity stable across renders:

```tsx
import { useMemo } from 'react';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { createReactNativeBlobUtilCacheAdapter, LocalWebView } from 'react-native-local-webview';

export function BookApp() {
  const cacheAdapter = useMemo(
    () => createReactNativeBlobUtilCacheAdapter(ReactNativeBlobUtil),
    []
  );

  return (
    <LocalWebView
      cacheAdapter={cacheAdapter}
      virtualUrl="https://book.jingjing2222.com/"
      cachePolicy={{
        maxBytes: 512 * 1024 * 1024,
        maxGenerations: 2,
        maxInlineBytes: 32 * 1024 * 1024,
      }}
      onBundleReady={(bundle) => {
        console.log(
          bundle.usedCachedBundle ? 'local generation' : 'new generation',
          bundle.generationId
        );
      }}
      style={{ flex: 1 }}
    />
  );
}
```

The repository example uses exactly that co-located setup and can mirror
`book.jingjing2222.com` without editing a placeholder.

The preset sends a bounded HTTP Range request for each download. A server must
either honor that Range or return a valid `Content-Length`; an unbounded
length-unknown response is rejected. Pass `download` to the preset to replace
that policy for infrastructure with a different trusted downloader.

### Why a cache adapter is required

React Native does not provide a standard JavaScript API for durable arbitrary
files, atomic moves, partial file reads, or download-to-file. Those operations
are required to commit complete cache generations and stream large WebGL assets
without loading an entire file into JavaScript memory.

Keeping the bundle only in the WebView's Cache Storage or IndexedDB would also
put it back under WebKit/Chromium storage quotas and eviction. It would not be
available until the WebView had started, either. The cache adapter therefore
puts durability under the host application's control.

No filesystem package is a dependency or peer dependency of
`react-native-local-webview`. Presets receive the already imported module from
the application:

```ts
import RNFS from 'react-native-fs';
import { Dirs, FileSystem } from 'react-native-file-access';
import * as ExpoFileSystem from 'expo-file-system';
import {
  createExpoFileSystemCacheAdapter,
  createReactNativeFileAccessCacheAdapter,
  createReactNativeFsCacheAdapter,
} from 'react-native-local-webview';

const withExpo = createExpoFileSystemCacheAdapter(ExpoFileSystem, {
  download: appDownloader.downloadToFile,
});

const withRnfs = createReactNativeFsCacheAdapter(RNFS, {
  download: appDownloader.downloadToFile,
});

const withFileAccess = createReactNativeFileAccessCacheAdapter(
  { Dirs, FileSystem },
  { download: appDownloader.downloadToFile }
);
```

The `expo-file-system`, `react-native-fs`, and `react-native-file-access`
presets require the application's downloader because those libraries'
built-in downloaders follow redirects. The core must inspect each redirect
before requesting it.

The Blob Util preset's default range reader uses native `slice`, reads the
slice, and deletes its temporary file. That is a convenient CSR default, but
large Unity `.data` files should pass a direct positional `readFileRange`
implementation or use the React Native FS/File Access preset to avoid extra
temporary-file I/O while streaming.

For an in-house provider, use `createLocalWebViewCacheAdapter`. It supplies
whole-file reads, small state-file copies, and incremental SHA-256/384/512
hashing when the host does not provide optimized implementations.

The resulting `LocalWebViewCacheAdapter` contract covers:

- persistent Documents storage;
- recursive directory creation and removal;
- whole-file reads and writes, atomic same-volume moves, and file copies;
- SHA-256, SHA-384, and SHA-512 file hashing, preferably through native or
  single-pass I/O;
- end-exclusive byte-range reads for bounded streaming, preferably through
  direct positional I/O; and
- abortable, no-auto-follow HTTPS downloads to a file.

The generic factory cannot safely implement `readFileRange` or `download` with
ordinary React Native `fetch`: doing so would buffer large Unity files in
JavaScript and would not guarantee redirect or byte-limit enforcement. Those
two operations must remain backed by host capabilities.

`LocalWebView` accepts the usual `react-native-webview` props except `source`.
Bundle preparation owns the loading and error states, so their render callbacks
receive a status string or an `Error`:

```tsx
<LocalWebView
  cacheAdapter={cacheAdapter}
  virtualUrl="https://app.example.com/"
  renderLoading={(status) => <LoadingScreen label={status} />}
  renderError={(error) => <FailureScreen error={error} />}
/>
```

## How the origin stays real

The cache is not exposed to the WebView as a `file://` URL.

```text
HTTPS entry + static graph
          │
          ▼
  parse, hash, and verify the discovered inventory
          │
          ├── index.html (small assets localized)
          └── assets/<sha256> (large runtime files)
                         │
                         ▼
WebView source={{ html, baseUrl: "https://app.example.com/" }}
                         │
                         └── fetch/XHR bridge streams verified local files
```

The localized HTML uses data URLs, inline CSS, an import map, and a local stream
bridge. Native file paths are never exposed to page code. The WebView receives
`source={{ html, baseUrl }}`, where `baseUrl` is the final validated,
same-origin entry response URL. Entry redirects may change the path used to
resolve relative references, but they cannot change the configured origin.
Consequently:

```js
location.origin; // "https://app.example.com"
fetch('/api/me'); // live request to https://app.example.com/api/me
```

Only URLs in the verified local inventory are intercepted. API requests, user
content loaded at runtime, and every unknown URL continue to use normal WebView
networking and CORS rules.

Native mirroring is same-origin by default. If the static graph uses an owned
CDN, opt that exact HTTPS origin in:

```tsx
<LocalWebView
  cacheAdapter={cacheAdapter}
  virtualUrl="https://app.example.com/"
  trustedAssetOrigins={['https://static.example-cdn.com']}
/>
```

Cross-origin references that are not trusted stay in the document and use the
WebView's normal network and CORS path. Trusted origins and every redirect are
checked before the native request is made.

## What is mirrored

HTML is parsed and serialized with an HTML5 parser; it is never split with an
HTML regular expression. The resource graph includes:

| Source     | Localized references                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| HTML       | scripts, stylesheets, icons, manifests, preloads, images, media, objects, `srcset`, inline styles                                              |
| JavaScript | static imports, re-exports, literal `import()`, module and classic workers, `importScripts`, `new URL(...)`, and URL-bearing asset expressions |
| CSS        | recursive `@import` and `url(...)` dependencies                                                                                                |

The test suite includes representative `index.html` fixtures for all 16 static
CSR template families in the pinned `create-vite` catalog, plus deliberately
unusual valid HTML, dynamic chunks, workers, WASM, CSS graphs, and `srcset`.
There is no Vite integration or Vite-specific public API; the templates are
fixtures for the generic localization mechanism.

Subresource Integrity is checked against the downloaded bytes before a script
is transformed. For a statically discoverable programmatic `<script>`, the
runtime materializer validates the element's strongest SRI digest against the
original bytes and only then removes `integrity` before assigning the local
Blob URL.

## Unity WebGL and other large WebGL bundles

Unity WebGL uses ordinary browser primitives, so it does not need a
vendor-specific cache adapter. A conventional output works through the same
generic pipeline:

```text
index.html
Build/game.loader.js
Build/game.data[.gz|.br|.unityweb]
Build/game.framework.js[.gz|.br|.unityweb]
Build/game.wasm[.gz|.br|.unityweb]
StreamingAssets/...
```

- The loader and page shell are localized during bundle preparation.
- `.data`, `.wasm`, memory, and symbols files stay as verified files in the
  active cache generation and are streamed through the local bridge.
- A discovered executable `.framework.js` file (including an HTTP-decoded
  `.br`/`.gz` response) is embedded as a local data URL for a dynamically
  created `<script>`.
- `.framework.js.unityweb` remains a verified bridge URL, allowing Unity's
  decompression-fallback loader to fetch and decode it before execution.
- Standard `fetch` and asynchronous `XMLHttpRequest` requests for inventory
  URLs receive streamed local `Response` bodies.
- Uncompressed or HTTP-decoded WASM keeps `application/wasm`, so
  `WebAssembly.instantiateStreaming(fetch(url), imports)` remains usable.
- Decompression-fallback `.unityweb` responses keep
  `application/octet-stream` until the Unity loader decodes them.
- Module workers, classic/shared workers with recursive `importScripts`,
  literal dynamic imports, and literal `new URL(..., import.meta.url)`
  references use the same graph.
- A localized `SharedWorker` is shared only among callers that reuse its
  materialized URL inside one WebView document. Separate WebView documents
  create separate Blob URLs, so cross-document SharedWorker identity is not
  preserved by this JavaScript-only mechanism.
- Module-worker graphs may contain static, self, or literal dynamic-import
  cycles. The browser build of Rollup 2.80.0 is a runtime dependency and is
  invoked only for a reachable cyclic graph; it emits one local ESM entry while
  preserving ESM live bindings, evaluation order, dynamic-import identity, and
  top-level `await`. Metro may still package Rollup in the initial application
  bundle.
- Requests absent from the local inventory fall through to the network. This
  includes normal runtime APIs.

The crawler statically evaluates immutable strings only in concrete
URL-bearing contexts such as imports, fetches, workers, `new URL(...)`, direct
`.src`/`.href` sinks, and recognized WebGL configuration fields such as
`codeUrl`, `dataUrl`, `frameworkUrl`, `loaderUrl`, `memoryUrl`, `symbolsUrl`,
and `streamingAssetsUrl`. Arbitrary suffix-matching application fields such as
`avatarUrl` and display strings such as `"report.json"` are left untouched.
This includes the standard Unity template fields and expressions such as
`buildUrl + "/game.wasm"`.
Runtime-computed paths under `StreamingAssets`, Addressables, asset bundles, or
application-defined download catalogs cannot always be inferred from source.
Those requests use the WebView's normal network path. Files that must be
available offline need a statically discoverable reference in the HTML,
JavaScript, CSS, or WebGL configuration consumed during localization.

For deterministic offline behavior, use Unity's decompression fallback output
(`.unityweb`) or serve identity bytes. A native response that still carries
`Content-Encoding: br` or `gzip` is rejected instead of being mislabeled and
fed to `WebAssembly`. When the platform HTTP stack has already decoded a
response and removed that header, the decoded representation is cached and
hashed.

Multithreaded WebGL builds additionally depend on the host WebView providing
`SharedArrayBuffer` and cross-origin isolation. Those are platform response
header capabilities and cannot be created by this JavaScript-only package.
Use a non-threaded build unless the target WebViews independently satisfy those
requirements.

## Refresh, generations, and rollback

Every fetched resource records its URL, media type, byte size, ETag,
security-relevant response metadata, and SHA-256 digest. Redirects are followed
manually, with HTTPS and trusted-origin validation at every hop.

On a later mount:

1. Every resource is revalidated with its own `If-None-Match` value.
2. A `304` reuses the already verified bytes for that resource.
3. A changed ETag causes a complete graph refresh, even when the URL stayed the
   same.
4. If an asset has no ETag, a `200` is hashed and unchanged bytes reuse the
   current generation.
5. The existing generation is reused only when all revalidated resource
   metadata and bytes still match.
6. Any detected change rebuilds the complete graph as a new generation.
7. A network or refresh failure returns the last locally verified generation,
   when one exists.

A generation is written completely before `state.json` points at it. Local HTML
is re-hashed before use; a corrupt active generation falls back to another
valid retained generation. The default policy keeps unleased generations to at
most two within a shared 512 MiB budget per origin. A mounted WebView lease may
temporarily retain an older generation beyond either limit so an in-flight
stream is never deleted; releasing the lease immediately makes it eligible for
pruning. Increase `maxBytes` if two complete game generations must coexist for
rollback.

Resources that must become data URLs are capped at 32 MiB each by default.
`maxInlineBytes` prevents a large media element or other inline-only resource
from expanding into a much larger HTML string. Unity `.data` and `.wasm`
artifacts use the file-stream bridge and are not subject to that inline limit.

```tsx
const webView = useRef<LocalWebViewHandle>(null);

<LocalWebView
  cacheAdapter={cacheAdapter}
  ref={webView}
  virtualUrl="https://app.example.com/"
  onCacheRollback={(bundle) => console.log('rolled back', bundle.generationId)}
/>;

await webView.current?.rollback();
```

`LocalWebView` attempts one automatic rollback only when the initial
same-origin main-frame load of a newly activated local document fails and a
previous generation exists.

## History and native back navigation

The injected bridge observes the browser's real History API. It wraps
`pushState` and `replaceState` only to report changes; it does not replace
`back`, `forward`, `go`, `length`, `state`, or scroll restoration. This keeps
CSR routing in the WebView session-history stack and enables the iOS
back/forward swipe gesture by default. `canGoBack` and `canGoForward` come from
the native `react-native-webview` event, so hash-created entries and duplicate
URLs are not guessed by a separate JavaScript stack.

```tsx
const ref = useRef<LocalWebViewHandle>(null);
const [history, setHistory] = useState<LocalWebViewHistoryState>();

<LocalWebView
  ref={ref}
  cacheAdapter={cacheAdapter}
  virtualUrl="https://app.example.com/"
  onHistoryChange={setHistory}
/>;

if (history?.canGoBack) ref.current?.goBack();
```

Use that pattern from an Android hardware-back handler. Reserved bridge
messages are consumed internally; ordinary `onMessage` traffic is forwarded to
your callback.

## Component API

Additional `LocalWebView` props:

| Prop                               | Purpose                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `cacheAdapter`                     | Required host file, hashing, and abortable download implementation        |
| `virtualUrl`                       | Required public HTTPS entry URL and virtual origin                        |
| `trustedAssetOrigins`              | Additional public HTTPS origins allowed through native mirroring          |
| `allowContentSecurityPolicyBypass` | Permit entry/Worker CSP and report-only removal; defaults to `false`      |
| `cacheDirectory`                   | Override the origin-specific Documents directory                          |
| `cachePolicy`                      | Set `maxBytes`, `maxGenerations`, and `maxInlineBytes`                    |
| `forceRefresh`                     | Rebuild without first reusing a matching generation                       |
| `sourcePath`                       | Skip discovery and open existing local HTML with `virtualUrl` as its base |
| `onBundleReady` / `onBundleError`  | Observe bundle preparation                                                |
| `onCacheRollback`                  | Observe automatic or imperative rollback                                  |
| `onHistoryChange`                  | Observe browser and native navigation state                               |
| `renderLoading` / `renderError`    | Replace preparation UI                                                    |

The forwarded `LocalWebViewHandle` exposes `goBack`, `goForward`, `reload`,
`stopLoading`, `injectJavaScript`, `getHistoryState`, and `rollback`.

Lower-level exports are available for custom composition:
`resolveWebBundle`, `readMirroredWebBundle`, `retainWebBundle`,
`rollbackWebBundle`, and `cacheDirectoryForOrigin`.
`MirroredWebBundle.localAssets` reports the verified streamable inventory
without exposing those paths inside the WebView.

Acquire a generation lease before handing its HTML or asset inventory to a
custom WebView, then release it only after that WebView has stopped using the
generation:

```ts
const bundle = await resolveWebBundle({ cacheAdapter, virtualUrl });
const cacheDirectory = cacheDirectoryForOrigin(virtualUrl, cacheAdapter);
const release = retainWebBundle(cacheDirectory, bundle.generationId);

try {
  const html = await readMirroredWebBundle(bundle.sourcePath, cacheAdapter);
  // Keep `release` for the lifetime of the WebView using `html` and
  // `bundle.localAssets`.
} catch (error) {
  release();
  throw error;
}

// Call this after the WebView is unmounted or switches generations.
release();
```

`LocalWebView` manages this lease automatically.

## Platform requirements

- The target WebView must support import maps, `Response`, `ReadableStream`,
  and asynchronous XHR. Localized ES-module applications cannot run on a
  system WebView without import-map support.
- iOS uses only public `WKWebView` behavior exposed by
  `react-native-webview`; the mechanism is the same on physical devices and
  simulators.
- Android uses the installed Android System WebView through
  `react-native-webview`, so capability depends on the WebView version shipped
  or updated on the device.
- Persistent generations default to the cache adapter's Documents directory
  and may be moved with `cacheDirectory`. Interrupted downloads use a staging
  directory inside that cache root and are reclaimed on the next resolve.

Treat `virtualUrl` as privileged configuration. Downloaded JavaScript runs with
that origin's authority. Use owned HTTPS origins and a navigation allowlist.
CSP is never discarded silently: an entry `Content-Security-Policy` or
`Content-Security-Policy-Report-Only` header, an effective
`<meta http-equiv="content-security-policy">`, or either header on a
Worker/SharedWorker root response rejects localization by default.
Set `allowContentSecurityPolicyBypass` only after deciding that replacing that
policy with the local bridge is acceptable. This choice and the trusted-origin
set are part of the cache-generation policy, so a permissive generation cannot
be reused or rolled back into a stricter mount.

The example uses `createReactNativeBlobUtilCacheAdapter`, targets
`book.jingjing2222.com`, and enables that option explicitly because the origin
sends a CSP that intentionally excludes the inline and data-URL sources used
by localization.

Statically unknowable URLs—such as a worker path assembled from arbitrary
runtime input—cannot be discovered by crawling alone. Express deploy-time asset
references as normal module imports, literal `import()`, `new URL(...)`,
HTML/CSS references, or let those requests use the network.

## Development

The repository pins Node.js 24.15.0 with mise:

```sh
mise install
mise exec -- corepack yarn install --immutable
mise exec -- corepack yarn check
```

`tsdown` is the package build source of truth. Its `exports: true` setting owns
the export map written to `package.json`; the JavaScript, source maps,
declarations, and declaration maps are emitted under `dist/`. Formatting and
linting use `oxfmt` and type-aware `oxlint`.

Run the showcase from the repository root:

```sh
mise exec -- corepack yarn showcase ios
# or
mise exec -- corepack yarn showcase android
```

The showcase mirrors `https://book.jingjing2222.com/`.

## Releasing

Add a Changeset with the package change:

```sh
yarn changeset
```

After that change reaches `main`, the **Release** workflow creates or updates
the Changesets version pull request. Merge that pull request when the package
is ready to publish. The next `main` run builds the package and runs
`changeset publish`.

npm publishing uses GitHub Actions OIDC trusted publishing through the
**Release** workflow and does not require an npm token. The initial Changeset
advances `0.0.1` to `0.0.2`.

## License

MIT
