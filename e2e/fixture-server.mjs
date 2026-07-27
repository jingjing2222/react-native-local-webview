import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareUnityFixture } from './fixtures/unity/prepare.mjs';

const MIB = 1024 * 1024;
const PORT = Number(process.env.BENCHMARK_PORT ?? 4173);
const HOST = process.env.BENCHMARK_HOST ?? '127.0.0.1';
const PUBLIC_ORIGIN =
  process.env.BENCHMARK_PUBLIC_ORIGIN ?? `https://macmini.taile38920.ts.net:8443`;
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const WORDLY_DIRECTORY = await prepareUnityFixture();
const WORKER_SOURCE = await readFile(join(ROOT, 'fixtures/unity/probe.worker.js'));
const PADDING = Buffer.alloc(1024 * 1024);
const GAME_SIZES = new Set([50, 200, 500]);
const RESOURCE_COUNTS = new Set([100, 500, 1000]);
const COOKIE = 'local-webview-benchmark=allowed';
const ETAG_VERSION = 'v2';

const state = {
  completed: false,
  offlinePrefixes: new Set(),
  reports: [],
  requests: [],
  runId: '',
};

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': String(body.byteLength),
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MIB) throw new Error('Control request body exceeded 1 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function hasBenchmarkCookie(request) {
  return String(request.headers.cookie ?? '')
    .split(';')
    .some((part) => part.trim() === COOKIE);
}

function cspHeaders(pathname) {
  if (!pathname.startsWith('/edge/')) return {};
  return {
    'Content-Security-Policy':
      "default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; connect-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'",
  };
}

