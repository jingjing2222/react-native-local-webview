# Contributing

Read the [code of conduct](./CODE_OF_CONDUCT.md) before participating. This
document describes the repository's implementation flow; user-facing behavior
belongs in the root and package READMEs.

## Toolchain

The repository pins Node.js 24.15.0 with mise and uses Yarn workspaces through
Corepack.

```sh
mise install
mise exec -- corepack yarn install --immutable
```

The main tools are Nx, tsdown, oxlint, oxfmt, Vitest, Nitrogen, CocoaPods, and
Gradle.

## Repository map

| Path                                                                 | Responsibility                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/react-native-local-webview/src/LocalWebView.native.tsx`    | Public component orchestration, React callbacks, direct/local source selection |
| `packages/react-native-local-webview/src/mirrorWebBundle.ts`         | Cache lifecycle, download validation, generations, rollback, and pruning       |
| `packages/react-native-local-webview/src/resourceGraph.ts`           | HTML/CSS/JavaScript parsing and resource graph localization                    |
| `packages/react-native-local-webview/src/LocalWebView.nitro.ts`      | Nitro view contract                                                            |
| `packages/react-native-local-webview/src/LocalWebViewCache.nitro.ts` | Nitro storage and networking contract                                          |
| `packages/react-native-local-webview/src/nitroCacheAdapter.ts`       | Typed adapter from the generated cache object to the graph orchestrator        |
| `packages/react-native-local-webview/ios/`                           | `WKWebView`, URL interception, downloads, files, hashing, and Range responses  |
| `packages/react-native-local-webview/android/`                       | Android WebView interception, downloads, files, hashing, and Range responses   |
| `packages/react-native-local-webview/nitrogen/generated/`            | Nitrogen output; never edit by hand                                            |
| `examples/showcase/`                                                 | React Native host used by compatibility and benchmark runs                     |
| `e2e/` and `scripts/e2e/`                                            | HTTPS fixtures, device runners, measurement, and report generation             |

## Runtime flow

### Direct sources

Inline HTML, non-HTTPS URLs, non-GET requests, request bodies, custom request
headers, and `durableCacheEnabled={false}` bypass bundle installation. The
component serializes the compatible source and lets the platform WebView load
it directly.

### First durable mount

1. `LocalWebView` opens the requested remote HTTPS document immediately.
2. `resolveWebBundle` starts a parallel background installation.
3. The cache object streams responses into a staging directory and computes
   required digests while writing.
4. `resourceGraph.ts` parses HTML with parse5, CSS with css-tree, and JavaScript
   with Acorn. It follows supported imports, workers, URLs, and Unity assets.
5. The localized entry, manifest, and file assets form one generation.
6. The generation is published only after every required resource succeeds.
7. `onBundleStored` is emitted after the published state is durable.

The visible first page does not wait for bundle installation. This is why the
first run intentionally downloads the direct page and durable copy in parallel.

### Warm mount

1. JavaScript sends the view only a cache request containing the origin, cache
   directory, policy limits, validation mode, and security fingerprint.
2. The iOS or Android implementation reads `state.json`, the active manifest,
   and referenced file metadata directly from persistent storage. It keeps the
   localized `index.html` as a file-backed response instead of materializing it
   through React state or a native in-memory byte buffer.
3. The implementation registers the local request map and starts navigation at
   the original HTTPS URL. iOS streams the entry through the URL protocol.
   Android uses the document-start script API when available, then streams the
   entry through `shouldInterceptRequest`; older System WebViews use the
   in-memory script-injection fallback.
4. Matching requests are served from the published generation while the page
   retains its HTTPS browsing context.
5. After the local page loads, background validation begins. In
   `release-etag` mode this is one conditional entry request.
6. A changed release is installed as a separate generation and becomes active
   on a later mount; it does not replace bytes under the running page.

Cached HTML and the asset inventory do not cross React state on this path.

### Offline and rollback

An unreachable validator request leaves the active generation untouched. If a
generation cannot be opened, the component can select the previous complete
generation. If no valid local generation remains, it falls back to the remote
document and reports the failure.

## Cache format

Each origin cache contains:

```text
state.json
state.previous.json
generations/
  <generation-id>/
    index.html
    manifest.json
    assets/<sha256> # only when at least one resource requires file delivery
