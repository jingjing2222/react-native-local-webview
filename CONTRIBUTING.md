# Contributing

Contributions are welcome. Please read the
[code of conduct](./CODE_OF_CONDUCT.md) before participating.

## Toolchain

The repository uses Yarn workspaces and pins Node.js 24.15.0 in
[`mise.toml`](./mise.toml).

```sh
mise install
mise exec -- corepack yarn install --immutable
```

`packages/react-native-local-webview/` contains the publishable TypeScript
library. `examples/showcase/` contains the React Native application, and
`e2e/` contains the production benchmark infrastructure. The library has no
native project of its own. WebView is a peer dependency; filesystem and
downloader behavior comes from a cache adapter. The showcase uses the included
`createReactNativeBlobUtilCacheAdapter` preset.

## Checks

Run the same complete check used by CI:

```sh
mise exec -- corepack yarn check
```

Individual commands are also available:

```sh
yarn format:check
yarn lint
yarn typecheck
yarn test
yarn test:coverage
yarn build
yarn publint
```

Apply formatting with:

```sh
yarn format
```

The unit suite verifies every static CSR template name shipped by the pinned
`create-vite` test catalog. It tests the resulting entry HTML and generic
resource graph; Vite is not part of the public package API.

## Showcase app

```sh
yarn showcase start
yarn showcase ios
# or
yarn showcase android
```

Re-run CocoaPods or Gradle setup only when changing the showcase's installed
native dependencies.

## Pull requests

- Keep a pull request focused on one coherent change.
- Add or update unit tests for behavior changes.
- Run `yarn check`.
- Update the README when changing public behavior or types.
- Explain cache-format compatibility in the PR body.
