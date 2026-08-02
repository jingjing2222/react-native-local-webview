import { readFile, writeFile } from 'node:fs/promises';

const [resultPath, memoryPath, outputPath] = process.argv.slice(2);
if (!resultPath || !memoryPath || !outputPath) {
  throw new Error('Usage: summarize-benchmark.mjs results.json memory.csv report.md');
}

const result = JSON.parse(await readFile(resultPath, 'utf8'));
const memoryLines = (await readFile(memoryPath, 'utf8')).trim().split('\n');
const memoryHeader = memoryLines.shift()?.split(',') ?? [];
const memoryRows = memoryLines.map((line) =>
  Object.fromEntries(line.split(',').map((value, index) => [memoryHeader[index], Number(value)]))
);
const peakRssKib = Math.max(0, ...memoryRows.map((row) => row.total_rss_kib ?? 0));
const peakPssKib = Math.max(0, ...memoryRows.map((row) => row.total_pss_kib ?? 0));
const peakHostRssKib = Math.max(0, ...memoryRows.map((row) => row.host_rss_kib ?? 0));
const peakWebkitRssKib = Math.max(0, ...memoryRows.map((row) => row.webkit_rss_kib ?? 0));
const scenarioStarts = result.reports.filter((report) => report.kind === 'scenario-start');
const scenarioResults = result.reports.filter((report) => report.kind === 'scenario-result');
const failures = [];
const completion = result.reports.findLast((report) => report.kind === 'complete');
const suite = completion?.suite === 'smoke' ? 'smoke' : 'full';
const runtime = completion?.runtime === 'remote' ? 'remote' : completion?.runtime || 'local';
const isRemote = runtime === 'remote';
const expectedScenarioCount = suite === 'smoke' ? (isRemote ? 7 : 9) : isRemote ? 17 : 19;

if (completion?.error) failures.push(`The benchmark application failed: ${completion.error}`);
if (scenarioResults.length !== expectedScenarioCount) {
  failures.push(
    `The ${suite} suite completed ${scenarioResults.length}/${expectedScenarioCount} scenario phases.`
  );
}

const requestsFor = (scenario) => {
  const start = scenarioStarts.find(
    (candidate) =>
      candidate.label === scenario.label &&
      candidate.phase === scenario.phase &&
      candidate.receivedAt <= scenario.receivedAt
  );
  if (!start) return [];
  return result.requests.filter(
    (request) => request.startedAt >= start.receivedAt && request.startedAt <= scenario.receivedAt
  );
};

for (const scenario of scenarioResults) {
  const requests = requestsFor(scenario);
  const value = scenario.result;
  if (scenario.phase === 'csp-rejected') {
    if (!value?.expectedError || !/content-security-policy/i.test(value.error ?? '')) {
      failures.push('CSP was not rejected before the explicit bypass.');
    }
    continue;
  }
  if (isRemote && scenario.phase === 'offline' && value?.expectedError) {
    continue;
  }
  if (!isRemote && scenario.label.endsWith('-no-etag')) {
    if (!value?.expectedError || !/entry response to include an ETag/i.test(value.error ?? '')) {
      failures.push(`${scenario.label}/${scenario.phase} accepted a release without an ETag.`);
    }
    continue;
  }
  if (!value?.page || (!isRemote && !value.storedBundle)) {
    failures.push(
      `${scenario.label}/${scenario.phase} did not produce the required runtime and page metrics.`
    );
    continue;
  }
  if (value.page.origin !== result.origin || value.page.secureContext !== true) {
    failures.push(`${scenario.label}/${scenario.phase} lost its secure HTTPS origin.`);
  }
  if (scenario.phase === 'offline') {
    if (
      !isRemote &&
      (value.bundle?.usedCachedBundle !== true || !requests.some((request) => request.status === 0))
    ) {
      failures.push(`${scenario.label}/offline did not fall back after an unreachable origin.`);
    }
  }
  if (!isRemote && scenario.phase === 'warm-304') {
    const notModified = requests.filter((request) => request.status === 304).length;
    if (notModified !== 1) {
      failures.push(
        `${scenario.label}/warm-304 used ${notModified} conditional responses instead of one release 304.`
      );
    }
  }
  if (scenario.label === 'csp-cookie-range-worker' && scenario.phase === 'csp-bypass') {
    const range = value.page.range?.value;
    const worker = value.page.worker?.value;
    const cookie = value.page.cookie?.value;
    if (
      range?.status !== 206 ||
      range?.bytes !== 64_512 ||
      range?.contentRange !== 'bytes 1024-65535/52428800'
    ) {
      failures.push('The cached Range fetch did not return the requested verified byte slice.');
    }
    if (worker?.kind !== 'pong' || worker?.origin !== result.origin) {
      failures.push('The localized Worker did not execute under the virtual origin.');
    }
    if (cookie?.status !== 200 || cookie?.body !== 'cookie-ok') {
      failures.push('The same-origin cookie request failed.');
    }
  }
  const unitySize = /^unity-(\d+)MiB-/.exec(scenario.label)?.[1];
  if (
    unitySize &&
    (value.page.payload?.value?.status !== 200 ||
      value.page.payload?.value?.bytes !== Number(unitySize) * 1024 * 1024)
  ) {
    failures.push(`${scenario.label}/${scenario.phase} did not stream its complete local payload.`);
  }
  const resourceCount = /^resources-(\d+)$/.exec(scenario.label)?.[1];
  if (resourceCount && value.page.loadedResources !== Number(resourceCount)) {
    failures.push(
      `${scenario.label}/${scenario.phase} executed ${value.page.loadedResources} resources.`
    );
  }
}

