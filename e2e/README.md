# Production benchmark E2E

This suite measures `react-native-local-webview` with a real Unity WebGL game, large
durable assets, many-resource revalidation, and browser features that commonly break
when an HTTPS application is mirrored into local storage.

The Unity fixture is the MIT-licensed
[W O R D L Y](https://github.com/rishavnathpati/W-O-R-D-L-Y) build pinned to commit
`a51cd1340075d61d3d3b22d96ad6f2bc8bfabeaf`. `prepare.mjs` downloads and verifies
the original loader, framework, WASM, and data files. The server keeps Unity's data
archive byte-exact and adds a deterministic 50 MiB, 200 MiB, or 500 MiB runtime
payload to the same mirrored game graph. The page streams the whole local payload
before booting Unity, exercising transfer and storage paths without committing
generated binaries or corrupting Unity's archive format.

The fixture server listens on loopback. CI exposes it only inside the runner's
Tailscale network with `tailscale serve`, preserving a valid HTTPS origin without
publishing the fixture to the internet.

The showcase intentionally pins `react-native-blob-util` to `0.24.9`. Version
`0.24.10` interrupts multi-buffer Android downloads in this workload, including the
31 KiB Unity loader; the benchmark should not silently move past that known-bad
version until the upstream regression is resolved.

The benchmark is intentionally manual because a full run downloads, hashes,
revalidates, and streams several gigabytes. Results and memory samples are uploaded
as workflow artifacts.

After the workflows are present on the default branch, repository owner
`jingjing2222` can comment `/e2e` on a same-repository pull request. The command
pins the pull request head SHA, queues the full production matrix on the Mac mini,
and updates one pull request comment with progress and the final run link. Fork
pull requests are deliberately rejected because the benchmark executes checked-out
code on a self-hosted runner.

On iOS Simulator, peak RSS includes the React Native host process plus WebKit
WebContent, GPU, and Networking processes created after the run starts. On Android,
RSS and PSS come from `dumpsys meminfo` for the application package and do not claim
memory owned by System WebView's sandboxed renderer.
