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
const scenarioStarts = result.reports.filter((report) => report.kind === 'scenario-start');
const scenarioResults = result.reports.filter((report) => report.kind === 'scenario-result');
const failures = [];
const completion = result.reports.findLast((report) => report.kind === 'complete');
const suite = completion?.suite === 'smoke' ? 'smoke' : 'full';
const expectedScenarioCount = suite === 'smoke' ? 9 : 19;

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
  if (!value?.bundle || !value?.page) {
    failures.push(`${scenario.label}/${scenario.phase} did not produce bundle and page metrics.`);
    continue;
  }
  if (value.page.origin !== result.origin || value.page.secureContext !== true) {
    failures.push(`${scenario.label}/${scenario.phase} lost its secure HTTPS origin.`);
  }
  if (scenario.phase === 'offline') {
    if (
      value.bundle.usedCachedBundle !== true ||
      !requests.some((request) => request.status === 0)
    ) {
      failures.push(`${scenario.label}/offline did not fall back after an unreachable origin.`);
    }
  }
  if (scenario.phase === 'warm-304') {
    const expected = value.bundle.downloadedAssets.length;
    const notModified = requests.filter((request) => request.status === 304).length;
    if (notModified !== expected) {
      failures.push(
        `${scenario.label}/warm-304 revalidated ${notModified}/${expected} resources with 304.`
      );
    }
  }
  if (scenario.phase === 'warm-no-etag') {
    if (!requests.some((request) => request.status === 200 || request.status === 206)) {
      failures.push(`${scenario.label}/warm-no-etag did not redownload ETag-less resources.`);
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
  return [
    scenario.label,
    scenario.phase,
    value.bundleReadyMilliseconds?.toFixed?.(0) ?? '—',
    value.totalMilliseconds?.toFixed?.(0) ?? '—',
    value.bridge?.mebibytesPerSecond?.toFixed?.(2) ?? '—',
    String(value.bundle?.usedCachedBundle ?? '—'),
    String(requests.filter((request) => request.status === 304).length),
    String(requests.reduce((sum, request) => sum + (request.bytes || 0), 0)),
  ];
});

const markdown = [
  `# Production benchmark: ${result.runId}`,
  '',
  `- Origin: \`${result.origin}\``,
  `- Peak RSS: ${(peakRssKib / 1024).toFixed(1)} MiB`,
  ...(peakPssKib > 0 ? [`- Peak PSS: ${(peakPssKib / 1024).toFixed(1)} MiB`] : []),
  `- Verdict: ${failures.length === 0 ? 'PASS' : 'FAIL'}`,
  '',
  '| Scenario | Phase | Bundle ready ms | Total ms | Bridge MiB/s | Cached | 304 | Network bytes |',
  '| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |',
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