const rows = scenarioResults.map((scenario) => {
  const value = scenario.result ?? {};
  const requests = requestsFor(scenario);
  const start = scenarioStarts.find(
    (candidate) =>
      candidate.label === scenario.label &&
      candidate.phase === scenario.phase &&
      candidate.receivedAt <= scenario.receivedAt
  );
  const startMilliseconds = start ? Date.parse(start.receivedAt) : Number.NaN;
  const endMilliseconds = Date.parse(scenario.receivedAt);
  const phasePeakRssKib = Math.max(
    0,
    ...memoryRows
      .filter((row) => row.timestamp_ms >= startMilliseconds && row.timestamp_ms <= endMilliseconds)
      .map((row) => row.total_rss_kib ?? 0)
  );
  const phaseMemoryRows = memoryRows.filter(
    (row) => row.timestamp_ms >= startMilliseconds && row.timestamp_ms <= endMilliseconds
  );
  const phasePeakHostRssKib = Math.max(0, ...phaseMemoryRows.map((row) => row.host_rss_kib ?? 0));
  const phasePeakWebkitRssKib = Math.max(
    0,
    ...phaseMemoryRows.map((row) => row.webkit_rss_kib ?? 0)
  );
  return [
    scenario.label,
    scenario.phase,
    value.pageReadyMilliseconds?.toFixed?.(0) ?? '—',
    value.storageReadyMilliseconds?.toFixed?.(0) ?? '—',
    value.totalMilliseconds?.toFixed?.(0) ?? '—',
    value.bridge?.mebibytesPerSecond?.toFixed?.(2) ?? '—',
    String(value.bundle?.usedCachedBundle ?? false),
    String(requests.filter((request) => request.status === 304).length),
    String(requests.reduce((sum, request) => sum + (request.bytes || 0), 0)),
    ...(peakHostRssKib > 0
      ? [
          phasePeakHostRssKib > 0 ? (phasePeakHostRssKib / 1024).toFixed(1) : '—',
          phasePeakWebkitRssKib > 0 ? (phasePeakWebkitRssKib / 1024).toFixed(1) : '—',
        ]
      : []),
    phasePeakRssKib > 0 ? (phasePeakRssKib / 1024).toFixed(1) : '—',
  ];
});

const markdown = [
  `# Production benchmark: ${result.runId}`,
  '',
  `- Origin: \`${result.origin}\``,
  `- Runtime: \`${runtime}\``,
  `- Peak RSS: ${(peakRssKib / 1024).toFixed(1)} MiB`,
  ...(peakHostRssKib > 0
    ? [
        `- Peak app-host RSS: ${(peakHostRssKib / 1024).toFixed(1)} MiB`,
        `- Peak WebKit RSS: ${(peakWebkitRssKib / 1024).toFixed(1)} MiB`,
      ]
    : []),
  ...(peakPssKib > 0 ? [`- Peak PSS: ${(peakPssKib / 1024).toFixed(1)} MiB`] : []),
  `- Verdict: ${failures.length === 0 ? 'PASS' : 'FAIL'}`,
  '',
  peakHostRssKib > 0
    ? '| Scenario | Phase | Page ready ms | Background storage ms | Total ms | Bridge MiB/s | Displayed local | 304 | Network bytes | Peak app MiB | Peak WebKit MiB | Peak combined MiB |'
    : '| Scenario | Phase | Page ready ms | Background storage ms | Total ms | Bridge MiB/s | Displayed local | 304 | Network bytes | Peak RSS MiB |',
  peakHostRssKib > 0
    ? '| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |'
    : '| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |',
  ...rows.map((row) => `| ${row.join(' | ')} |`),
  '',
  '## Validation',
  '',
  ...(failures.length === 0
    ? ['All benchmark invariants passed.']
    : failures.map((item) => `- ${item}`)),
  '',
].join('\n');

await writeFile(outputPath, markdown);
process.stdout.write(markdown);
if (failures.length > 0) process.exitCode = 1;
