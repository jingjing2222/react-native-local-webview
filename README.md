# react-native-local-webview

[![CI](https://github.com/jingjing2222/react-native-local-webview/actions/workflows/ci.yml/badge.svg)](https://github.com/jingjing2222/react-native-local-webview/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/react-native-local-webview.svg)](https://www.npmjs.com/package/react-native-local-webview)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node 24.15.0](https://img.shields.io/badge/node-24.15.0-339933.svg)](./mise.toml)

> Run CSR and Unity WebGL bundles from durable local storage without giving up
> their HTTPS origin.

`LocalWebView` is a Nitro-powered iOS and Android WebView runtime for apps that
need large web bundles to keep working after the operating system evicts its
normal HTTP cache.

It opens the real remote page immediately on a cold install, saves a complete
verified generation in the background, and starts from local files on later
launches. The page still sees its original HTTPS URL, origin, cookies, CORS,
History API, workers, WASM, and Range requests.

```text
first mount ──▶ remote HTTPS page ──▶ visible immediately
        └────▶ native download + hash ──▶ durable generation

warm/offline mount ──▶ verified local files ──▶ original HTTPS browsing context
```

Large response bodies, file copies, ranges, and SHA-2 hashing stay native. They
do not cross the React Native bridge.

## Install

```sh
yarn add react-native-local-webview react-native-nitro-modules
cd ios && pod install
```

Requirements:

- React Native New Architecture
- iOS 16.4+
- Android API 24+

## Use

```tsx
import { LocalWebView } from 'react-native-local-webview';

export function Game() {
  return (
    <LocalWebView
      source={{ uri: 'https://book.jingjing2222.com/' }}
      cachePolicy={{
        maxBytes: 800 * 1024 * 1024,
        maxGenerations: 2,
        maxInlineBytes: 4 * 1024 * 1024,
      }}
      onBundleStored={(bundle) => {
        console.log('durable generation', bundle.generationId);
      }}
      style={{ flex: 1 }}
    />
  );
}
```

`virtualUrl="https://…"` is also available for components dedicated to one
entry. Do not pass `virtualUrl` and `source` together.

## Why this is different from WebView cache

|                 | Normal WebView cache         | LocalWebView                           |
| --------------- | ---------------------------- | -------------------------------------- |
| Eviction        | Controlled by the OS         | App-owned persistent files             |
| Offline release | Independent cached responses | Atomic verified generation             |
| First install   | Remote page                  | Same remote page, mirror in background |
| Warm start      | Cache policy dependent       | Verified local generation              |
| Page origin     | HTTPS                        | Same HTTPS origin                      |
| Large-file path | WebView network stack        | Native file stream                     |
| Revalidation    | Browser-defined              | Per-resource ETag and SHA-256          |
| Rollback        | None                         | Previous complete generation           |

This runtime is for durable availability and predictable release ownership.
It is not expected to beat an already-hot WebView HTTP cache on every page.

## Unity WebGL and CSR support

The graph collector parses production HTML, CSS, and JavaScript and handles:

- module scripts and static or dynamic imports
- stylesheets, CSS imports, `url(...)`, `src`, and `srcset`
- preload and module-preload resources
- Web Workers and worker module graphs
- WebAssembly
- Unity loader, framework, `.data`, and `.wasm` files

Large artifacts remain as files. Native interception serves complete and
single-range responses directly to WebKit or Android WebView. Runtime API
requests that are not part of the mirrored graph continue through the real
HTTPS network.

## Cache lifecycle

On a cold install, the current remote document becomes visible before the
mirror completes. `onBundleStored` marks the point at which the new generation
is durable.

On a warm start, the verified local generation is shown first. Every resource
with an ETag is conditionally requested. A resource without an ETag is
downloaded and compared by SHA-256. Any change creates a new generation; a
failed refresh leaves the active generation intact.

Useful controls:

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

Storage and networking are always provided by the built-in Nitro runtime.

### Cache data path

| Path                  | Redundant work removed                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| Successful download   | One complete post-download file read for SHA-2, plus one `stat`        |
| HTTP 304 revalidation | Temporary-file creation, existence check, and removal                  |
| iOS resource batch    | Per-resource `URLSession`; one reusable session keeps connection pools |
| Large native streams  | 8 KiB Android copy loops and per-callback iOS file writes              |

The native downloader computes the required SHA-2 digests while response bytes
are being written. Android and iOS batch file I/O in 256 KiB chunks. This
changes where the same integrity work happens; it does not skip it.

Warm activation still reads and hashes every persisted payload before serving
it. This integrity check is intentional; the optimizations above do not replace
it with timestamps or cached metadata.

## Direct baseline

The same native component can load a URL without durable mirroring:

```tsx
<LocalWebView durableCacheEnabled={false} source={{ uri: 'https://game.example.com/' }} />
```

The E2E benchmark uses this as its direct WebView baseline. Both sides therefore
share the same WebView implementation and differ only in response delivery.

POST requests, request bodies, custom request headers, non-HTTPS URLs, and
inline HTML use direct mode automatically.

## React Native WebView compatibility

The public props, events, and ten imperative methods track
`react-native-webview@13.16.0`. The implementation uses `WKWebView` and
`android.webkit.WebView` directly.

`nativeConfig.props` can pass extra values to the built-in Nitro native view.
Replacing the component through `nativeConfig.component` is intentionally not
supported because it would bypass this runtime.

## Security defaults

- Only absolute HTTPS entries are mirrored.
- Cross-origin assets require an explicit `trustedAssetOrigins` entry.
- Redirects are validated one hop at a time.
- Every cached file is checked against its manifest SHA-256 before activation.
- Subresource Integrity is enforced when present.
- Content Security Policy is preserved by default.

`allowContentSecurityPolicyBypass` is available for content you own when
removing CSP is an explicit product decision.

## Benchmark matrix

Comment `/e2e` on a same-repository pull request to run the macOS ARM64 runner:

- 50 MiB, 200 MiB, and 500 MiB Unity graphs
- cold install, warm start, and fully offline start
- low-end and current Android emulators
- iOS simulator host and WebKit process memory
- 100, 500, and 1,000-resource all-304 revalidation
- large files without ETags
- CSP, cookies, Range fetches, workers, WASM, and real Unity startup

Each platform produces a direct-vs-local report with page-ready time,
background storage time, network bytes, 304 counts, offline availability, and
peak memory.

### Measured iOS baseline

Before the cache data plane moved fully native, one sequential Release run on
an iPhone 17 Pro iOS 26.5 simulator hosted by an Apple M4 Mac mini produced:

| Unity graph | Direct first page | Local first page | Direct warm | Local warm | Local offline |
| ----------- | ----------------: | ---------------: | ----------: | ---------: | ------------: |
| 50 MiB      |            1.49 s |           1.48 s |      0.59 s |     2.19 s |        2.18 s |
| 200 MiB     |            2.88 s |           2.92 s |      2.41 s |     2.83 s |        2.82 s |
| 500 MiB     |            5.59 s |           7.46 s |      5.00 s |     4.13 s |        4.12 s |

The direct runtime timed out after 30 seconds in every offline phase. The local
runtime used zero network bytes for ETag warm and offline phases. First install
used roughly twice the network bytes because the visible remote page and
background durable mirror intentionally run together.

This is the pre-migration regression baseline, not a claim about the current
native-cache revision or physical-device performance. Run `/e2e` on this
revision before making a production decision.

See [the package guide](./packages/react-native-local-webview/README.md) for the
complete API and [the E2E guide](./e2e/README.md) for benchmark mechanics.

## Development

```sh
mise install
yarn install --immutable
yarn check
```

The monorepo uses Node 24.15.0, mise, Nx, tsdown, oxlint, oxfmt, Vitest, and
Changesets.

## License

MIT
