# react-native-local-webview

[![CI](https://github.com/jingjing2222/react-native-local-webview/actions/workflows/ci.yml/badge.svg)](https://github.com/jingjing2222/react-native-local-webview/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node 24.15.0](https://img.shields.io/badge/node-24.15.0-339933.svg)](./mise.toml)

> Run CSR and Unity WebGL bundles from durable local storage without giving up
> their HTTPS origin.

`LocalWebView` is a Nitro Hybrid View backed by `WKWebView` on iOS and
`android.webkit.WebView` on Android. It mirrors a site's static graph into
app-owned storage, then serves verified files natively at their original HTTPS
URLs. On a first install it opens the remote page immediately, waits for the
document load event (with a bounded fallback), and builds the durable mirror in
the background. It never replaces the live document mid-session. The next mount
uses the verified local generation.

The page keeps its real `location.origin`, browser history, cookies, CORS, and
ordinary runtime networking. Large `.data` and `.wasm` responses never travel
through the React Native bridge.

```text
first mount ──▶ remote HTTPS page ──▶ visible immediately
        └────▶ validate + mirror ──▶ durable app storage

later mount ──▶ verified local generation at the original HTTPS URLs
                                      │
                          GET/HEAD ───┴── local file stream
                          everything else ── network
```

## Install

```sh
yarn add react-native-local-webview react-native-nitro-modules react-native-webview
cd ios && pod install
```

The package uses the `react-native-webview` 13.16.0 public TypeScript API as its
compatibility baseline. Its peer range is `*`; the host app owns the version.

Install one filesystem provider in the app. For example:

```sh
yarn add react-native-blob-util
```

```tsx
import { useMemo } from 'react';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { createReactNativeBlobUtilCacheAdapter, LocalWebView } from 'react-native-local-webview';

export function Game() {
  const cacheAdapter = useMemo(
    () => createReactNativeBlobUtilCacheAdapter(ReactNativeBlobUtil),
    []
  );

  return (
    <LocalWebView
      cacheAdapter={cacheAdapter}
      virtualUrl="https://book.jingjing2222.com/"
      cachePolicy={{ maxBytes: 800 * 1024 * 1024, maxGenerations: 1 }}
      style={{ flex: 1 }}
    />
  );
}
```

Presets also exist for `react-native-fs`, `react-native-file-access`, and
`expo-file-system`. The provider is supplied by the application; this package
does not force a filesystem dependency.

## What the native runtime changes

- One Nitro prop update transfers configuration and the verified asset
  manifest.
- Native code opens and range-streams local files directly.
- Navigation, message, progress, error, download, and scroll callbacks cross a
  Nitro JSI callback, not the legacy React Native bridge.
- `fetch`, XHR, workers, Unity loaders, and WASM continue to request normal
  HTTPS URLs.
- URLs absent from the verified inventory, and non-GET/HEAD requests, use the
  network. Android leaves them on WebView's ordinary path; the iOS private
  protocol hook forwards them through native `URLSession` and preserves
  same-origin asynchronous fetch/XHR bodies without using the React Native
  bridge.

`LocalWebView` accepts the applicable iOS and Android props, events, and ten
imperative methods from `react-native-webview@13.16.0`. A supplied
`nativeConfig.component` intentionally selects the compatible
`react-native-webview` fallback because replacing the native host also replaces
the Nitro runtime.

## When it pays off

This runtime optimizes for durable offline availability, not every cache-hot
launch. In one sequential Release run on an iPhone 17 Pro iOS 26.5 simulator
hosted by an Apple M4 Mac mini:

| Unity graph | Direct first | Local first | Direct warm | Local warm | Local offline |
| ----------- | -----------: | ----------: | ----------: | ---------: | ------------: |
| 50 MiB      |       1.49 s |      1.48 s |      0.59 s |     2.19 s |        2.18 s |
| 200 MiB     |       2.88 s |      2.92 s |      2.41 s |     2.83 s |        2.82 s |
| 500 MiB     |       5.59 s |      7.46 s |      5.00 s |     4.13 s |        4.12 s |

Direct WebView timed out after 30 seconds in every offline phase. Local warm and
offline phases transferred zero network bytes. The 500 MiB warm graph was 17%
faster locally, while the 50 MiB cache-hot graph was about 3.7 times slower.
First install uses roughly twice the network traffic because the visible page
and background mirror download independently.

These numbers are a regression snapshot, not a physical-device or statistically
stable product benchmark. See the [benchmark design, memory results, and
commands](./e2e/README.md) before making a production decision.

## Important iOS status

iOS HTTPS interception uses the private
`WKBrowsingContextController registerSchemeForCustomProtocol:` SPI. It works in
the simulator and can work on physical devices, but private API use can cause
App Store rejection and is not a stable Apple contract. Treat the current iOS
implementation as a production benchmark/PoC unless your distribution policy
explicitly permits that risk.

Android uses the public `WebViewClient.shouldInterceptRequest` API.

See the [package guide](./packages/react-native-local-webview/README.md) for
cache behavior, Unity WebGL details, API compatibility, security boundaries,
and E2E commands.

## Development

This is an Nx workspace:

- [`packages/react-native-local-webview`](./packages/react-native-local-webview)
  — the publishable package and native runtime;
- [`examples/showcase`](./examples/showcase) — the React Native benchmark host;
- [`e2e`](./e2e) — simulator and emulator fixtures.

```sh
mise install
corepack enable
yarn install
yarn check

yarn e2e:props:android:latest
yarn e2e:props:android:low
yarn e2e:props:ios

yarn e2e:compare:android:latest
yarn e2e:compare:android:low
yarn e2e:compare:ios
```

Node.js 24.15.0 is pinned with mise. `tsdown` owns the JavaScript, declarations,
and export map; `oxfmt` and type-aware `oxlint` own formatting and linting.

## License

MIT
