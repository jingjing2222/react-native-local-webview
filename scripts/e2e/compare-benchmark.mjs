import { readFile, writeFile } from 'node:fs/promises';

const [remoteResultPath, remoteMemoryPath, localResultPath, localMemoryPath, outputPath] =
  process.argv.slice(2);

if (!remoteResultPath || !remoteMemoryPath || !localResultPath || !localMemoryPath || !outputPath) {
  throw new Error(
    'Usage: compare-benchmark.mjs remote.json remote-memory.csv local.json local-memory.csv output.md'
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readMemory(path) {
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  const header = lines.shift()?.split(',') ?? [];
  const rows = lines.map((line) =>
    Object.fromEntries(line.split(',').map((value, index) => [header[index], Number(value)]))
  );
  return {
    hostRssKib: Math.max(0, ...rows.map((row) => row.host_rss_kib ?? 0)),
    pssKib: Math.max(0, ...rows.map((row) => row.total_pss_kib ?? 0)),
    rssKib: Math.max(0, ...rows.map((row) => row.total_rss_kib ?? 0)),
    rows,
    webkitRssKib: Math.max(0, ...rows.map((row) => row.webkit_rss_kib ?? 0)),
  };
}

function completion(result) {
  return result.reports.findLast((report) => report.kind === 'complete');
}

function scenarioKey(scenario) {
  return `${scenario.label}\u0000${scenario.phase}`;
}

function scenarioMeasurements(result, memory) {
  const starts = result.reports.filter((report) => report.kind === 'scenario-start');
  const scenarios = result.reports.filter((report) => report.kind === 'scenario-result');
  return new Map(
    scenarios.map((scenario) => {
      const start = starts.find(
        (candidate) =>
          candidate.label === scenario.label &&
          candidate.phase === scenario.phase &&
          candidate.receivedAt <= scenario.receivedAt
      );
      const requests = start
        ? result.requests.filter(
            (request) =>
              request.startedAt >= start.receivedAt && request.startedAt <= scenario.receivedAt
          )
        : [];
      const startMilliseconds = start ? Date.parse(start.receivedAt) : Number.NaN;
      const endMilliseconds = Date.parse(scenario.receivedAt);
      const peakRssKib = Math.max(
        0,
        ...memory.rows
          .filter(
            (row) => row.timestamp_ms >= startMilliseconds && row.timestamp_ms <= endMilliseconds
          )
          .map((row) => row.total_rss_kib ?? 0)
      );
      const value = scenario.result ?? {};
      return [
        scenarioKey(scenario),
        {
          available: Boolean(value.page),
          error: value.error,
          label: scenario.label,
          networkBytes: requests.reduce((sum, request) => sum + (request.bytes || 0), 0),
          notModified: requests.filter((request) => request.status === 304).length,
          phase: scenario.phase,
          peakRssKib,
          pageReadyMilliseconds:
            value.pageReadyMilliseconds ??
            value.totalMilliseconds ??
            value.navigationReadyMilliseconds,
          storageReadyMilliseconds: value.storageReadyMilliseconds,
          totalMilliseconds: value.totalMilliseconds,
        },
      ];
    })
  );
}

function milliseconds(value) {
  return Number.isFinite(value) ? Number(value).toFixed(0) : '—';
}

function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0 B';
  const mebibytes = value / (1024 * 1024);
  return mebibytes >= 0.01 ? `${mebibytes.toFixed(2)} MiB` : `${value} B`;
}

function delta(local, remote, suffix = '') {
  if (!Number.isFinite(local) || !Number.isFinite(remote) || remote === 0) return '—';
  const percent = ((local - remote) / remote) * 100;
  if (Math.abs(percent) < 0.05) return `0.0%${suffix}`;
  return `${percent < 0 ? '↓' : '↑'} ${Math.abs(percent).toFixed(1)}%${suffix}`;
}

const [remote, local, remoteMemory, localMemory] = await Promise.all([
  readJson(remoteResultPath),
  readJson(localResultPath),
  readMemory(remoteMemoryPath),
  readMemory(localMemoryPath),
]);
const remoteCompletion = completion(remote);
const localCompletion = completion(local);

if (remoteCompletion?.runtime !== 'remote') {
  throw new Error(`${remoteResultPath} is not a direct remote WebView result`);
}
if (localCompletion?.runtime !== 'native') {
  throw new Error(`${localResultPath} is not a Nitro local runtime result`);
}
for (const field of ['origin']) {
  if (remote[field] !== local[field]) {
    throw new Error(`Comparison ${field} mismatch: ${remote[field]} != ${local[field]}`);
  }
}
for (const field of ['platform', 'profile', 'suite']) {
  if (remoteCompletion[field] !== localCompletion[field]) {
    throw new Error(
      `Comparison ${field} mismatch: ${remoteCompletion[field]} != ${localCompletion[field]}`
    );
  }
}

const remoteScenarios = scenarioMeasurements(remote, remoteMemory);
const localScenarios = scenarioMeasurements(local, localMemory);
const rows = [...remoteScenarios.entries()]
  .filter(([key]) => localScenarios.has(key))
  .map(([, direct]) => {
    const cached = localScenarios.get(`${direct.label}\u0000${direct.phase}`);
    const directPage = direct.available
      ? milliseconds(direct.pageReadyMilliseconds)
      : 'unavailable';
    const localPage = cached.available ? milliseconds(cached.pageReadyMilliseconds) : 'unavailable';
    return [
      direct.label,
      direct.phase,
      directPage,
      localPage,
      direct.available && cached.available
        ? delta(cached.pageReadyMilliseconds, direct.pageReadyMilliseconds)
        : cached.available
          ? 'local only'
          : '—',
      milliseconds(cached.storageReadyMilliseconds),
      bytes(direct.networkBytes),
      bytes(cached.networkBytes),
      delta(cached.networkBytes, direct.networkBytes),
      direct.peakRssKib > 0 ? (direct.peakRssKib / 1024).toFixed(1) : '—',
      cached.peakRssKib > 0 ? (cached.peakRssKib / 1024).toFixed(1) : '—',
    ];
  });

const markdown = [
  `# Direct WebView vs Nitro local runtime: ${localCompletion.platform} ${localCompletion.profile}`,
  '',
  `- Origin: \`${local.origin}\``,
  `- Suite: \`${localCompletion.suite}\``,
  '- Baseline: `react-native-webview` loading each remote HTTPS URL directly with its normal HTTP cache.',
  '- Candidate: `NativeLocalWebView`; a cache miss displays the same remote HTTPS document immediately while durable installation continues in the background. Later mounts use the verified local generation.',
  `- Direct WebView peak RSS: ${(remoteMemory.rssKib / 1024).toFixed(1)} MiB`,
  `- Nitro local peak RSS: ${(localMemory.rssKib / 1024).toFixed(1)} MiB (${delta(
    localMemory.rssKib,
    remoteMemory.rssKib
  )})`,
  ...(remoteMemory.hostRssKib > 0 || localMemory.hostRssKib > 0
    ? [
        `- Direct WebView peak app-host RSS: ${(remoteMemory.hostRssKib / 1024).toFixed(1)} MiB`,
        `- Nitro local peak app-host RSS: ${(localMemory.hostRssKib / 1024).toFixed(1)} MiB (${delta(
          localMemory.hostRssKib,
          remoteMemory.hostRssKib
        )})`,
        `- Direct WebView peak WebKit RSS: ${(remoteMemory.webkitRssKib / 1024).toFixed(1)} MiB`,
        `- Nitro local peak WebKit RSS: ${(localMemory.webkitRssKib / 1024).toFixed(1)} MiB (${delta(
          localMemory.webkitRssKib,
          remoteMemory.webkitRssKib
        )})`,
      ]
    : []),
  ...(remoteMemory.pssKib > 0 || localMemory.pssKib > 0
    ? [
        `- Direct WebView peak PSS: ${(remoteMemory.pssKib / 1024).toFixed(1)} MiB`,
        `- Nitro local peak PSS: ${(localMemory.pssKib / 1024).toFixed(1)} MiB (${delta(
          localMemory.pssKib,
          remoteMemory.pssKib
        )})`,
      ]
    : []),
  '',
  'Page-ready time is the user-visible comparison. Local storage time is reported separately and does not block the first remote page. Negative time/network deltas favor the Nitro local runtime. `local only` means the direct WebView could not complete while the fixture origin was unreachable.',
  '',
  '| Scenario | Phase | Direct page ms | Local page ms | Page delta | Local background storage ms | Direct network | Local network | Network delta | Direct peak RSS MiB | Local peak RSS MiB |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map((row) => `| ${row.join(' | ')} |`),
  '',
].join('\n');

await writeFile(outputPath, markdown);
process.stdout.write(markdown);
