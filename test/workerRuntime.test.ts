import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { WORKER_ASSET_MESSAGE_CHANNEL } from '../src/assetBridgeProtocol';
import { createWorkerRuntimeBootstrap } from '../src/workerRuntime';

type PortMessage = {
  data: Record<string, unknown>;
  ports: TestMessagePort[];
};

class TestMessagePort {
  closed = false;
  onmessage: ((event: PortMessage) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  peer?: TestMessagePort;
  readonly listeners: Array<(event: PortMessage) => void> = [];

  addEventListener(name: string, listener: (event: PortMessage) => void): void {
    if (name === 'message') this.listeners.push(listener);
  }

  close(): void {
    this.closed = true;
  }

  postMessage(data: Record<string, unknown>, ports: TestMessagePort[] = []): void {
    const peer = this.peer;
    if (!peer || this.closed) {
      throw new Error('MessagePort is closed');
    }
    if (peer.closed) return;
    queueMicrotask(() => {
      const event = { data, ports };
      peer.onmessage?.(event);
      for (const listener of peer.listeners) listener(event);
    });
  }

  start(): void {}
}

class TestMessageChannel {
  readonly port1 = new TestMessagePort();
  readonly port2 = new TestMessagePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

class TestProgressEvent extends Event {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;

  constructor(
    type: string,
    init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}
  ) {
    super(type);
    this.lengthComputable = init.lengthComputable ?? false;
    this.loaded = init.loaded ?? 0;
    this.total = init.total ?? 0;
  }
}

class TestNativeXMLHttpRequest extends EventTarget {
  readyState = 0;
  response: unknown = null;
  responseText = '';
  responseType: XMLHttpRequestResponseType = '';
  responseURL = '';
  responseXML: Document | null = null;
  status = 0;
  statusText = '';
  timeout = 0;
  upload = {};
  withCredentials = false;

  abort(): void {}
  getAllResponseHeaders(): string {
    return '';
  }
  getResponseHeader(): string | null {
    return null;
  }
  open(): void {
    this.readyState = 1;
  }
  overrideMimeType(): void {}
  send(): void {}
  setRequestHeader(): void {}
}

class ControlledNativeXMLHttpRequest extends TestNativeXMLHttpRequest {
  static readonly instances: ControlledNativeXMLHttpRequest[] = [];
  aborted = false;

  constructor() {
    super();
    ControlledNativeXMLHttpRequest.instances.push(this);
  }

  override abort(): void {
    this.aborted = true;
  }

  complete(text: string): void {
    this.readyState = 4;
    this.response = text;
    this.responseText = text;
    this.status = 200;
    this.statusText = 'OK';
    this.dispatchEvent(new Event('readystatechange'));
    this.dispatchEvent(new Event('load'));
    this.dispatchEvent(new Event('loadend'));
  }
}

type WorkerRuntime = {
  context: Record<string, unknown>;
  connectShared: (port: TestMessagePort) => void;
  networkFetch: ReturnType<typeof vi.fn>;
  requests: Array<Record<string, unknown>>;
};

function workerRuntime(
  localAssetUrl: string,
  configureRequest: (request: Record<string, unknown>, port: TestMessagePort) => void,
  shared = false,
  extraContext: Record<string, unknown> = {}
): WorkerRuntime {
  const requests: Array<Record<string, unknown>> = [];
  const connectListeners: Array<(event: { ports: TestMessagePort[] }) => void> = [];
  const networkFetch = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new Response(`network:${url}`);
  });
  const receiveRequest = (
    request: Record<string, unknown>,
    transferred: TestMessagePort[]
  ): void => {
    requests.push(request);
    const port = transferred[0];
    if (port) configureRequest(request, port);
  };
  const context: Record<string, unknown> = {
    AbortController,
    ArrayBuffer,
    Blob,
    DOMException,
    Event,
    EventTarget,
    MessageChannel: TestMessageChannel,
    ProgressEvent: TestProgressEvent,
    ReadableStream,
    Response,
    TextDecoder,
    URL,
    Uint8Array,
    XMLHttpRequest: TestNativeXMLHttpRequest,
    addEventListener: (name: string, listener: (event: { ports: TestMessagePort[] }) => void) => {
      if (name === 'connect') connectListeners.push(listener);
    },
    clearTimeout,
    fetch: networkFetch,
    setTimeout,
    ...extraContext,
    ...(shared
      ? {}
      : {
          postMessage: (request: Record<string, unknown>, transferred: TestMessagePort[] = []) =>
            receiveRequest(request, transferred),
        }),
  };
  vm.runInNewContext(
    createWorkerRuntimeBootstrap('https://game.example/workers/main.js', [localAssetUrl]),
    context
  );

  return {
    connectShared: (workerPort) => {
      for (const listener of connectListeners) listener({ ports: [workerPort] });
    },
    context,
    networkFetch,
    requests,
  };
}

