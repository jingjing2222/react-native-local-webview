# Production benchmark E2E

This suite measures the Nitro-backed `LocalWebView` with a real Unity WebGL
game, large durable assets, many-resource revalidation, and browser features
that commonly break when an HTTPS application is mirrored into local storage.

Every production benchmark is an A/B run:

- the baseline uses `LocalWebView` with durable mirroring disabled and relies
  only on the WebView's normal HTTP cache;
- the candidate opens the remote page immediately on a cache miss, starts
  saving the same URL graph after document load, and starts later mounts from
  the atomically published durable graph while one required release-ETag check
  runs behind the visible page.

Both sides use a run-specific query key, the same fixture graph, the same release
app, and the same emulator or simulator profile. The generated comparison reports
show user-visible page-ready time separately from background storage completion,
plus network bytes, 304 counts, offline availability, and peak process memory.
The first install intentionally downloads through both WebView and the durable
mirror, so its network-byte column also exposes that one-time duplication.

Run the full A/B matrix locally after starting the fixture server:

```sh
yarn e2e:compare:android:latest
yarn e2e:compare:android:low
yarn e2e:compare:ios
```

Pass `smoke` directly to `scripts/e2e/run-comparison-benchmark.sh` for the
50 MiB/100-resource subset. Comparison Markdown and the two raw runtime reports
are written to `e2e/artifacts`.

The shorter compatibility suites run on every supported platform runtime:

```sh
yarn e2e:props:android:latest
yarn e2e:props:android:low
yarn e2e:props:ios
```

They individually mount every applicable React Native WebView 13.16.0 prop and
then exercise origin/history, JavaScript injection, messages, navigation
policy, native events, all imperative methods, Basic Auth, downloads/errors,
DOM storage, custom user agents, and GET/HEAD-only local interception.

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

The candidate uses the built-in Nitro downloader, direct-to-file storage, and
native range reads. Install-time digests are streamed during writes; warm runs
do not reread payload files for hashing. No external filesystem module is part
of the benchmark data path.

The benchmark is intentionally manual because a full A/B run downloads and
streams several gigabytes. Raw results, memory samples, and
direct-vs-local comparison tables are uploaded as workflow artifacts and appended
to the GitHub Actions summary.

After the workflows are present on the default branch, repository owner
`jingjing2222` can comment `/e2e` on a same-repository pull request. The command
pins the pull request head SHA, queues the full production matrix on the Mac mini,
and updates one pull request comment with the comparison tables and final run link.
Fork pull requests are deliberately rejected because the benchmark executes
checked-out code on a self-hosted runner.

On iOS Simulator, RSS is sampled every 500 ms and reported separately for the
React Native host, WebKit processes, and their combined total. WebKit includes
WebContent, GPU, and Networking processes created after the run starts. On
Android, RSS and PSS come from `dumpsys meminfo` for the application package and
do not claim memory owned by System WebView's sandboxed renderer.

The iOS runtime uses private WebKit HTTPS protocol-registration SPI. These E2E
results establish technical behavior on the tested simulator, not App Store
eligibility.

## Measured iOS simulator run

This is one sequential Release run of the warm-start fast path on an iPhone 17
Pro iOS 26.5 simulator hosted by an Apple M4 Mac mini. It is not a physical
device or statistically stable product-performance claim.

| Unity graph | Direct first page | Local first page | Direct warm | Local warm | Local offline |
| ----------- | ----------------: | ---------------: | ----------: | ---------: | ------------: |
| 50 MiB      |            1.81 s |           1.51 s |      0.60 s |     1.95 s |        2.08 s |
| 200 MiB     |            3.14 s |           2.89 s |      2.55 s |     2.71 s |        2.70 s |
| 500 MiB     |            5.68 s |           7.30 s |      5.54 s |     3.89 s |        3.77 s |

The direct WebView timed out after 30 seconds for every offline phase. The local
runtime transferred zero response-body bytes for all ETag warm and offline phases.
Its first install used about twice the network bytes because the visible WebView
and the background durable mirror each downloaded the graph.

The run's peak app-host/WebKit/combined RSS was 585/1,047/1,623 MiB for the local
runtime versus 260/1,046/1,271 MiB for direct WebView. Those measurements predate
single-request release validation; rerun `/e2e` before using background validation
latency as a production budget. Use repeated physical-device runs before setting
production latency or memory budgets.
