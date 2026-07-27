# react-native-local-webview

[![CI](https://github.com/jingjing2222/react-native-local-webview/actions/workflows/ci.yml/badge.svg)](https://github.com/jingjing2222/react-native-local-webview/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node 24.15.0](https://img.shields.io/badge/node-24.15.0-339933.svg)](./mise.toml)

> Run CSR and Unity WebGL bundles from durable local storage without giving up
> their HTTPS origin.

`react-native-local-webview` mirrors a web application's static resource graph
into app-owned storage and runs it through `react-native-webview` with its
original HTTPS origin.

The bundle survives WebKit or Chromium cache eviction. The page still sees its
real `location.origin`, keeps browser history, and uses normal CORS, cookies,
and networking for requests that are not part of the local bundle.

```text
remote HTTPS site ── mirror + revalidate ──▶ durable app storage
        │                                      │
        └── original HTTPS origin ──▶ WebView ◀┘
```

## Why use it?

Loading a downloaded website with `file://` changes its security origin and
breaks assumptions around routing, CORS, workers, and WASM. Leaving the bundle
to the WebView cache preserves browser behavior but gives the application no
durability guarantee.

This library separates those concerns:

- CSR page shells and discovered assets start from durable local files.
- Every mirrored resource stores an ETag and SHA-256 digest and is revalidated.
- Cache generations commit atomically, retain verified rollback candidates,
  and obey configurable byte and generation limits.
- History API navigation stays in the WebView's native back/forward stack.
- Runtime-only URLs fall through to ordinary WebView networking.
- Unity WebGL `.data`, `.wasm`, framework, worker, and streaming requests use
  the same generic resource pipeline.

There is no library-owned iOS or Android native module. The app supplies a
filesystem adapter, while `react-native-webview` remains the actual WebView
component.

## Quick start

```sh
yarn add react-native-local-webview react-native-webview@13.16.0 react-native-blob-util
```

Create the adapter next to the component that uses it:

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
      cachePolicy={{
        maxBytes: 512 * 1024 * 1024,
        maxGenerations: 2,
      }}
      style={{ flex: 1 }}
    />
  );
}
```

The package has `react`, `react-native`, and `react-native-webview` peer ranges
of `*`. Version `13.16.0` is pinned only by this repository's showcase and test
environment.

The Blob Util preset is optional. Presets are also available for
`react-native-fs`, `react-native-file-access`, and `expo-file-system`, or an app
can provide its own `LocalWebViewCacheAdapter`.

Read the [complete installation, adapter, security, cache, History API, and
Unity WebGL documentation](./packages/react-native-local-webview/README.md).

## What is verified

The unit suite exercises representative HTML produced by all CSR templates in
the pinned `create-vite` catalog as generic fixtures—not as a Vite-specific
integration. It also covers unusual valid HTML, CSS graphs, `srcset`, dynamic
imports, workers, WASM, SRI, ETag revalidation, generation rollback, and cache
limits.

The manual production benchmark runs a real MIT-licensed Unity WebGL game on:

- low-end and current Android emulators;
- an iOS simulator;
- 50 MiB, 200 MiB, and 500 MiB bundle graphs;
- first start, warm start, and complete offline start;
- 100, 500, and 1,000-resource `304` revalidation;
- ETag-free large files, CSP, cookies, Range requests, and workers.

See the [benchmark design and measurement scope](./e2e/README.md).

## Repository layout

This is an Nx workspace:

- [`packages/react-native-local-webview`](./packages/react-native-local-webview)
  — the publishable TypeScript package;
- [`examples/showcase`](./examples/showcase) — the React Native 0.85 showcase
  and native benchmark host;
- [`e2e`](./e2e) — the self-hosted simulator and emulator benchmark harness.

```sh
mise install
corepack enable
yarn install
yarn check
```

Node.js `24.15.0` is pinned with mise. `tsdown` owns the package build and
export map, while `oxfmt` and type-aware `oxlint` handle formatting and linting.

## License

MIT
