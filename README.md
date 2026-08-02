# react-native-local-webview

[![CI](https://github.com/jingjing2222/react-native-local-webview/actions/workflows/ci.yml/badge.svg)](https://github.com/jingjing2222/react-native-local-webview/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/react-native-local-webview.svg)](https://www.npmjs.com/package/react-native-local-webview)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> Run CSR and Unity WebGL bundles from durable local storage without giving up
> their HTTPS origin.

`LocalWebView` is for React Native apps that need a web experience to remain
available after the operating system evicts the normal WebView cache.

The first visit opens the remote page immediately and stores a complete bundle
in the background. Android later starts from that bundle. iOS keeps WebKit's
hot-cache path for online starts and activates the app-owned bundle on a real
network or validation failure. The page still sees its original HTTPS URL,
origin, cookies, CORS rules, History API, workers, WASM, and Range requests.

## Is it a good fit?

Use it when:

- a CSR application or Unity WebGL game must start offline after one successful install;
- a partially cached release is not acceptable;
- loading from `file://` would break origin-sensitive browser behavior;
- large `.data` and `.wasm` files should remain streamable files instead of crossing React state.

Prefer a normal WebView when durable offline availability is unnecessary. An
already-hot HTTP cache can be faster and use less app-owned storage.

| Behavior        | Normal WebView cache         | `LocalWebView`                                |
| --------------- | ---------------------------- | --------------------------------------------- |
| Cache ownership | Operating system             | Your application                              |
| Offline release | Independent cached responses | One complete published generation             |
| First visit     | Remote page                  | Remote page, background installation          |
| Later visit     | Depends on HTTP cache policy | Android local; iOS WebKit with local fallback |
| Page origin     | HTTPS                        | The same HTTPS origin                         |
| Update check    | Browser-defined              | One release ETag request                      |
| Recovery        | Browser cache behavior       | Previous complete generation or remote page   |

## Install

```sh
yarn add react-native-local-webview react-native-nitro-modules
cd ios && pod install
```

Requirements:

- React Native New Architecture
- iOS 16.4 or newer
- Android API 24 or newer

## Quick start

```tsx
import { LocalWebView } from 'react-native-local-webview';

export function Game() {
  return (
    <LocalWebView
      source={{ uri: 'https://game.example.com/' }}
      validationMode="release-etag"
      cachePolicy={{
        maxBytes: 800 * 1024 * 1024,
        maxGenerations: 2,
      }}
      onBundleStored={(bundle) => {
        console.log('Available offline:', bundle.generationId);
      }}
      onBundleError={(error) => {
        console.error('Bundle installation failed:', error);
      }}
      style={{ flex: 1 }}
    />
  );
}
```

`virtualUrl="https://…"` is also available when a component is dedicated to
one entry URL. Do not pass `source` and `virtualUrl` together.

## Configure the release ETag

For predictable warm starts, set `validationMode="release-etag"` and make the
entry response's ETag identify the complete deployed release:

```http
ETag: "game-release-2026-08-03.1"
```

Change it whenever any captured HTML, JavaScript, CSS, worker, WASM, or Unity
data file changes. Later starts send one `If-None-Match` request:

- `304 Not Modified` keeps the installed generation;
- a successful `200` installs a new generation for the next mount;
- a missing ETag rejects installation instead of silently using an unsafe comparison.

If your infrastructure cannot provide a release-wide validator, the default
`content-hash` mode revalidates resources individually. It is more portable but
does more disk and network work on warm starts.

## Supported web bundles

The collector supports production CSR and Unity WebGL output, including:

- module scripts, static imports, and dynamic imports;
- stylesheets, CSS imports, `url(...)`, `src`, and `srcset`;
- preload and module-preload resources;
- Web Workers and worker module graphs;
- WebAssembly and Unity loader, framework, `.data`, and `.wasm` files.

Large resources stay as files and support complete and single-range responses.
Runtime API calls that are not part of the captured graph continue through the
real HTTPS network.

## Origin and navigation

Local bytes are presented at the original HTTPS document URL. The page retains:

- its original `location.origin` and secure context;
- normal relative URL resolution;
- same-origin cookies, storage, fetch, and browser security checks;
- `pushState`, `replaceState`, `back`, `forward`, and `go`.

SPA history can be observed with `onHistoryChange` and controlled through a
`LocalWebViewHandle`:

```tsx
import { useRef } from 'react';
import { LocalWebView, type LocalWebViewHandle } from 'react-native-local-webview';

const ref = useRef<LocalWebViewHandle>(null);

<LocalWebView
  ref={ref}
  virtualUrl="https://app.example.com/"
  onHistoryChange={(history) => console.log(history.url)}
/>;

ref.current?.goBack();
```

## Cache and recovery controls

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

The default cache retains at most 512 MiB and two complete generations per
origin. Configure `maxBytes`, `maxGenerations`, and `maxInlineBytes` through
`cachePolicy` when your bundle needs different limits.

## React Native WebView compatibility

The public props, events, and imperative methods track
`react-native-webview@13.16.0`. `LocalWebView` implements them directly with
`WKWebView` and Android WebView; installing `react-native-webview` is not
required.

Set `durableCacheEnabled={false}` to use the same component as a direct WebView:

```tsx
<LocalWebView durableCacheEnabled={false} source={{ uri: 'https://game.example.com/' }} />
```

POST requests, request bodies, custom request headers, non-HTTPS URLs, and
inline HTML also use direct mode automatically.

## Security defaults

- Only absolute HTTPS entries are mirrored.
- Cross-origin assets require `trustedAssetOrigins`.
- Redirect targets are validated one hop at a time.
- Subresource Integrity metadata is enforced when present.
- Content Security Policy is preserved unless you explicitly set
  `allowContentSecurityPolicyBypass` for content you control.

## Current limitations

- iOS and Android are supported.
- Only statically discoverable resources are stored. URLs assembled solely from
  runtime data remain network requests.
- A Service Worker-dependent application needs explicit compatibility testing;
  the request interceptor is not a Service Worker replacement.
- First installation intentionally uses more network traffic because the
  visible remote page and background bundle installation run together.

## Performance evidence

The repository benchmark compares direct HTTPS loading with local delivery for
50 MiB, 200 MiB, and 500 MiB Unity graphs, offline starts, 100–1,000-resource
release checks, Range fetches, workers, WASM, cookies, CSP, and memory use.

The latest Release smoke runs measured the 50 MiB graph as follows. Each warm
candidate start served zero network response-body bytes. Android added one
release `304`; iOS kept WebKit's normal validators and added one release check
behind the visible page.

| Runtime                 | Direct warm | Local warm | Local offline |
| ----------------------- | ----------: | ---------: | ------------: |
| Android latest          |      1.94 s |     0.56 s |        0.54 s |
| Android low-end         |      6.68 s |     0.54 s |        0.48 s |
| iPhone 17 Pro simulator |      0.60 s |     0.92 s |        0.96 s |

Android starts the durable generation directly. iOS starts its ordinary WebKit
cache immediately and keeps the durable generation as fallback; there is no
fixed fallback timer. A failed release check or navigation activates the local
generation, while a fully offline network path selects it immediately. The
tested iOS simulator still favored a direct WebView by 0.32 s for this graph.
The durable path trades additional first-install traffic, storage, and host
memory for deterministic offline availability. On the latest Android profile,
for example, the local first page took 8.29 s versus 3.55 s direct and peak PSS
was 225.6 MiB versus 123.4 MiB. These are single-run emulator and simulator
measurements, not physical-device production guarantees.

See the [package guide](./packages/react-native-local-webview/README.md) for the
complete usage reference, [E2E guide](./e2e/README.md) for benchmark mechanics,
and [contribution guide](./CONTRIBUTING.md) for the internal execution flow.

## License

MIT