```

`state.json` publishes the active generation. Temporary state files and staging
directories are not valid generations. Publication uses same-volume moves so a
reader sees the old complete state or the new complete state, never a partial
release.

Resources use two delivery classifications:

- `inline`: parser-required text or bounded data embedded into localized output;
- `file`: large or streamable resources retained as files and served by the
  platform interceptor.

In `release-etag` mode, the entry ETag validates the complete release. The
persisted remote-resource map therefore contains only the entry and resources
that still require file delivery; metadata for bytes already embedded in
`index.html` is redundant and is omitted. `content-hash` mode retains the full
remote-resource map because per-resource validation needs it.

The current cache format is version 14. A schema or delivery-semantics change
must update the format constant in all three readers:

- `src/mirrorWebBundle.ts`
- `ios/LocalAssetURLProtocol.swift`
- `android/src/main/java/com/margelo/nitro/localwebview/LocalWebView.kt`

Old generations must fail closed and be rebuilt; do not reinterpret an older
manifest using new semantics.

## Resource graph rules

The graph normalizes URL fragments away for network and cache identity while
preserving the entry document fragment for navigation. Redirects are followed
one hop at a time only after validating the target origin.

An entry origin is trusted automatically. Other origins require
`trustedAssetOrigins`. Content Security Policy is preserved unless the caller
explicitly opts into bypassing it, and Subresource Integrity is verified when
present.

Only statically discoverable resources belong to the durable graph. Runtime API
requests and URLs built solely from runtime data remain ordinary network
requests. Avoid adding broad URL capture that silently changes this boundary.

## Nitro boundary and generated code

`LocalWebView.nitro.ts` defines the view and its imperative methods.
`LocalWebViewCache.nitro.ts` defines bounded storage/network operations. Large
response bodies and file contents should remain on the platform side; only
metadata and parser-required bounded strings should cross into JavaScript.

After changing a `.nitro.ts` file or `nitro.json`, regenerate bindings:

```sh
yarn workspace react-native-local-webview nitrogen
```

Nitrogen names generated bases `HybridLocalWebViewSpec` and
`HybridLocalWebViewCacheSpec`. The `Hybrid` prefix is a generator convention,
not a second runtime mode. Authored implementations and public APIs remain
`LocalWebView` and `LocalWebViewCache`.

Regeneration can add and remove source files. Run CocoaPods or sync Gradle
before compiling the showcase. Do not preserve stale generated files or edit
generated output manually.

## Platform interception

### iOS

`LocalWebView.swift` owns the `WKWebView`. `LocalAssetURLProtocol.swift` maps
original HTTPS requests to published files, preserves relevant response
metadata, handles complete and single-range reads, and forwards uncaptured
requests to the network. The iOS path uses WebKit protocol-registration SPI, so
changes require an iOS simulator build and E2E coverage, not only Swift syntax
validation.

### Android

`LocalWebView.kt` owns Android WebView clients and serves published files from
`shouldInterceptRequest`. It constructs `WebResourceResponse` values with the
original media type and response headers, supports Range requests, and lets
uncaptured URLs continue through WebView networking.

Both platforms must agree on manifest validation, cache format, response
metadata, release-ETag requirements, and fallback behavior.

## Validation workflow

Run the complete CI-equivalent suite:

```sh
yarn check
```

It includes formatting, lint, TypeScript checks, 302 unit tests, tsdown output,
and package publication validation. Useful individual commands are:

```sh
yarn format
yarn format:check
yarn lint
yarn typecheck
yarn test
yarn test:coverage
yarn build
yarn publint
```

The unit suite exercises generic CSR resource graphs and every static template
in the pinned `create-vite` fixture catalog. Vite is test input, not a supported
runtime contract.

### Platform builds

For changes to Nitro contracts or platform sources, also compile both hosts:

```sh
cd examples/showcase/android
./gradlew :app:compileDebugKotlin --no-daemon --console=plain
```

```sh
cd examples/showcase/ios
bundle exec pod install
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild \
  -workspace LocalWebviewExample.xcworkspace \
  -scheme LocalWebviewExample \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

### E2E and benchmarks

The fixture server exposes deterministic Unity-sized bundles, resource-count
graphs, CSP, cookies, Range requests, workers, WASM, and release-ETag behavior.
See [e2e/README.md](./e2e/README.md) for local HTTPS setup and runner commands.

Comment `/e2e` on a same-repository pull request to run the macOS ARM64 workflow
against iOS and Android simulators/emulators. Prop compatibility runs mount all
applicable React Native WebView 13.16.0 props and exercise every imperative
method.

## Change workflow

- Add or update unit tests for observable behavior changes.
- Update platform tests or E2E scenarios when changing WebView behavior.
- Regenerate Nitrogen output when contracts or autolinking change.
- Bump the cache format when persisted semantics change.
- Keep both platform readers consistent.
- Update the package README for public behavior; keep internal mechanics here.
- Add a Changeset for published package changes.
- Run `git diff --check` and `yarn check` before opening a pull request.

Keep a pull request focused on one coherent change and document any cache-format
compatibility impact in its description.
