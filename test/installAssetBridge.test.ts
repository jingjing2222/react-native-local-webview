import vm from 'node:vm';

import { parse, type Node } from 'parse5';
import { describe, expect, it, vi } from 'vitest';

import { integrityDigestForBytes } from '../src/subresourceIntegrity';
import { WORKER_ASSET_MESSAGE_CHANNEL } from '../src/assetBridgeProtocol';
import {
  ASSET_MESSAGE_CHANNEL,
  installAssetBridge,
  type AssetBridgeDescriptor,
} from '../src/installAssetBridge';

type HtmlNode = Node;

type PostedMessage = {
  message: Record<string, unknown>;
  transfer: unknown[];
};

type RuntimeMessagePort = EventTarget & {
  closeCount: number;
  dispatchFromWorker: (message: Record<string, unknown>, ports?: RuntimeMessagePort[]) => void;
  posted: PostedMessage[];
  startCount: number;
};

type RuntimeWorker = EventTarget & {
  dispatchFromWorker: (message: Record<string, unknown>, ports?: RuntimeMessagePort[]) => void;
  terminateCount: number;
  terminate: () => void;
};

function injectedScript(html: string): { headChildren: string[]; source: string } {
  const document = parse(html);
  let source = '';
  let headChildren: string[] = [];

  const visit = (node: HtmlNode): void => {
    if ('tagName' in node && node.tagName === 'head') {
      headChildren = node.childNodes.map((child) =>
        'tagName' in child ? child.tagName : child.nodeName
      );
    }
    if (
      'tagName' in node &&
      node.tagName === 'script' &&
      node.attrs.some((attribute) => attribute.name === 'data-react-native-local-webview-assets')
    ) {
      source = node.childNodes
        .filter((child) => child.nodeName === '#text' && 'value' in child)
        .map((child) => ('value' in child ? child.value : ''))
        .join('');
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(document);
  return { headChildren, source };
}

function runtimeFor(source: string) {
  const windowListeners: Array<(event: { data: string }) => void> = [];
  const documentListeners: Array<(event: { data: string }) => void> = [];
  const outbound: Array<Record<string, unknown>> = [];
  const networkFetch = vi.fn<() => Promise<Response>>(async () => new Response('network'));

  class RuntimeProgressEvent extends Event {
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

  class NativeXMLHttpRequest extends EventTarget {
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

  class RuntimeMessageEvent extends Event {
    readonly data: Record<string, unknown>;
    readonly ports: RuntimeMessagePort[];

    constructor(data: Record<string, unknown>, ports: RuntimeMessagePort[] = []) {
      super('message');
      this.data = data;
      this.ports = ports;
    }
  }

  class NativeMessagePort extends EventTarget implements RuntimeMessagePort {
    closeCount = 0;
    posted: PostedMessage[] = [];
    startCount = 0;

    close(): void {
      this.closeCount += 1;
    }

    dispatchFromWorker(message: Record<string, unknown>, ports: RuntimeMessagePort[] = []): void {
      this.dispatchEvent(new RuntimeMessageEvent(message, ports));
    }

    postMessage(message: Record<string, unknown>, transfer: unknown[] = []): void {
      this.posted.push({ message, transfer });
    }

    start(): void {
      this.startCount += 1;
    }
  }

  const workers: RuntimeWorker[] = [];
  class NativeWorker extends EventTarget implements RuntimeWorker {
    static readonly capability = 'native-worker-static';

    terminateCount = 0;

    constructor(
      readonly url: string,
      readonly options?: unknown
    ) {
      super();
      workers.push(this);
    }

    dispatchFromWorker(message: Record<string, unknown>, ports: RuntimeMessagePort[] = []): void {
      this.dispatchEvent(new RuntimeMessageEvent(message, ports));
    }

    postMessage(): void {}

    terminate(): void {
      this.terminateCount += 1;
    }
  }

  const sharedWorkers: Array<{ port: RuntimeMessagePort }> = [];
  class NativeSharedWorker {
    static readonly capability = 'native-shared-worker-static';

    readonly port: RuntimeMessagePort = new NativeMessagePort();

    constructor(
      readonly url: string,
      readonly options?: unknown
    ) {
      sharedWorkers.push(this);
    }
  }

  const context: Record<string, unknown> = {
    Blob,
    DOMException,
    Event,
    EventTarget,
    ProgressEvent: RuntimeProgressEvent,
    ReadableStream,
    Response,
    TextDecoder,
    URL,
    Uint8Array,
    Worker: NativeWorker,
    SharedWorker: NativeSharedWorker,
    XMLHttpRequest: NativeXMLHttpRequest,
    addEventListener: (_name: string, listener: (event: { data: string }) => void) => {
      windowListeners.push(listener);
    },
    atob,
    clearTimeout,
    document: {
      addEventListener: (_name: string, listener: (event: { data: string }) => void) => {
        documentListeners.push(listener);
      },
    },
    fetch: networkFetch,
    location: { href: 'https://game.example/play/' },
    setTimeout,
  };
  context.window = context;
  context.ReactNativeWebView = {
    postMessage: (value: string) => {
      outbound.push(JSON.parse(value) as Record<string, unknown>);
    },
  };
  vm.runInNewContext(source, context);

  return {
    context,
    createMessagePort: (): RuntimeMessagePort => new NativeMessagePort(),
    dispatchNative: (message: Record<string, unknown>) => {
      const event = { data: JSON.stringify(message) };
      const listener = windowListeners[0] ?? documentListeners[0];
      listener?.(event);
    },
    nativeSharedWorker: NativeSharedWorker,
    nativeWorker: NativeWorker,
    networkFetch,
    outbound,
    sharedWorkers,
    workers,
  };
}

function nativeMessage(requestId: string, message: Record<string, unknown>) {
  return {
    channel: ASSET_MESSAGE_CHANNEL,
    direction: 'native',
    requestId,
    ...message,
  };
}

describe('local asset runtime bridge', () => {
  const assetUrl = 'https://game.example/play/Build/game.wasm';
  const assetBytes = new Uint8Array([0, 97, 115, 109]);
  const assetSha256 = integrityDigestForBytes(assetBytes, 'sha256');
  const assetSha384 = integrityDigestForBytes(assetBytes, 'sha384');
  const assetSha512 = integrityDigestForBytes(assetBytes, 'sha512');
  const assets: Record<string, AssetBridgeDescriptor> = {
    [assetUrl]: {
      integrity: {
        sha256: assetSha256,
        sha384: assetSha384,
        sha512: assetSha512,
      },
      mediaType: 'application/wasm',
      size: 4,
      url: assetUrl,
    },
  };

  it('runs before page scripts and does not expose native file paths', () => {
    const assetsWithPrivateMetadata = {
      [assetUrl]: {
        ...assets[assetUrl]!,
        path: '/documents/local-webview/private/game.wasm',
        sha256: 'private-sha256',
      },
    };
    const html = installAssetBridge(
      '<!doctype html><html><head><script src="entry.js"></script></head><body></body></html>',
      assetsWithPrivateMetadata
    );
    const injected = injectedScript(html);
    const runtime = runtimeFor(injected.source);
    const exposed = runtime.context.__REACT_NATIVE_LOCAL_WEBVIEW_ASSETS__ as {
      inventory: Record<string, Record<string, unknown>>;
    };

    expect(injected.headChildren.slice(0, 2)).toEqual(['script', 'script']);
    expect(injected.source).toContain(assetUrl);
    expect(injected.source).not.toContain('/documents/');
    expect(injected.source).not.toContain('/temporary/');
    expect(injected.source).not.toContain('private-sha256');
    expect(exposed.inventory[assetUrl]).toEqual({
      integrity: {
        sha256: assetSha256,
        sha384: assetSha384,
        sha512: assetSha512,
      },
      mediaType: 'application/wasm',
      size: 4,
      url: assetUrl,
    });
  });

  it('checks for an installed marker script instead of matching marker text', () => {
    const marker = 'data-react-native-local-webview-assets';
    const original = `<!doctype html><html><head><script>globalThis.marker = ${JSON.stringify(
      marker
    )};</script></head><body></body></html>`;

    const installed = installAssetBridge(original, assets);
    const injected = injectedScript(installed);

    expect(installed).not.toBe(original);
    expect(injected.source).toContain('const inventory =');
    expect(installAssetBridge(installed, assets)).toBe(installed);
  });

  it('serves fetch as a backpressured Response stream and falls through for unknown URLs', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const localFetch = runtime.context.fetch as typeof fetch;

    const response = await localFetch(`${assetUrl}#ignored`);
    const request = runtime.outbound.find((message) => message.kind === 'request');
    expect(request).toMatchObject({ url: assetUrl });
    const requestId = String(request?.requestId);
    const body = response.arrayBuffer();
    runtime.dispatchNative(nativeMessage(requestId, { data: 'AGFzbQ==', kind: 'chunk' }));
    expect(runtime.outbound).toContainEqual(expect.objectContaining({ kind: 'ack', requestId }));
    runtime.dispatchNative(nativeMessage(requestId, { kind: 'end' }));

    expect(new Uint8Array(await body)).toEqual(new Uint8Array([0, 97, 115, 109]));
    expect(response.headers.get('content-type')).toBe('application/wasm');
    expect(response.redirected).toBe(false);
    expect(response.url).toBe(assetUrl);

    expect(await (await localFetch('https://game.example/api/state')).text()).toBe('network');
    expect(runtime.networkFetch).toHaveBeenCalledOnce();
  });

  it('preserves the canonical URL when a local fetch response is cloned', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const localFetch = runtime.context.fetch as typeof fetch;

    const response = await localFetch(`${assetUrl}#ignored`);
    const clone = response.clone();

    expect(response.url).toBe(assetUrl);
    expect(response.redirected).toBe(false);
    expect(clone.url).toBe(assetUrl);
    expect(clone.redirected).toBe(false);
  });

  it('exposes a mirrored redirect through fetch and XMLHttpRequest metadata', async () => {
    const responseUrl = 'https://game.example/releases/v2/game.wasm';
    const redirectedAssets: Record<string, AssetBridgeDescriptor> = {
      [assetUrl]: {
        ...assets[assetUrl]!,
        redirected: true,
        responseUrl,
      },
    };
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', redirectedAssets)
    );
    const runtime = runtimeFor(source);
    const localFetch = runtime.context.fetch as typeof fetch;

    const response = await localFetch(assetUrl);
    expect(response.url).toBe(responseUrl);
    expect(response.redirected).toBe(true);
    expect(response.clone().url).toBe(responseUrl);
    expect(response.clone().redirected).toBe(true);

    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    xhr.open('GET', assetUrl);
    xhr.responseType = 'arraybuffer';
    const loaded = new Promise<void>((resolve, reject) => {
      xhr.onload = () => resolve();
      xhr.onerror = () => reject(new Error('redirected XHR bridge failed'));
    });
    xhr.send();

    for (const request of runtime.outbound.filter((message) => message.kind === 'request')) {
      const requestId = String(request.requestId);
      runtime.dispatchNative(nativeMessage(requestId, { data: 'AGFzbQ==', kind: 'chunk' }));
      runtime.dispatchNative(nativeMessage(requestId, { kind: 'end' }));
    }
    await loaded;

    expect(xhr.responseURL).toBe(responseUrl);
  });

  it('queues high fan-out fetches in the WebView and admits only four native streams', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const localFetch = runtime.context.fetch as typeof fetch;
    const responses = await Promise.all(Array.from({ length: 40 }, () => localFetch(assetUrl)));

    expect(runtime.outbound.filter((message) => message.kind === 'request')).toHaveLength(4);

    for (let completed = 0; completed < responses.length; completed += 1) {
      const requests = runtime.outbound.filter((message) => message.kind === 'request');
      const request = requests[completed];
      expect(request).toBeDefined();
      runtime.dispatchNative(
        nativeMessage(String(request!.requestId), { data: 'AGFzbQ==', kind: 'chunk' })
      );
      runtime.dispatchNative(nativeMessage(String(request!.requestId), { kind: 'end' }));
      expect(runtime.outbound.filter((message) => message.kind === 'error')).toEqual([]);
      expect(runtime.outbound.filter((message) => message.kind === 'request')).toHaveLength(
        Math.min(40, completed + 5)
      );
    }

    await expect(
      Promise.all(responses.map((response) => response.arrayBuffer()))
    ).resolves.toHaveLength(40);
  });

  it.each([
    ['overflow', 'AGFzbQE=', true],
    ['truncation', 'AGE=', false],
  ])('rejects a fetch stream with verified-size %s', async (_name, data, expectCancel) => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const localFetch = runtime.context.fetch as typeof fetch;
    const response = await localFetch(assetUrl);
    const request = runtime.outbound.find((message) => message.kind === 'request');
    const requestId = String(request?.requestId);
    const reading = response.arrayBuffer();

    runtime.dispatchNative(nativeMessage(requestId, { data, kind: 'chunk' }));
    if (_name === 'truncation') {
      runtime.dispatchNative(nativeMessage(requestId, { kind: 'end' }));
    }

    await expect(reading).rejects.toThrow(/verified size|verified bytes/);
    expect(
      runtime.outbound.some(
        (message) => message.kind === 'cancel' && message.requestId === requestId
      )
    ).toBe(expectCancel);
  });

  it('bounds pending WebView asset requests and releases cancelled queue entries', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const exposed = runtime.context.__REACT_NATIVE_LOCAL_WEBVIEW_ASSETS__ as {
      resolve: (url: string) => Response;
    };
    const responses = Array.from({ length: 512 }, () => exposed.resolve(assetUrl));

    expect(() => exposed.resolve(assetUrl)).toThrow('maximum 512');
    await Promise.all(responses.map((response) => Promise.resolve(response.body?.cancel())));

    const replacement = exposed.resolve(assetUrl);
    await replacement.body?.cancel();
  });

  it('resolves relative fetch and XHR URLs against document.baseURI', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const fetchRuntime = runtimeFor(source);
    (fetchRuntime.context.document as { baseURI: string }).baseURI = 'https://game.example/play/';
    (fetchRuntime.context.location as { href: string }).href =
      'https://game.example/native-shell/index.html';
    const localFetch = fetchRuntime.context.fetch as typeof fetch;

    const response = await localFetch('./Build/game.wasm');

    expect(fetchRuntime.outbound).toContainEqual(
      expect.objectContaining({ kind: 'request', url: assetUrl })
    );
    await response.body?.cancel();

    const xhrRuntime = runtimeFor(source);
    (xhrRuntime.context.document as { baseURI: string }).baseURI = 'https://game.example/play/';
    (xhrRuntime.context.location as { href: string }).href =
      'https://game.example/native-shell/index.html';
    const Xhr = xhrRuntime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    xhr.open('GET', './Build/game.wasm');
    xhr.send();

    expect(xhrRuntime.outbound).toContainEqual(
      expect.objectContaining({ kind: 'request', url: assetUrl })
    );
    xhr.abort();
  });

  it.each(['init.signal', 'Request.signal'] as const)(
    'propagates pre-abort and in-flight abort from %s',
    async (signalSource) => {
      const { source } = injectedScript(
        installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
      );
      const preAbortRuntime = runtimeFor(source);
      const preAbortFetch = preAbortRuntime.context.fetch as typeof fetch;
      const preAbortController = new AbortController();
      preAbortController.abort();
      const preAbortRequest =
        signalSource === 'Request.signal'
          ? new Request(assetUrl, { signal: preAbortController.signal })
          : assetUrl;
      const preAbortInit =
        signalSource === 'init.signal'
          ? ({ signal: preAbortController.signal } as unknown as RequestInit)
          : undefined;

      await expect(
        preAbortFetch(preAbortRequest as Parameters<typeof preAbortFetch>[0], preAbortInit)
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(preAbortRuntime.outbound).toEqual([]);
      expect(preAbortRuntime.networkFetch).not.toHaveBeenCalled();

      const runtime = runtimeFor(source);
      const localFetch = runtime.context.fetch as typeof fetch;
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const request =
        signalSource === 'Request.signal'
          ? new Request(assetUrl, { signal: controller.signal })
          : assetUrl;
      const init =
        signalSource === 'init.signal'
          ? ({ signal: controller.signal } as unknown as RequestInit)
          : undefined;
      const response = await localFetch(request as Parameters<typeof localFetch>[0], init);
      const nativeRequest = runtime.outbound.find((message) => message.kind === 'request');
      const requestId = String(nativeRequest?.requestId);
      const reader = response.body!.getReader();
      const reading = reader.read();

      controller.abort();

      await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
      expect(runtime.outbound).toContainEqual(
        expect.objectContaining({ kind: 'cancel', requestId })
      );
      expect(
        runtime.outbound.filter(
          (message) => message.kind === 'cancel' && message.requestId === requestId
        )
      ).toHaveLength(1);
      expect(removeListener).toHaveBeenCalledOnce();

      runtime.dispatchNative(nativeMessage(requestId, { data: 'AGFzbQ==', kind: 'chunk' }));
      runtime.dispatchNative(nativeMessage(requestId, { kind: 'end' }));
      expect(
        runtime.outbound.filter(
          (message) => message.kind === 'ack' && message.requestId === requestId
        )
      ).toHaveLength(0);
    }
  );

  it('enforces fetch integrity metadata before opening a local stream', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const validRuntime = runtimeFor(source);
    const validFetch = validRuntime.context.fetch as typeof fetch;
    const response = await validFetch(assetUrl, {
      integrity: `sha256-invalid sha256-${assetSha256}`,
    });
    expect(validRuntime.outbound).toContainEqual(
      expect.objectContaining({ kind: 'request', url: assetUrl })
    );
    await response.body?.cancel();

    const invalidRuntime = runtimeFor(source);
    const invalidFetch = invalidRuntime.context.fetch as typeof fetch;
    await expect(
      invalidFetch(assetUrl, { integrity: `sha256-${btoa('wrong digest')}` })
    ).rejects.toThrow('Subresource Integrity verification failed');
    expect(invalidRuntime.outbound).toEqual([]);
    expect(invalidRuntime.networkFetch).not.toHaveBeenCalled();

    const strongRuntime = runtimeFor(source);
    const strongFetch = strongRuntime.context.fetch as typeof fetch;
    const strongResponse = await strongFetch(assetUrl, {
      integrity: `sha256-${btoa('wrong weaker digest')} sha512-${assetSha512}`,
    });
    await strongResponse.body?.cancel();

    await expect(
      invalidFetch(assetUrl, {
        integrity: `sha256-${assetSha256} sha384-${btoa('wrong stronger digest')}`,
      })
    ).rejects.toThrow('Subresource Integrity verification failed');
    expect(invalidRuntime.outbound).toEqual([]);
  });

  it('honors integrity inherited from a Request object', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const localFetch = runtime.context.fetch as typeof fetch;
    const request = new Request(assetUrl, {
      integrity: `sha256-${assetSha256}`,
    });

    const response = await localFetch(request as unknown as Parameters<typeof localFetch>[0]);

    expect(runtime.outbound).toContainEqual(
      expect.objectContaining({ kind: 'request', url: assetUrl })
    );
    await response.body?.cancel();
  });

  it('honors integrity inherited by the fetch init dictionary', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const localFetch = runtime.context.fetch as typeof fetch;
    const init = Object.create({
      integrity: `sha256-${btoa('wrong digest')}`,
    }) as RequestInit;

    await expect(localFetch(assetUrl, init)).rejects.toThrow(
      'Subresource Integrity verification failed'
    );
    expect(runtime.outbound).toEqual([]);
    expect(runtime.networkFetch).not.toHaveBeenCalled();
  });

  it('serves the same verified asset through asynchronous XMLHttpRequest', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    xhr.open('GET', './Build/game.wasm');
    xhr.setRequestHeader('X-Test', 'secret');
    xhr.responseType = 'arraybuffer';
    const loaded = new Promise<void>((resolve, reject) => {
      xhr.onload = () => resolve();
      xhr.onerror = () => reject(new Error('XHR bridge failed'));
    });
    expect(xhr.send()).toBeUndefined();
    expect(() => xhr.send()).toThrow('invalid state');
    expect(() => xhr.setRequestHeader('X-Late', 'value')).toThrow('invalid state');

    const request = runtime.outbound.find((message) => message.kind === 'request');
    const requestId = String(request?.requestId);
    runtime.dispatchNative(nativeMessage(requestId, { data: 'AGFzbQ==', kind: 'chunk' }));
    runtime.dispatchNative(nativeMessage(requestId, { kind: 'end' }));
    await loaded;

    expect(xhr.status).toBe(200);
    expect(xhr.readyState).toBe(Xhr.DONE);
    expect(new Uint8Array(xhr.response as ArrayBuffer)).toEqual(new Uint8Array([0, 97, 115, 109]));
    expect(xhr.getResponseHeader('content-type')).toBe('application/wasm');
    expect(xhr.getResponseHeader('x-test')).toBeNull();
    expect(xhr.getAllResponseHeaders()).not.toContain('secret');
    expect(xhr.responseURL).toBe(assetUrl);
  });

  it('completes invalid local JSON with a null response instead of a network error', async () => {
    const jsonUrl = 'https://game.example/play/config.json';
    const jsonBytes = new TextEncoder().encode('not json');
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', {
        [jsonUrl]: {
          integrity: {
            sha256: integrityDigestForBytes(jsonBytes, 'sha256'),
            sha384: integrityDigestForBytes(jsonBytes, 'sha384'),
            sha512: integrityDigestForBytes(jsonBytes, 'sha512'),
          },
          mediaType: 'application/json',
          size: jsonBytes.byteLength,
          url: jsonUrl,
        },
      })
    );
    const runtime = runtimeFor(source);
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    xhr.open('GET', jsonUrl);
    xhr.responseType = 'json';
    let errors = 0;
    const loaded = new Promise<void>((resolve) => {
      xhr.onload = () => resolve();
      xhr.onerror = () => {
        errors += 1;
      };
    });

    expect(xhr.send()).toBeUndefined();
    const request = runtime.outbound.find((message) => message.kind === 'request')!;
    runtime.dispatchNative(
      nativeMessage(String(request.requestId), { data: 'bm90IGpzb24=', kind: 'chunk' })
    );
    runtime.dispatchNative(nativeMessage(String(request.requestId), { kind: 'end' }));
    await loaded;

    expect(errors).toBe(0);
    expect(xhr.status).toBe(200);
    expect(xhr.response).toBeNull();
  });

  it('resets XMLHttpRequest response state when a completed instance is reused', async () => {
    const secondUrl = 'https://game.example/play/Build/second.bin';
    const secondBytes = new Uint8Array([1, 2]);
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', {
        ...assets,
        [secondUrl]: {
          integrity: {
            sha256: integrityDigestForBytes(secondBytes, 'sha256'),
            sha384: integrityDigestForBytes(secondBytes, 'sha384'),
            sha512: integrityDigestForBytes(secondBytes, 'sha512'),
          },
          mediaType: 'application/octet-stream',
          size: secondBytes.byteLength,
          url: secondUrl,
        },
      })
    );
    const runtime = runtimeFor(source);
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    xhr.open('GET', assetUrl);
    xhr.responseType = 'arraybuffer';
    let loaded = new Promise<void>((resolve) => {
      xhr.onload = () => resolve();
    });
    xhr.send();
    const firstRequest = runtime.outbound.find((message) => message.kind === 'request')!;
    runtime.dispatchNative(
      nativeMessage(String(firstRequest.requestId), { data: 'AGFzbQ==', kind: 'chunk' })
    );
    runtime.dispatchNative(nativeMessage(String(firstRequest.requestId), { kind: 'end' }));
    await loaded;

    xhr.open('GET', secondUrl);
    expect(xhr.readyState).toBe(Xhr.OPENED);
    expect(xhr.status).toBe(0);
    expect(xhr.statusText).toBe('');
    expect(xhr.response).toBeNull();
    expect(() => xhr.responseText).toThrow('responseText is unavailable');
    expect(xhr.responseURL).toBe('');
    expect(xhr.getAllResponseHeaders()).toBe('');

    loaded = new Promise<void>((resolve) => {
      xhr.onload = () => resolve();
    });
    xhr.send();
    const secondRequest = runtime.outbound.filter((message) => message.kind === 'request')[1]!;
    runtime.dispatchNative(
      nativeMessage(String(secondRequest.requestId), { data: 'AQI=', kind: 'chunk' })
    );
    runtime.dispatchNative(nativeMessage(String(secondRequest.requestId), { kind: 'end' }));
    await loaded;

    expect(new Uint8Array(xhr.response as ArrayBuffer)).toEqual(secondBytes);
    expect(xhr.responseURL).toBe(secondUrl);
  });

  it('cancels an in-flight local XMLHttpRequest before reusing the instance', async () => {
    const secondUrl = 'https://game.example/play/Build/second.bin';
    const secondBytes = new Uint8Array([1, 2]);
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', {
        ...assets,
        [secondUrl]: {
          integrity: {
            sha256: integrityDigestForBytes(secondBytes, 'sha256'),
            sha384: integrityDigestForBytes(secondBytes, 'sha384'),
            sha512: integrityDigestForBytes(secondBytes, 'sha512'),
          },
          mediaType: 'application/octet-stream',
          size: secondBytes.byteLength,
          url: secondUrl,
        },
      })
    );
    const runtime = runtimeFor(source);
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    let loadCount = 0;
    xhr.onload = () => {
      loadCount += 1;
    };

    xhr.open('GET', assetUrl);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    const firstRequest = runtime.outbound.find((message) => message.kind === 'request')!;
    xhr.open('GET', secondUrl);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    const secondRequest = runtime.outbound.filter((message) => message.kind === 'request')[1]!;

    runtime.dispatchNative(
      nativeMessage(String(firstRequest.requestId), { data: 'AGFzbQ==', kind: 'chunk' })
    );
    runtime.dispatchNative(nativeMessage(String(firstRequest.requestId), { kind: 'end' }));
    runtime.dispatchNative(
      nativeMessage(String(secondRequest.requestId), { data: 'AQI=', kind: 'chunk' })
    );
    runtime.dispatchNative(nativeMessage(String(secondRequest.requestId), { kind: 'end' }));
    await vi.waitFor(() => expect(loadCount).toBe(1));

    expect(runtime.outbound).toContainEqual(
      expect.objectContaining({
        kind: 'cancel',
        requestId: firstRequest.requestId,
      })
    );
    expect(new Uint8Array(xhr.response as ArrayBuffer)).toEqual(secondBytes);
    expect(xhr.responseURL).toBe(secondUrl);
  });

  it.each([
    ['overflow', 'AGFzbQE=', false],
    ['size mismatch', 'AGE=', true],
  ])('rejects a local XHR %s against the verified size', async (_name, data, end) => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    xhr.open('GET', assetUrl);
    xhr.responseType = 'arraybuffer';
    const failed = new Promise<void>((resolve) => {
      xhr.onerror = () => resolve();
    });
    xhr.send();

    const request = runtime.outbound.find((message) => message.kind === 'request');
    const requestId = String(request?.requestId);
    runtime.dispatchNative(nativeMessage(requestId, { data, kind: 'chunk' }));
    if (end) runtime.dispatchNative(nativeMessage(requestId, { kind: 'end' }));
    await failed;

    expect(xhr.status).toBe(0);
    expect(xhr.readyState).toBe(Xhr.DONE);
    expect(xhr.response).toBeNull();
    expect(xhr.statusText).toBe('');
    expect(xhr.responseURL).toBe('');
    expect(xhr.getAllResponseHeaders()).toBe('');
  });

  it('uses native XMLHttpRequest ready-state and abort semantics for local responses', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const Xhr = runtime.context.XMLHttpRequest as typeof XMLHttpRequest;
    const xhr = new Xhr();
    const states: number[] = [];
    xhr.onreadystatechange = () => states.push(xhr.readyState);
    xhr.open('GET', assetUrl);
    xhr.responseType = 'arraybuffer';
    const loaded = new Promise<void>((resolve) => {
      xhr.onload = () => resolve();
    });

    xhr.send();
    expect(xhr.readyState).toBe(Xhr.OPENED);
    const request = runtime.outbound.find((message) => message.kind === 'request')!;
    runtime.dispatchNative(
      nativeMessage(String(request.requestId), { data: 'AGFzbQ==', kind: 'chunk' })
    );
    runtime.dispatchNative(nativeMessage(String(request.requestId), { kind: 'end' }));
    await loaded;
    expect(states).toEqual([Xhr.OPENED, Xhr.HEADERS_RECEIVED, Xhr.LOADING, Xhr.DONE]);

    const completedEvents: string[] = [];
    for (const name of ['readystatechange', 'abort', 'loadend'] as const) {
      xhr.addEventListener(name, () => completedEvents.push(name));
    }
    xhr.abort();
    expect(completedEvents).toEqual([]);
    expect(xhr.readyState).toBe(Xhr.UNSENT);
    expect(xhr.status).toBe(0);
    expect(xhr.response).toBeNull();
    expect(xhr.responseURL).toBe('');

    xhr.open('GET', assetUrl);
    const openedState = xhr.readyState;
    completedEvents.length = 0;
    xhr.abort();
    expect(openedState).toBe(Xhr.OPENED);
    expect(xhr.readyState).toBe(Xhr.OPENED);
    expect(completedEvents).toEqual([]);
  });

  it('ends an active local XMLHttpRequest abort at UNSENT after abort events', () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
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
    expect(xhr.responseURL).toBe('');
    expect(xhr.getAllResponseHeaders()).toBe('');
  });

  it('does not acknowledge the next native chunk until the Web stream consumes capacity', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const localFetch = runtime.context.fetch as typeof fetch;
    const response = await localFetch(assetUrl);
    const request = runtime.outbound.find((message) => message.kind === 'request');
    const requestId = String(request?.requestId);

    runtime.dispatchNative(nativeMessage(requestId, { data: 'AGFzbQ==', kind: 'chunk' }));
    expect(
      runtime.outbound.filter(
        (message) => message.kind === 'ack' && message.requestId === requestId
      )
    ).toHaveLength(0);

    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([0, 97, 115, 109]));
    await Promise.resolve();
    expect(runtime.outbound).toContainEqual(expect.objectContaining({ kind: 'ack', requestId }));
    runtime.dispatchNative(nativeMessage(requestId, { kind: 'end' }));
    await reader.read();
  });

  it('streams a local asset to a dedicated Worker with acknowledgement backpressure', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const WorkerConstructor = runtime.context.Worker as new (
      url: string,
      options?: unknown
    ) => RuntimeWorker;
    const WorkerWithStatic = runtime.context.Worker as typeof WorkerConstructor & {
      capability: string;
    };
    const relayPort = runtime.createMessagePort();
    const worker = new WorkerConstructor('blob:worker');
    let leakedMessages = 0;
    worker.addEventListener('message', () => {
      leakedMessages += 1;
    });

    expect(WorkerWithStatic.capability).toBe('native-worker-static');
    expect(worker).toBeInstanceOf(runtime.nativeWorker);
    expect(Object.getPrototypeOf(worker)).toBe(runtime.nativeWorker.prototype);

    worker.dispatchFromWorker(
      {
        channel: WORKER_ASSET_MESSAGE_CHANNEL,
        integrity: `sha512-${assetSha512}`,
        kind: 'request',
        requestId: 'worker:0',
        url: assetUrl,
      },
      [relayPort]
    );

    expect(leakedMessages).toBe(0);
    expect(relayPort.startCount).toBe(1);
    expect(relayPort.posted[0]?.message).toMatchObject({
      headers: [
        ['content-length', '4'],
        ['content-type', 'application/wasm'],
      ],
      kind: 'response',
      requestId: 'worker:0',
      status: 200,
      url: assetUrl,
    });

    const nativeRequest = runtime.outbound.find((message) => message.kind === 'request');
    const nativeRequestId = String(nativeRequest?.requestId);
    runtime.dispatchNative(nativeMessage(nativeRequestId, { data: 'AGE=', kind: 'chunk' }));
    await vi.waitFor(() => {
      expect(
        runtime.outbound.some(
          (message) => message.kind === 'ack' && message.requestId === nativeRequestId
        )
      ).toBe(true);
    });
    runtime.dispatchNative(nativeMessage(nativeRequestId, { data: 'c20=', kind: 'chunk' }));
    runtime.dispatchNative(nativeMessage(nativeRequestId, { kind: 'end' }));

    await vi.waitFor(() => {
      expect(relayPort.posted.some(({ message }) => message.kind === 'chunk')).toBe(true);
    });
    const firstChunk = relayPort.posted.find(({ message }) => message.kind === 'chunk');
    expect(new Uint8Array(firstChunk?.message.data as ArrayBuffer)).toEqual(
      new Uint8Array([0, 97])
    );
    expect(firstChunk?.transfer).toEqual([firstChunk?.message.data]);
    expect(relayPort.posted.filter(({ message }) => message.kind === 'chunk')).toHaveLength(1);
    expect(relayPort.posted.some(({ message }) => message.kind === 'end')).toBe(false);

    relayPort.dispatchFromWorker({
      kind: 'ack',
      sequence: firstChunk?.message.sequence,
    });
    await vi.waitFor(() => {
      expect(relayPort.posted.filter(({ message }) => message.kind === 'chunk')).toHaveLength(2);
    });
    const secondChunk = relayPort.posted.filter(({ message }) => message.kind === 'chunk')[1];
    expect(new Uint8Array(secondChunk?.message.data as ArrayBuffer)).toEqual(
      new Uint8Array([115, 109])
    );
    expect(relayPort.posted.some(({ message }) => message.kind === 'end')).toBe(false);
    relayPort.dispatchFromWorker({
      kind: 'ack',
      sequence: secondChunk?.message.sequence,
    });
    await vi.waitFor(() => {
      expect(relayPort.posted.some(({ message }) => message.kind === 'end')).toBe(true);
    });
    expect(relayPort.closeCount).toBe(1);
  });

  it('relays SharedWorker requests over its private port', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const SharedWorkerConstructor = runtime.context.SharedWorker as new (url: string) => {
      port: RuntimeMessagePort;
    };
    const SharedWorkerWithStatic = runtime.context
      .SharedWorker as typeof SharedWorkerConstructor & {
      capability: string;
    };
    const sharedWorker = new SharedWorkerConstructor('blob:shared-worker');
    const relayPort = runtime.sharedWorkers[0]!.port;
    const responsePort = runtime.createMessagePort();
    let leakedMessages = 0;
    sharedWorker.port.addEventListener('message', () => {
      leakedMessages += 1;
    });

    expect(SharedWorkerWithStatic.capability).toBe('native-shared-worker-static');
    expect(sharedWorker).toBeInstanceOf(runtime.nativeSharedWorker);
    expect(Object.getPrototypeOf(sharedWorker)).toBe(runtime.nativeSharedWorker.prototype);

    const probePort = runtime.createMessagePort();
    relayPort.dispatchFromWorker(
      {
        channel: WORKER_ASSET_MESSAGE_CHANNEL,
        kind: 'probe',
        probeId: 'shared:probe',
      },
      [probePort]
    );
    expect(probePort.posted).toContainEqual(
      expect.objectContaining({
        message: { kind: 'probe-ack', probeId: 'shared:probe' },
      })
    );
    expect(probePort.closeCount).toBe(1);
    expect(runtime.outbound).toEqual([]);

    relayPort.dispatchFromWorker(
      {
        channel: WORKER_ASSET_MESSAGE_CHANNEL,
        kind: 'request',
        requestId: 'shared:0',
        url: assetUrl,
      },
      [responsePort]
    );

    expect(leakedMessages).toBe(0);
    expect(responsePort.posted[0]?.message).toMatchObject({
      kind: 'response',
      status: 200,
    });
    const nativeRequest = runtime.outbound.find((message) => message.kind === 'request');
    const nativeRequestId = String(nativeRequest?.requestId);
    runtime.dispatchNative(nativeMessage(nativeRequestId, { data: 'AGFzbQ==', kind: 'chunk' }));
    runtime.dispatchNative(nativeMessage(nativeRequestId, { kind: 'end' }));
    await vi.waitFor(() => {
      expect(responsePort.posted.some(({ message }) => message.kind === 'chunk')).toBe(true);
    });
    responsePort.dispatchFromWorker({ kind: 'ack' });
    await vi.waitFor(() => {
      expect(responsePort.posted.some(({ message }) => message.kind === 'end')).toBe(true);
    });
  });

  it('bounds concurrent page-side Worker relays and releases them on termination', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const WorkerConstructor = runtime.context.Worker as new (url: string) => RuntimeWorker;
    const worker = new WorkerConstructor('blob:worker');
    const relayPorts = Array.from({ length: 128 }, () => runtime.createMessagePort());
    for (const [index, port] of relayPorts.entries()) {
      worker.dispatchFromWorker(
        {
          channel: WORKER_ASSET_MESSAGE_CHANNEL,
          kind: 'request',
          requestId: `worker:${index}`,
          url: assetUrl,
        },
        [port]
      );
    }
    await vi.waitFor(() => {
      expect(relayPorts.every((port) => port.posted[0]?.message.kind === 'response')).toBe(true);
    });

    const overflowPort = runtime.createMessagePort();
    worker.dispatchFromWorker(
      {
        channel: WORKER_ASSET_MESSAGE_CHANNEL,
        kind: 'request',
        requestId: 'worker:overflow',
        url: assetUrl,
      },
      [overflowPort]
    );

    expect(overflowPort.posted[0]?.message).toMatchObject({
      kind: 'error',
      requestId: 'worker:overflow',
    });
    expect(overflowPort.closeCount).toBe(1);

    worker.terminate();
    await vi.waitFor(() => {
      expect(relayPorts.every((port) => port.closeCount === 1)).toBe(true);
    });
  });

  it('cancels the native stream when a Worker cancels or terminates a relay', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const WorkerConstructor = runtime.context.Worker as new (url: string) => RuntimeWorker;
    const worker = new WorkerConstructor('blob:worker');
    const cancelledPort = runtime.createMessagePort();
    worker.dispatchFromWorker(
      {
        channel: WORKER_ASSET_MESSAGE_CHANNEL,
        kind: 'request',
        requestId: 'worker:cancel',
        url: assetUrl,
      },
      [cancelledPort]
    );
    const firstNativeRequest = runtime.outbound.find((message) => message.kind === 'request');
    cancelledPort.dispatchFromWorker({ kind: 'cancel' });
    await vi.waitFor(() => {
      expect(runtime.outbound).toContainEqual(
        expect.objectContaining({
          kind: 'cancel',
          requestId: firstNativeRequest?.requestId,
        })
      );
    });

    const terminatedPort = runtime.createMessagePort();
    worker.dispatchFromWorker(
      {
        channel: WORKER_ASSET_MESSAGE_CHANNEL,
        kind: 'request',
        requestId: 'worker:terminate',
        url: assetUrl,
      },
      [terminatedPort]
    );
    const nativeRequests = runtime.outbound.filter((message) => message.kind === 'request');
    worker.terminate();
    await vi.waitFor(() => {
      expect(runtime.outbound).toContainEqual(
        expect.objectContaining({
          kind: 'cancel',
          requestId: nativeRequests[1]?.requestId,
        })
      );
    });
    expect(worker.terminateCount).toBe(1);
    expect(terminatedPort.closeCount).toBe(1);
  });

  it('returns a miss for non-inventory URLs and preserves ordinary Worker messages', async () => {
    const { source } = injectedScript(
      installAssetBridge('<!doctype html><html><head></head><body></body></html>', assets)
    );
    const runtime = runtimeFor(source);
    const WorkerConstructor = runtime.context.Worker as new (url: string) => RuntimeWorker;
    const worker = new WorkerConstructor('blob:worker');
    const responsePort = runtime.createMessagePort();
    const observed: Array<Record<string, unknown>> = [];
    worker.addEventListener('message', (event) => {
      observed.push((event as Event & { data: Record<string, unknown> }).data);
    });

    worker.dispatchFromWorker(
      {
        channel: WORKER_ASSET_MESSAGE_CHANNEL,
        kind: 'request',
        requestId: 'worker:miss',
        url: 'https://game.example/api/state',
      },
      [responsePort]
    );
    await vi.waitFor(() => {
      expect(responsePort.posted).toContainEqual(
        expect.objectContaining({
          message: { kind: 'miss', requestId: 'worker:miss' },
        })
      );
    });
    expect(runtime.outbound).toEqual([]);
    expect(observed).toEqual([]);

    worker.dispatchFromWorker({ kind: 'application-message', value: 42 });
    expect(observed).toEqual([{ kind: 'application-message', value: 42 }]);
  });
});