function contentType(pathname) {
  if (pathname.endsWith('.data')) return 'application/octet-stream';
  if (pathname.endsWith('.html')) return 'text/html; charset=utf-8';
  if (pathname.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (pathname.endsWith('.json')) return 'application/json; charset=utf-8';
  if (pathname.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

function requestEtag(pathname, hasEtag) {
  return hasEtag ? `"${ETAG_VERSION}-${Buffer.from(pathname).toString('base64url')}"` : undefined;
}

function parseRange(value, total) {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= total ||
    start > end
  ) {
    return null;
  }
  return { end: Math.min(end, total - 1), start };
}

function beginTrackedResponse(request, response, pathname, status, bytes) {
  const record = {
    bytes,
    completedAt: undefined,
    ifNoneMatch: request.headers['if-none-match'],
    method: request.method,
    path: pathname,
    range: request.headers.range,
    startedAt: new Date().toISOString(),
    status,
  };
  state.requests.push(record);
  response.once('finish', () => {
    record.completedAt = new Date().toISOString();
  });
}

function respondBytes(
  request,
  response,
  pathname,
  bytes,
  { etag, headers = {}, status = 200 } = {}
) {
  if (etag && request.headers['if-none-match'] === etag) {
    beginTrackedResponse(request, response, pathname, 304, 0);
    response.writeHead(304, { ...headers, ETag: etag });
    response.end();
    return;
  }
  const range = parseRange(request.headers.range, bytes.byteLength);
  if (range === null) {
    beginTrackedResponse(request, response, pathname, 416, 0);
    response.writeHead(416, {
      ...headers,
      'Content-Range': `bytes */${bytes.byteLength}`,
      ...(etag ? { ETag: etag } : {}),
    });
    response.end();
    return;
  }
  const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
  const statusCode = range ? 206 : status;
  beginTrackedResponse(request, response, pathname, statusCode, body.byteLength);
  response.writeHead(statusCode, {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(body.byteLength),
    'Content-Type': contentType(pathname),
    ...(etag ? { ETag: etag } : {}),
    ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.byteLength}` } : {}),
    ...headers,
  });
  response.end(body);
}

async function pipeFileSegment(response, path, start, end) {
  if (end <= start) return;
  await new Promise((resolve, reject) => {
    const source = createReadStream(path, { end: end - 1, start });
    source.on('error', reject);
    source.on('end', resolve);
    source.on('data', (chunk) => {
      if (!response.write(chunk)) {
        source.pause();
        response.once('drain', () => source.resume());
      }
    });
  });
}

async function pipePadding(response, bytes) {
  let remaining = bytes;
  while (remaining > 0) {
    const chunk = PADDING.subarray(0, Math.min(PADDING.byteLength, remaining));
    remaining -= chunk.byteLength;
    if (!response.write(chunk)) {
      await new Promise((resolve) => response.once('drain', resolve));
    }
  }
}

async function respondPaddedData(
  request,
  response,
  pathname,
  path,
  total,
  { etag, headers = {} } = {}
) {
  if (etag && request.headers['if-none-match'] === etag) {
    beginTrackedResponse(request, response, pathname, 304, 0);
    response.writeHead(304, { ...headers, ETag: etag });
    response.end();
    return;
  }
  const range = parseRange(request.headers.range, total);
  if (range === null) {
    beginTrackedResponse(request, response, pathname, 416, 0);
    response.writeHead(416, {
      ...headers,
      'Content-Range': `bytes */${total}`,
      ...(etag ? { ETag: etag } : {}),
    });
    response.end();
    return;
  }
  const sourceSize = Number((await stat(path)).size);
  const start = range?.start ?? 0;
  const end = (range?.end ?? total - 1) + 1;
  const length = end - start;
  const statusCode = range ? 206 : 200;
  beginTrackedResponse(request, response, pathname, statusCode, length);
  response.writeHead(statusCode, {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(length),
    'Content-Type': 'application/octet-stream',
    ...(etag ? { ETag: etag } : {}),
    ...(range ? { 'Content-Range': `bytes ${start}-${end - 1}/${total}` } : {}),
    ...headers,
  });
  const fileStart = Math.min(start, sourceSize);
  const fileEnd = Math.min(end, sourceSize);
  await pipeFileSegment(response, path, fileStart, fileEnd);
  await pipePadding(response, Math.max(0, end - Math.max(start, sourceSize)));
  response.end();
}

function gameDocument(prefix, sizeMiB) {
  return Buffer.from(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
  <title>Local WebView Unity benchmark (${sizeMiB} MiB)</title>
  <style>
    html,body,#unity-container,#unity-canvas{width:100%;height:100%;margin:0;background:#111;color:#fff}
    #status{position:fixed;left:8px;right:8px;top:8px;z-index:2;padding:8px;background:#000b;font:12px monospace}
  </style>
</head>
<body>
  <div id="status">Preparing Unity ${sizeMiB} MiB fixture…</div>
  <div id="unity-container"><canvas id="unity-canvas"></canvas></div>
  <script>
    globalThis.__LOCAL_WEBVIEW_BENCHMARK__ = {
      prefix: ${JSON.stringify(prefix)},
      sizeMiB: ${sizeMiB},
      startedAt: performance.now()
    };
  </script>
  <script src="${prefix}/Builds.loader.js"></script>
  <script src="${prefix}/benchmark.js"></script>
</body>
</html>`);
}

function benchmarkScript(prefix) {
  return Buffer.from(`
(() => {
  const state = globalThis.__LOCAL_WEBVIEW_BENCHMARK__;
  const status = document.querySelector('#status');
  const post = (payload) => {
    const message = JSON.stringify({ channel: 'local-webview-benchmark:page', ...payload });
    globalThis.ReactNativeWebView?.postMessage(message);
  };
  const timed = async (name, operation) => {
    const start = performance.now();
    const value = await operation();
    return { name, milliseconds: performance.now() - start, value };
  };
  const workerProbe = () => new Promise((resolve, reject) => {
    const worker = new Worker(${JSON.stringify(`${prefix}/probe.worker.js`)});
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Worker probe timed out'));
    }, 10000);
    worker.onmessage = ({ data }) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(data);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || 'Worker probe failed'));
    };
    worker.postMessage('ping');
  });
  const readBody = async (response) => {
    const reader = response.body.getReader();
    let bytes = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) return bytes;
      bytes += result.value.byteLength;
    }
  };
  void (async () => {
    document.cookie = ${JSON.stringify(`${COOKIE}; Path=/; SameSite=Strict`)};
    const range = await timed('range', async () => {
      const response = await fetch(${JSON.stringify(`${prefix}/payload.data`)}, {
        headers: { Range: 'bytes=1024-65535' }
      });
      return {
        bytes: await readBody(response),
        contentRange: response.headers.get('content-range'),
        status: response.status
      };
    });
    const worker = await timed('worker', workerProbe);
    const cookie = state.prefix.startsWith('/edge/')
      ? await timed('cookie', async () => {
          const response = await fetch(
            new URL('/api/cookie?nonce=' + Date.now(), location.origin).href,
            { cache: 'no-store', credentials: 'include' }
          );
          return { body: await response.text(), status: response.status };
        })
      : { name: 'cookie', milliseconds: 0, value: { skipped: true } };
    const payload = await timed('payload', async () => {
      const response = await fetch(${JSON.stringify(`${prefix}/payload.data`)});
      return { bytes: await readBody(response), status: response.status };
    });
    const unity = await timed('unity', async () => {
      const canvas = document.querySelector('#unity-canvas');
      const config = {
        dataUrl: ${JSON.stringify(`${prefix}/Builds.data`)},
        frameworkUrl: ${JSON.stringify(`${prefix}/Builds.framework.js`)},
        codeUrl: ${JSON.stringify(`${prefix}/Builds.wasm`)},
        streamingAssetsUrl: ${JSON.stringify(`${prefix}/StreamingAssets`)},
        companyName: 'react-native-local-webview',
        productName: 'Wordly benchmark fixture',
        productVersion: '1.0'
      };
      await createUnityInstance(canvas, config, (progress) => {
        status.textContent = 'Unity loading ' + Math.round(progress * 100) + '%';
      });
      return { canvasHeight: canvas.height, canvasWidth: canvas.width };
    });
    status.textContent = 'Benchmark ready';
    post({
      kind: 'ready',
      metrics: {
        cookie,
        elapsedMilliseconds: performance.now() - state.startedAt,
        origin: location.origin,
        payload,
        range,
        secureContext: isSecureContext,
        unity,
        worker
      }
    });
  })().catch((error) => {
    status.textContent = String(error?.message || error);
    post({ kind: 'error', message: String(error?.stack || error) });
  });
})();
`);
}

function resourceDocument(prefix, count) {
  const scripts = Array.from(
    { length: count },
    (_, index) => `<script src="${prefix}/assets/${index}.js"></script>`
  ).join('');
  return Buffer.from(`<!doctype html><html><head><meta charset="utf-8"></head><body>
${scripts}
<script>
  window.ReactNativeWebView?.postMessage(JSON.stringify({
    channel: 'local-webview-benchmark:page',
    kind: 'ready',
    metrics: {
      loadedResources: globalThis.__benchmarkResources?.size || 0,
      origin: location.origin,
      secureContext: isSecureContext
    }
  }));
</script></body></html>`);
}

async function handleControl(request, response, url) {
  if (url.pathname === '/__control/health') {
    json(response, 200, { ok: true, origin: PUBLIC_ORIGIN });
    return true;
  }
  if (url.pathname === '/__control/reset' && request.method === 'POST') {
    const body = await requestBody(request);
    state.completed = false;
    state.offlinePrefixes.clear();
    state.reports = [];
    state.requests = [];
    state.runId = String(body.runId ?? '');
    json(response, 200, { ok: true, runId: state.runId });
    return true;
  }
  if (url.pathname === '/__control/offline' && request.method === 'POST') {
    const body = await requestBody(request);
    const prefix = String(body.prefix ?? '');
    if (!prefix.startsWith('/')) {
      json(response, 400, { error: 'prefix must start with /' });
      return true;
    }
    if (body.offline === false) state.offlinePrefixes.delete(prefix);
    else state.offlinePrefixes.add(prefix);
    json(response, 200, { offline: [...state.offlinePrefixes] });
    return true;
  }
  if (url.pathname === '/__control/report' && request.method === 'POST') {
    const body = await requestBody(request);
    state.reports.push({ ...body, receivedAt: new Date().toISOString() });
    json(response, 200, { accepted: true });
    return true;
  }
  if (url.pathname === '/__control/complete' && request.method === 'POST') {
    const body = await requestBody(request);
    state.completed = true;
    state.reports.push({ ...body, kind: 'complete', receivedAt: new Date().toISOString() });
    json(response, 200, { accepted: true });
    return true;
  }
  if (url.pathname === '/__control/results') {
    json(response, 200, {
      completed: state.completed,
      offlinePrefixes: [...state.offlinePrefixes],
      origin: PUBLIC_ORIGIN,
      reports: state.reports,
      requests: state.requests,
      runId: state.runId,
    });
    return true;
  }
  return false;
}

async function handleFixture(request, response, url) {
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  for (const prefix of state.offlinePrefixes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const now = new Date().toISOString();
      state.requests.push({
        bytes: 0,
        completedAt: now,
        ifNoneMatch: request.headers['if-none-match'],
        method: request.method,
        path: pathname,
        range: request.headers.range,
        startedAt: now,
        status: 0,
      });
      request.socket.destroy();
      return;
    }
  }
  if (pathname === '/api/cookie') {
    const allowed = hasBenchmarkCookie(request);
    respondBytes(
      request,
      response,
      pathname,
      Buffer.from(allowed ? 'cookie-ok' : 'cookie-required'),
      {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
          ...cspHeaders(pathname),
        },
        status: allowed ? 200 : 401,
      }
    );
    return;
  }

  const resourceMatch = /^\/resources\/(100|500|1000)(\/.*)?$/.exec(pathname);
  if (resourceMatch) {
    const count = Number(resourceMatch[1]);
    if (!RESOURCE_COUNTS.has(count)) return false;
    const prefix = `/resources/${count}`;
    let body;
    if (!resourceMatch[2] || resourceMatch[2] === '/index.html') {
      body = resourceDocument(prefix, count);
    } else {
      const asset = /^\/assets\/(\d+)\.js$/.exec(resourceMatch[2]);
      if (!asset || Number(asset[1]) >= count) return false;
      body = Buffer.from(
        `globalThis.__benchmarkResources ??= new Set();globalThis.__benchmarkResources.add(${asset[1]});`
      );
    }
    respondBytes(request, response, pathname, body, {
      etag: requestEtag(pathname, true),
    });
    return true;
  }

  const gameMatch = /^\/(game|edge)\/(50|200|500)\/(etag|no-etag)(\/.*)?$/.exec(pathname);
  if (!gameMatch) return false;
  const kind = gameMatch[1];
  const sizeMiB = Number(gameMatch[2]);
  const hasEtag = gameMatch[3] === 'etag';
  if (!GAME_SIZES.has(sizeMiB)) return false;
  const prefix = `/${kind}/${sizeMiB}/${gameMatch[3]}`;
  const suffix = gameMatch[4] || '/index.html';
  const headers = cspHeaders(pathname);
  if (kind === 'edge' && !hasBenchmarkCookie(request)) {
    respondBytes(request, response, pathname, Buffer.from('cookie-required'), {
      headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
      status: 401,
    });
    return true;
  }
  const etag = requestEtag(pathname, hasEtag);
  if (suffix === '/index.html') {
    respondBytes(request, response, pathname, gameDocument(prefix, sizeMiB), {
      etag,
      headers,
    });
    return true;
  }
  if (suffix === '/benchmark.js') {
    respondBytes(request, response, pathname, benchmarkScript(prefix), { etag, headers });
    return true;
  }
  if (suffix === '/probe.worker.js') {
    respondBytes(request, response, pathname, WORKER_SOURCE, { etag, headers });
    return true;
  }
  if (suffix === '/payload.data') {
    await respondPaddedData(
      request,
      response,
      pathname,
      join(WORDLY_DIRECTORY, 'Builds.data'),
      sizeMiB * MIB,
      { etag, headers }
    );
    return true;
  }
  const fileName = basename(suffix);
  if (
    !['Builds.data', 'Builds.framework.js', 'Builds.loader.js', 'Builds.wasm'].includes(fileName)
  ) {
    return false;
  }
  const path = join(WORDLY_DIRECTORY, fileName);
  respondBytes(request, response, pathname, await readFile(path), { etag, headers });
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (await handleControl(request, response, url)) return;
    if (await handleFixture(request, response, url)) return;
    json(response, 404, { error: 'not found' });
  } catch (error) {
    if (response.headersSent) response.destroy(error);
    else json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `Benchmark fixture listening on http://${HOST}:${PORT}; public origin ${PUBLIC_ORIGIN}\n`
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