function streamAsset(
  bytes: Uint8Array,
  request: Record<string, unknown>,
  port: TestMessagePort,
  responseMetadata: { redirected?: boolean; url?: string } = {}
): void {
  const requestId = String(request.requestId);
  port.addEventListener('message', (event) => {
    if (event.data.kind === 'ack') {
      port.postMessage({ kind: 'end', requestId });
    }
  });
  port.postMessage({
    headers: [
      ['Content-Length', String(bytes.byteLength)],
      ['Content-Type', 'application/wasm'],
    ],
    kind: 'response',
    ...responseMetadata,
    requestId,
    status: 200,
    statusText: 'OK',
  });
  const data = bytes.slice().buffer;
  port.postMessage({ data, kind: 'chunk', requestId, sequence: 0 });
}

function attachSharedParent(
  parentPort: TestMessagePort,
  receiveRequest: (request: Record<string, unknown>, port: TestMessagePort) => void
): void {
  parentPort.addEventListener('message', (event) => {
    const request = event.data;
    const transferredPort = event.ports[0];
    if (request.kind === 'probe') {
      transferredPort?.postMessage({
        kind: 'probe-ack',
        probeId: request.probeId,
      });
      transferredPort?.close();
      return;
    }
    if (transferredPort) receiveRequest(request, transferredPort);
  });
}

describe('generated worker local-asset runtime', () => {
  const assetUrl = 'https://game.example/Build/game.wasm';
  const assetBytes = new Uint8Array([0, 97, 115, 109]);

  it('streams a known asset through the dedicated-worker relay with ACK backpressure', async () => {
    const runtime = workerRuntime(assetUrl, (request, port) => {
      streamAsset(assetBytes, request, port);
    });
    const fetchFromWorker = runtime.context.fetch as typeof fetch;

    const response = await fetchFromWorker('../Build/game.wasm', {
      integrity: 'sha512-test',
    });
    expect(response.url).toBe(assetUrl);
    expect(response.clone().url).toBe(assetUrl);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(assetBytes);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]).toMatchObject({
      channel: WORKER_ASSET_MESSAGE_CHANNEL,
      integrity: 'sha512-test',
      kind: 'request',
      url: assetUrl,
    });
    expect(runtime.networkFetch).not.toHaveBeenCalled();
  });

  it('leaves non-inventory fetches on the native worker network path', async () => {
    const runtime = workerRuntime(assetUrl, () => {
      throw new Error('Unexpected relay request');
    });
    const fetchFromWorker = runtime.context.fetch as typeof fetch;

    const response = await fetchFromWorker('../api/state');

    expect(await response.text()).toBe('network:https://game.example/api/state');
    expect(runtime.requests).toEqual([]);
    expect(runtime.networkFetch).toHaveBeenCalledOnce();
  });

  it('preserves final redirect metadata for worker fetch and XMLHttpRequest', async () => {
    const responseUrl = 'https://game.example/releases/v2/game.wasm';
    const runtime = workerRuntime(assetUrl, (request, port) => {
      streamAsset(assetBytes, request, port, { redirected: true, url: responseUrl });
    });
    const fetchFromWorker = runtime.context.fetch as typeof fetch;

    const response = await fetchFromWorker(assetUrl);
    expect(response.url).toBe(responseUrl);
    expect(response.redirected).toBe(true);
    expect(response.clone().url).toBe(responseUrl);
    expect(response.clone().redirected).toBe(true);
    await response.arrayBuffer();

    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    xhr.open('GET', assetUrl);
    xhr.responseType = 'arraybuffer';
    const loaded = new Promise<void>((resolve, reject) => {
      xhr.onload = () => resolve();
      xhr.onerror = () => reject(new Error('redirected Worker XHR relay failed'));
    });
    xhr.send();
    await loaded;

    expect(xhr.responseURL).toBe(responseUrl);
  });

  it('serves a known asset to worker XMLHttpRequest', async () => {
    const runtime = workerRuntime(assetUrl, (request, port) => {
      streamAsset(assetBytes, request, port);
    });
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    const states: number[] = [];
    xhr.onreadystatechange = () => states.push(xhr.readyState);
    xhr.open('GET', '../Build/game.wasm');
    xhr.responseType = 'arraybuffer';
    expect(xhr.responseURL).toBe('');
    const loaded = new Promise<void>((resolve, reject) => {
      xhr.onload = () => resolve();
      xhr.onerror = () => reject(new Error('Worker XHR relay failed'));
    });

    xhr.send();
    expect(xhr.readyState).toBe(Xhr.OPENED);
    expect(() => xhr.setRequestHeader('X-Late', 'value')).toThrow(
      'not opened or has already been sent'
    );
    await loaded;

    expect(new Uint8Array(xhr.response as ArrayBuffer)).toEqual(assetBytes);
    expect(xhr.status).toBe(200);
    expect(xhr.responseURL).toBe(assetUrl);
    expect(() => xhr.responseText).toThrow('responseText is unavailable');
    expect(states).toEqual([Xhr.OPENED, Xhr.HEADERS_RECEIVED, Xhr.LOADING, Xhr.DONE]);
    expect(runtime.networkFetch).not.toHaveBeenCalled();
  });

  it('ends an active worker XMLHttpRequest abort at UNSENT after abort events', () => {
    const runtime = workerRuntime(assetUrl, () => {});
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    const events: string[] = [];
    xhr.open('GET', assetUrl);
    xhr.addEventListener('readystatechange', () => events.push(`state:${xhr.readyState}`));
    xhr.addEventListener('abort', () => events.push(`abort:${xhr.readyState}`));
    xhr.addEventListener('loadend', () => events.push(`loadend:${xhr.readyState}`));
    xhr.send();

    xhr.abort();

    expect(events).toEqual([`state:${Xhr.DONE}`, `abort:${Xhr.DONE}`, `loadend:${Xhr.DONE}`]);
    expect(xhr.readyState).toBe(Xhr.UNSENT);
    expect(xhr.status).toBe(0);
    expect(xhr.statusText).toBe('');
    expect(xhr.response).toBeNull();
    expect(xhr.responseURL).toBe('');
    expect(xhr.getAllResponseHeaders()).toBe('');
  });

  it('uses native worker XMLHttpRequest abort semantics before and after an active request', async () => {
    const runtime = workerRuntime(assetUrl, (request, port) => {
      streamAsset(assetBytes, request, port);
    });
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    const events: string[] = [];
    for (const name of ['readystatechange', 'abort', 'loadend'] as const) {
      xhr.addEventListener(name, () => events.push(name));
    }

    xhr.open('GET', assetUrl);
    events.length = 0;
    xhr.abort();
    expect(xhr.readyState).toBe(Xhr.OPENED);
    expect(events).toEqual([]);

    const loaded = new Promise<void>((resolve, reject) => {
      xhr.onload = () => resolve();
      xhr.onerror = () => reject(new Error('Worker XHR relay failed'));
    });
    xhr.send();
    await loaded;
    events.length = 0;
    xhr.abort();

    expect(events).toEqual([]);
    expect(xhr.readyState).toBe(Xhr.UNSENT);
    expect(xhr.status).toBe(0);
    expect(xhr.response).toBeNull();
    expect(xhr.responseURL).toBe('');
  });

  it('clears worker XMLHttpRequest response metadata after a verified-size failure', async () => {
    const runtime = workerRuntime(assetUrl, (request, port) => {
      const requestId = String(request.requestId);
      port.postMessage({
        headers: [
          ['Content-Length', String(assetBytes.byteLength + 1)],
          ['Content-Type', 'application/wasm'],
        ],
        kind: 'response',
        requestId,
        status: 200,
        statusText: 'OK',
        url: assetUrl,
      });
      port.postMessage({
        data: assetBytes.slice().buffer,
        kind: 'chunk',
        requestId,
        sequence: 0,
      });
      port.addEventListener('message', (event) => {
        if (event.data.kind === 'ack') port.postMessage({ kind: 'end', requestId });
      });
    });
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    xhr.open('GET', assetUrl);
    xhr.responseType = 'arraybuffer';
    const failed = new Promise<void>((resolve) => {
      xhr.onerror = () => resolve();
    });

    xhr.send();
    await failed;

    expect(xhr.readyState).toBe(Xhr.DONE);
    expect(xhr.status).toBe(0);
    expect(xhr.statusText).toBe('');
    expect(xhr.response).toBeNull();
    expect(xhr.responseURL).toBe('');
    expect(xhr.getAllResponseHeaders()).toBe('');
  });

  it('keeps local XMLHttpRequest send() synchronous and rejects invalid send states', async () => {
    const runtime = workerRuntime(assetUrl, (request, port) => {
      streamAsset(assetBytes, request, port);
    });
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();

    expect(() => xhr.open('GET', assetUrl, false)).toThrow('Synchronous XHR is not supported');
    expect(() => xhr.send()).toThrow('not opened or has already been sent');

    xhr.open('GET', assetUrl);
    xhr.responseType = 'arraybuffer';
    const loaded = new Promise<void>((resolve, reject) => {
      xhr.onload = () => resolve();
      xhr.onerror = () => reject(new Error('Worker XHR relay failed'));
    });

    expect(xhr.send()).toBeUndefined();
    expect(() => xhr.send()).toThrow('not opened or has already been sent');
    await loaded;
  });

  it('returns null and fires load for an invalid local JSON response', async () => {
    const invalidJson = new TextEncoder().encode('{"unfinished":');
    const runtime = workerRuntime(assetUrl, (request, port) => {
      streamAsset(invalidJson, request, port);
    });
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    xhr.open('GET', assetUrl);
    xhr.responseType = 'json';
    const loaded = new Promise<void>((resolve, reject) => {
      xhr.onload = () => resolve();
      xhr.onerror = () => reject(new Error('Invalid JSON must not become a network error'));
    });

    xhr.send();
    await loaded;

    expect(xhr.response).toBeNull();
    expect(xhr.status).toBe(200);
  });

  it('uses the latest SharedWorker connection after an earlier owner closes', async () => {
    const firstParentPort = new TestMessagePort();
    const firstWorkerPort = new TestMessagePort();
    firstParentPort.peer = firstWorkerPort;
    firstWorkerPort.peer = firstParentPort;
    const secondParentPort = new TestMessagePort();
    const secondWorkerPort = new TestMessagePort();
    secondParentPort.peer = secondWorkerPort;
    secondWorkerPort.peer = secondParentPort;
    const runtime = workerRuntime(
      assetUrl,
      () => {
        throw new Error('Dedicated transport must not be used');
      },
      true
    );
    attachSharedParent(secondParentPort, (request, relayPort) => {
      runtime.requests.push(request);
      streamAsset(assetBytes, request, relayPort);
    });
    runtime.connectShared(firstWorkerPort);
    firstParentPort.close();
    runtime.connectShared(secondWorkerPort);
    const fetchFromWorker = runtime.context.fetch as typeof fetch;

    const response = await fetchFromWorker(assetUrl);

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(assetBytes);
    expect(runtime.requests).toHaveLength(1);
  });

  it('falls back to an earlier live SharedWorker owner when the latest owner closes', async () => {
    const firstParentPort = new TestMessagePort();
    const firstWorkerPort = new TestMessagePort();
    firstParentPort.peer = firstWorkerPort;
    firstWorkerPort.peer = firstParentPort;
    const secondParentPort = new TestMessagePort();
    const secondWorkerPort = new TestMessagePort();
    secondParentPort.peer = secondWorkerPort;
    secondWorkerPort.peer = secondParentPort;
    const runtime = workerRuntime(
      assetUrl,
      () => {
        throw new Error('Dedicated transport must not be used');
      },
      true
    );
    const owners: string[] = [];
    attachSharedParent(firstParentPort, (request, relayPort) => {
      owners.push('first');
      runtime.requests.push(request);
      streamAsset(assetBytes, request, relayPort);
    });
    attachSharedParent(secondParentPort, (request) => {
      owners.push('second');
      runtime.requests.push(request);
    });
    runtime.connectShared(firstWorkerPort);
    runtime.connectShared(secondWorkerPort);
    secondParentPort.close();
    const fetchFromWorker = runtime.context.fetch as typeof fetch;

    const response = await fetchFromWorker(assetUrl);

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(assetBytes);
    expect(owners).toEqual(['first']);
    expect(runtime.requests).toHaveLength(1);
  });

  it('acknowledges a nested SharedWorker parent probe before relaying asset requests', async () => {
    const parentEndpoint = new TestMessagePort();
    const childEndpoint = new TestMessagePort();
    parentEndpoint.peer = childEndpoint;
    childEndpoint.peer = parentEndpoint;
    class TestNativeSharedWorker {
      readonly port = parentEndpoint;
    }
    const runtime = workerRuntime(
      assetUrl,
      () => {
        throw new Error('A liveness probe must not open an asset stream');
      },
      false,
      { SharedWorker: TestNativeSharedWorker }
    );
    const SharedWorkerConstructor = runtime.context.SharedWorker as new (
      url: string
    ) => TestNativeSharedWorker;
    new SharedWorkerConstructor('./nested.js');
    const probeChannel = new TestMessageChannel();
    const acknowledgement = new Promise<Record<string, unknown>>((resolve) => {
      probeChannel.port1.onmessage = (event) => resolve(event.data);
    });

    childEndpoint.postMessage(
      {
        channel: WORKER_ASSET_MESSAGE_CHANNEL,
        kind: 'probe',
        probeId: 'nested-probe',
      },
      [probeChannel.port2]
    );

    await expect(acknowledgement).resolves.toMatchObject({
      kind: 'probe-ack',
      probeId: 'nested-probe',
    });
    expect(runtime.requests).toEqual([]);
  });

  it('isolates an in-flight local XHR when open() starts another local request', async () => {
    let requestCount = 0;
    const secondBytes = new Uint8Array([9, 8, 7]);
    const runtime = workerRuntime(assetUrl, (request, port) => {
      requestCount += 1;
      if (requestCount === 2) streamAsset(secondBytes, request, port);
    });
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    let loadCount = 0;
    xhr.onload = () => {
      loadCount += 1;
    };
    xhr.open('GET', assetUrl);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));

    const loaded = new Promise<void>((resolve, reject) => {
      xhr.onload = () => {
        loadCount += 1;
        resolve();
      };
      xhr.onerror = () => reject(new Error('replacement local request failed'));
    });
    xhr.open('GET', assetUrl);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    await loaded;

    expect(new Uint8Array(xhr.response as ArrayBuffer)).toEqual(secondBytes);
    expect(loadCount).toBe(1);
    expect(runtime.requests).toHaveLength(2);
  });

  it('isolates stale local and native XHR completions across open() transport changes', async () => {
    ControlledNativeXMLHttpRequest.instances.length = 0;
    let localRequestCount = 0;
    const localBytes = new Uint8Array([5, 4, 3]);
    const runtime = workerRuntime(
      assetUrl,
      (request, port) => {
        localRequestCount += 1;
        if (localRequestCount === 2) streamAsset(localBytes, request, port);
      },
      false,
      { XMLHttpRequest: ControlledNativeXMLHttpRequest }
    );
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    let loadCount = 0;
    xhr.onload = () => {
      loadCount += 1;
    };

    xhr.open('GET', assetUrl);
    xhr.send();
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    xhr.open('GET', 'https://game.example/api/state');
    const networkNative = ControlledNativeXMLHttpRequest.instances.at(-1)!;
    xhr.send();
    networkNative.complete('network-current');

    expect(xhr.responseText).toBe('network-current');
    expect(loadCount).toBe(1);

    xhr.open('GET', 'https://game.example/api/old');
    const staleNative = ControlledNativeXMLHttpRequest.instances.at(-1)!;
    xhr.send();
    const localLoaded = new Promise<void>((resolve, reject) => {
      xhr.onload = () => {
        loadCount += 1;
        resolve();
      };
      xhr.onerror = () => reject(new Error('local request after native XHR failed'));
    });
    xhr.open('GET', assetUrl);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    await localLoaded;
    staleNative.complete('network-stale');

    expect(new Uint8Array(xhr.response as ArrayBuffer)).toEqual(localBytes);
    expect(loadCount).toBe(2);
    expect(staleNative.aborted).toBe(true);
  });

  it('bounds concurrent worker relay streams and releases capacity on cancellation', async () => {
    const relayPorts: TestMessagePort[] = [];
    const runtime = workerRuntime(assetUrl, (request, port) => {
      relayPorts.push(port);
      port.postMessage({
        headers: [
          ['Content-Length', String(assetBytes.byteLength)],
          ['Content-Type', 'application/wasm'],
        ],
        kind: 'response',
        requestId: request.requestId,
        status: 200,
        statusText: 'OK',
      });
    });
    const fetchFromWorker = runtime.context.fetch as typeof fetch;

    const responses = await Promise.all(
      Array.from({ length: 128 }, () => fetchFromWorker(assetUrl))
    );
    await expect(fetchFromWorker(assetUrl)).rejects.toThrow(
      'Too many concurrent worker local-asset streams'
    );

    await responses[0]!.body!.cancel();
    const replacement = await fetchFromWorker(assetUrl);
    expect(relayPorts).toHaveLength(129);

    await Promise.all([
      ...responses.slice(1).map((response) => response.body!.cancel()),
      replacement.body!.cancel(),
    ]);
  });

  it('cancels a pending relay when the fetch signal aborts', async () => {
    let relayPort: TestMessagePort | undefined;
    const runtime = workerRuntime(assetUrl, (_request, port) => {
      relayPort = port;
    });
    const controller = new AbortController();
    const fetchFromWorker = runtime.context.fetch as typeof fetch;
    const pending = fetchFromWorker(assetUrl, {
      signal: controller.signal as unknown as RequestInit['signal'],
    });
    await Promise.resolve();
    const cancelled = new Promise<void>((resolve) => {
      relayPort?.addEventListener('message', (event) => {
        if (event.data.kind === 'cancel') resolve();
      });
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await cancelled;
  });
});
