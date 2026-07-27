import { WORKER_ASSET_MESSAGE_CHANNEL } from './assetBridgeProtocol';

export function createWorkerRuntimeBootstrap(
  baseUrl: string,
  localAssetUrls: readonly string[]
): string {
  const inventory = JSON.stringify([...new Set(localAssetUrls)]).replaceAll('<', '\\u003c');
  return String.raw`
(() => {
  const marker = '__REACT_NATIVE_LOCAL_WEBVIEW_WORKER_BASE__';
  if (globalThis[marker]) return;

  const baseUrl = ${JSON.stringify(baseUrl)};
  const relayChannel = ${JSON.stringify(WORKER_ASSET_MESSAGE_CHANNEL)};
  const localAssets = new Set(${inventory});
  const relayTimeoutMs = 30000;
  const sharedParentProbeTimeoutMs = 250;
  const maxSharedParentPorts = 32;
  const maxActiveRelays = 128;
  let activeRelays = 0;
  let sharedProbeSequence = 0;
  let requestSequence = 0;
  globalThis[marker] = baseUrl;

  const resolve = (value) => {
    try {
      return new globalThis.URL(value, baseUrl).href;
    } catch {
      return value;
    }
  };
  const canonical = (value) => {
    try {
      const url = new globalThis.URL(value, baseUrl);
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  };
  const abortError = () =>
    typeof globalThis.DOMException === 'function'
      ? new globalThis.DOMException('The operation was aborted', 'AbortError')
      : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const exposeResponseMetadata = (response, url, redirected) => {
    const nativeClone = response.clone.bind(response);
    Object.defineProperties(response, {
      clone: {
        configurable: true,
        value: () => exposeResponseMetadata(nativeClone(), url, redirected)
      },
      redirected: {
        configurable: true,
        enumerable: true,
        value: redirected
      },
      url: {
        configurable: true,
        enumerable: true,
        value: url
      }
    });
    return response;
  };
  const headerValue = (headers, expectedName) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(expectedName);
    const normalized = String(expectedName).toLowerCase();
    if (Array.isArray(headers)) {
      const entry = headers.find(
        (item) => Array.isArray(item) && String(item[0]).toLowerCase() === normalized
      );
      return entry ? String(entry[1]) : null;
    }
    const entry = Object.entries(Object(headers)).find(
      ([name]) => name.toLowerCase() === normalized
    );
    return entry ? String(entry[1]) : null;
  };
  const requestHeader = (resource, init, name) => {
    const initHeaders =
      init && 'headers' in Object(init) ? init.headers : undefined;
    const resourceHeaders =
      resource &&
      typeof resource !== 'string' &&
      !(resource instanceof globalThis.URL)
        ? resource.headers
        : undefined;
    return headerValue(initHeaders === undefined ? resourceHeaders : initHeaders, name);
  };

  const dedicated = typeof globalThis.postMessage === 'function';
  let sharedParentPorts = [];
  let sharedParentWaiters = [];
  if (!dedicated && typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('connect', (event) => {
      const port = event.ports && event.ports[0];
      if (!port) return;
      sharedParentPorts = sharedParentPorts.filter((candidate) => candidate !== port);
      sharedParentPorts.push(port);
      if (sharedParentPorts.length > maxSharedParentPorts) {
        sharedParentPorts.splice(0, sharedParentPorts.length - maxSharedParentPorts);
      }
      if (typeof port.start === 'function') port.start();
      const waiters = sharedParentWaiters;
      sharedParentWaiters = [];
      for (const resolveWaiter of waiters) {
        resolveWaiter();
      }
    });
  }

  const waitForSharedParent = () => {
    if (sharedParentPorts.length > 0) return Promise.resolve();
    return new Promise((resolveWaiter, rejectWaiter) => {
      let timeout;
      const connected = () => {
        if (timeout !== undefined) globalThis.clearTimeout(timeout);
        resolveWaiter();
      };
      sharedParentWaiters.push(connected);
      timeout = globalThis.setTimeout(() => {
        sharedParentWaiters = sharedParentWaiters.filter((waiter) => waiter !== connected);
        rejectWaiter(new Error('No SharedWorker parent relay connected'));
      }, sharedParentProbeTimeoutMs);
    });
  };
  const probeSharedParent = (parentPort) =>
    new Promise((resolveProbe) => {
      const probeId = String(Date.now()) + ':probe:' + String(sharedProbeSequence++);
      const channel = new globalThis.MessageChannel();
      const port = channel.port1;
      let settled = false;
      let timeout;
      const finish = (alive) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) globalThis.clearTimeout(timeout);
        port.onmessage = null;
        port.onmessageerror = null;
        if (typeof port.close === 'function') port.close();
        resolveProbe(alive);
      };
      port.onmessage = (event) => {
        const response = event.data;
        finish(Boolean(response && response.kind === 'probe-ack' && response.probeId === probeId));
      };
      port.onmessageerror = () => finish(false);
      if (typeof port.start === 'function') port.start();
      timeout = globalThis.setTimeout(() => finish(false), sharedParentProbeTimeoutMs);
      try {
        parentPort.postMessage(
          {
            channel: relayChannel,
            kind: 'probe',
            probeId
          },
          [channel.port2]
        );
      } catch {
        finish(false);
      }
    });
  const selectSharedParent = async () => {
    await waitForSharedParent();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = [...sharedParentPorts].reverse();
      for (const port of snapshot) {
        if (await probeSharedParent(port)) return port;
        sharedParentPorts = sharedParentPorts.filter((candidate) => candidate !== port);
      }
      if (sharedParentPorts.length === 0) break;
    }
    throw new Error('No live SharedWorker parent relay is available');
  };

  const sendToParent = async (message, transfer) => {
    if (dedicated) {
      globalThis.postMessage(message, transfer);
      return;
    }
    const parentPort = await selectSharedParent();
    parentPort.postMessage(message, transfer);
  };

  const relayFetch = (url, integrity, signal, expectedLocal, range) => {
    if (
      typeof globalThis.MessageChannel !== 'function' ||
      typeof globalThis.ReadableStream !== 'function' ||
      typeof globalThis.Response !== 'function'
    ) {
      return expectedLocal
        ? Promise.reject(new Error('Worker local-asset streaming is unavailable'))
        : Promise.resolve(null);
    }
    if (signal && signal.aborted) return Promise.reject(abortError());
    if (activeRelays >= maxActiveRelays) {
      return Promise.reject(
        new Error('Too many concurrent worker local-asset streams')
      );
    }
    activeRelays += 1;

    return new Promise((resolveResponse, rejectResponse) => {
      const requestId = String(Date.now()) + ':' + String(requestSequence++);
      const channel = new globalThis.MessageChannel();
      const port = channel.port1;
      let awaitingAcknowledgement = null;
      let controller;
      let responseStarted = false;
      let settled = false;
      let timeout;
      let relayReleased = false;

      const removeAbortListener = () => {
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      };
      const close = () => {
        if (!relayReleased) {
          relayReleased = true;
          activeRelays -= 1;
        }
        if (timeout !== undefined) globalThis.clearTimeout(timeout);
        removeAbortListener();
        port.onmessage = null;
        port.onmessageerror = null;
        if (typeof port.close === 'function') port.close();
      };
      const fail = (reason) => {
        if (settled) return;
        settled = true;
        close();
        const error =
          reason && typeof reason === 'object' && typeof reason.name === 'string'
            ? reason
            : new Error(String(reason));
        if (responseStarted) controller.error(error);
        else rejectResponse(error);
      };
      const acknowledge = () => {
        if (awaitingAcknowledgement === null || settled) return;
        const sequence = awaitingAcknowledgement;
        awaitingAcknowledgement = null;
        port.postMessage({ kind: 'ack', requestId, sequence });
      };
      const stream = new globalThis.ReadableStream({
        start(nextController) {
          controller = nextController;
        },
        pull() {
          acknowledge();
        },
        cancel() {
          if (settled) return;
          port.postMessage({ kind: 'cancel', requestId });
          settled = true;
          close();
        }
      });
      const onAbort = () => {
        if (!settled) port.postMessage({ kind: 'cancel', requestId });
        fail(abortError());
      };
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      port.onmessage = (event) => {
        const message = event.data;
        if (!message || message.requestId !== requestId || settled) return;
        if (message.kind === 'miss') {
          settled = true;
          close();
          if (expectedLocal) {
            rejectResponse(new Error('Verified local worker asset is unavailable: ' + url));
          } else {
            resolveResponse(null);
          }
          return;
        }
        if (message.kind === 'response') {
          if (responseStarted) return;
          responseStarted = true;
          if (timeout !== undefined) globalThis.clearTimeout(timeout);
          resolveResponse(
            exposeResponseMetadata(
              new globalThis.Response(stream, {
                headers: message.headers,
                status: message.status || 200,
                statusText: message.statusText || 'OK'
              }),
              typeof message.url === 'string' ? message.url : url,
              Boolean(message.redirected)
            )
          );
          return;
        }
        if (message.kind === 'chunk') {
          if (!responseStarted) {
            fail(new Error('Worker asset relay sent bytes before response metadata'));
            return;
          }
          try {
            const bytes =
              message.data instanceof ArrayBuffer
                ? new Uint8Array(message.data)
                : new Uint8Array(message.data.buffer, message.data.byteOffset, message.data.byteLength);
            controller.enqueue(bytes);
            awaitingAcknowledgement = message.sequence;
            if ((controller.desiredSize || 0) > 0) acknowledge();
          } catch (error) {
            port.postMessage({ kind: 'cancel', requestId });
            fail(error);
          }
          return;
        }
        if (message.kind === 'end') {
          settled = true;
          close();
          controller.close();
          return;
        }
        if (message.kind === 'error') {
          fail(new Error(message.message || 'Worker local asset stream failed'));
        }
      };
      port.onmessageerror = () => {
        fail(new Error('Worker local asset relay message could not be decoded'));
      };
      if (typeof port.start === 'function') port.start();

      timeout = globalThis.setTimeout(() => {
        if (!settled) port.postMessage({ kind: 'cancel', requestId });
        fail(new Error('Timed out opening a worker local asset stream'));
      }, relayTimeoutMs);
      void sendToParent(
        {
          channel: relayChannel,
          integrity: integrity || '',
          kind: 'request',
          range: range || '',
          requestId,
          url
        },
        [channel.port2]
      ).catch(fail);
    });
  };

  if (typeof globalThis.fetch === 'function') {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async function localWorkerAssetFetch(resource, init) {
      const method =
        (init && init.method) ||
        (resource && typeof resource !== 'string' && resource.method) ||
        'GET';
      const input =
        typeof resource === 'string' || resource instanceof globalThis.URL
          ? resource
          : resource.url;
      const url = canonical(input);
      const integrity =
        init && 'integrity' in Object(init)
          ? String(init.integrity || '')
          : resource && typeof resource !== 'string' && !(resource instanceof globalThis.URL)
            ? String(resource.integrity || '')
            : '';
      const signal =
        init && 'signal' in Object(init)
          ? init.signal
          : resource && typeof resource !== 'string' && !(resource instanceof globalThis.URL)
            ? resource.signal
            : undefined;
      const range = requestHeader(resource, init, 'range');
      if (method.toUpperCase() === 'GET' && url && localAssets.has(url)) {
        const response = await relayFetch(url, integrity, signal, true, range);
        if (response) return response;
      }
      return nativeFetch(
        typeof resource === 'string' || resource instanceof globalThis.URL
          ? resolve(resource)
          : resource,
        init
      );
    };
  }

  if (typeof globalThis.XMLHttpRequest === 'function') {
    const NativeXMLHttpRequest = globalThis.XMLHttpRequest;
    const eventNames = [
      'abort',
      'error',
      'load',
      'loadend',
      'loadstart',
      'progress',
      'readystatechange',
      'timeout'
    ];

    class LocalWorkerXMLHttpRequest extends globalThis.EventTarget {
      constructor() {
        super();
        this.local = false;
        this.localHeaders = {};
        this.localResponse = null;
        this.localResponseText = '';
        this.localResponseType = '';
        this.localStatus = 0;
        this.localStatusText = '';
        this.localTimeout = 0;
        this.localRequestUrl = '';
        this.localUrl = '';
        this.localWithCredentials = false;
        this.activeReader = null;
        this.abortController = null;
        this.requestHeaders = {};
        this.sendStarted = false;
        this.state = 0;
        this.timer = null;
        this.epoch = 0;
        this.native = this.createNative(this.epoch);
      }

      createNative(epoch) {
        const native = new NativeXMLHttpRequest();
        for (const name of eventNames) {
          native.addEventListener(name, (event) => {
            if (epoch !== this.epoch || this.native !== native) return;
            this.emit(
              name,
              name === 'progress'
                ? {
                    lengthComputable: event.lengthComputable,
                    loaded: event.loaded,
                    total: event.total
                  }
                : undefined
            );
          });
        }
        return native;
      }

      beginOpen() {
        const previousNative = this.native;
        const previousReader = this.activeReader;
        const previousAbortController = this.abortController;
        this.epoch += 1;
        if (this.timer !== null) globalThis.clearTimeout(this.timer);
        this.timer = null;
        previousAbortController?.abort();
        void previousReader?.cancel().catch(() => {});
        try {
          previousNative.abort();
        } catch {}
        this.native = this.createNative(this.epoch);
        this.activeReader = null;
        this.abortController = null;
        this.local = false;
        this.localHeaders = {};
        this.localResponse = null;
        this.localResponseText = '';
        this.localStatus = 0;
        this.localStatusText = '';
        this.localRequestUrl = '';
        this.localUrl = '';
        this.requestHeaders = {};
        this.sendStarted = false;
        this.state = 0;
      }

      emit(name, init) {
        const event =
          name === 'progress' && typeof globalThis.ProgressEvent === 'function'
            ? new globalThis.ProgressEvent(name, init)
            : new globalThis.Event(name);
        this.dispatchEvent(event);
        const handler = this['on' + name];
        if (typeof handler === 'function') handler.call(this, event);
      }

      transition(state) {
        this.state = state;
        this.emit('readystatechange');
      }

      resetLocalResponse() {
        this.localHeaders = {};
        this.localResponse = null;
        this.localResponseText = '';
        this.localStatus = 0;
        this.localStatusText = '';
        this.localUrl = '';
      }

      open(method, input, async = true, username, password) {
        this.beginOpen();
        const url = canonical(input);
        this.local =
          String(method).toUpperCase() === 'GET' && url !== null && localAssets.has(url);
        this.localRequestUrl = url || String(input);
        if (this.local) {
          if (async === false) {
            throw new globalThis.DOMException(
              'Synchronous XHR is not supported for local mirrored assets',
              'NotSupportedError'
            );
          }
          this.transition(1);
          return;
        }
        this.native.open(method, resolve(input), async, username, password);
        this.native.responseType = this.localResponseType;
        this.native.timeout = this.localTimeout;
        this.native.withCredentials = this.localWithCredentials;
      }

      send(body = null) {
        if (!this.local) {
          this.native.responseType = this.localResponseType;
          this.native.timeout = this.localTimeout;
          this.native.withCredentials = this.localWithCredentials;
          this.native.send(body);
          return;
        }
        if (this.state !== 1 || this.sendStarted) {
          throw new globalThis.DOMException(
            'XMLHttpRequest is not opened or has already been sent',
            'InvalidStateError'
          );
        }
        this.sendStarted = true;
        void this.sendLocal();
      }

      async sendLocal() {
        const epoch = this.epoch;
        this.emit('loadstart');
        const abortController = new globalThis.AbortController();
        this.abortController = abortController;
        if (this.localTimeout > 0) {
          this.timer = globalThis.setTimeout(() => {
            if (epoch !== this.epoch) return;
            this.timer = null;
            abortController.abort();
            this.resetLocalResponse();
            this.sendStarted = false;
            this.transition(4);
            this.emit('timeout');
            this.emit('loadend');
          }, this.localTimeout);
        }

        try {
          const response = await globalThis.fetch(this.localRequestUrl, {
            headers: this.requestHeaders,
            signal: abortController.signal
          });
          if (epoch !== this.epoch) {
            await response.body?.cancel().catch(() => {});
            return;
          }
          if (this.state === 4) return;
          this.localUrl = response.url;
          this.localStatus = response.status;
          this.localStatusText = response.statusText;
          this.localHeaders = {};
          response.headers.forEach((value, name) => {
            this.localHeaders[name.toLowerCase()] = value;
          });
          this.transition(2);
          const reader = response.body && response.body.getReader();
          if (!reader) throw new Error('Local asset response has no readable body');
          this.activeReader = reader;
          const declaredSize = Number(response.headers.get('content-length'));
          if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
            throw new Error('Local asset response has an invalid content length');
          }
          const merged = new Uint8Array(declaredSize);
          let received = 0;
          while (true) {
            const result = await reader.read();
            if (epoch !== this.epoch) {
              await reader.cancel().catch(() => {});
              return;
            }
            if (result.done) break;
            if (received + result.value.byteLength > merged.byteLength) {
              throw new Error('Local asset response exceeded its verified size');
            }
            merged.set(result.value, received);
            received += result.value.byteLength;
            if (this.state !== 3) this.transition(3);
            this.emit('progress', {
              lengthComputable: true,
              loaded: received,
              total: declaredSize
            });
          }
          if (received !== merged.byteLength) {
            throw new Error('Local asset response did not match its verified size');
          }
          if (this.state === 4) return;
          const bytes = merged.buffer;
          if (this.localResponseType === 'arraybuffer') {
            this.localResponse = bytes;
          } else if (this.localResponseType === 'blob') {
            this.localResponse = new globalThis.Blob([bytes], {
              type: response.headers.get('content-type') || ''
            });
          } else {
            const text = new globalThis.TextDecoder().decode(bytes);
            this.localResponseText = text;
            if (this.localResponseType === 'json') {
              try {
                this.localResponse = JSON.parse(text);
              } catch {
                this.localResponse = null;
              }
            } else {
              this.localResponse = text;
            }
          }
          this.sendStarted = false;
          this.transition(4);
          this.emit('load');
          this.emit('loadend');
        } catch (error) {
          if (epoch !== this.epoch) return;
          if (this.state === 4) return;
          if (error && error.name === 'AbortError') return;
          await this.activeReader?.cancel().catch(() => {});
          this.resetLocalResponse();
          this.sendStarted = false;
          this.transition(4);
          this.emit('error');
          this.emit('loadend');
        } finally {
          if (epoch === this.epoch) {
            if (this.timer !== null) globalThis.clearTimeout(this.timer);
            this.timer = null;
            this.activeReader = null;
            this.abortController = null;
          }
        }
      }

      abort() {
        if (!this.local) {
          this.native.abort();
          return;
        }
        const active =
          (this.state === 1 && this.sendStarted) ||
          this.state === 2 ||
          this.state === 3;
        if (!active && this.state !== 4) return;
        const abortController = this.abortController;
        this.epoch += 1;
        if (this.timer !== null) globalThis.clearTimeout(this.timer);
        this.timer = null;
        abortController?.abort();
        void this.activeReader?.cancel().catch(() => {});
        this.activeReader = null;
        this.abortController = null;
        this.resetLocalResponse();
        this.sendStarted = false;
        if (active) {
          this.transition(4);
          this.emit('abort');
          this.emit('loadend');
        }
        this.state = 0;
      }

      setRequestHeader(name, value) {
        if (!this.local) {
          this.native.setRequestHeader(name, value);
          return;
        }
        if (this.state !== 1 || this.sendStarted) {
          throw new globalThis.DOMException(
            'XMLHttpRequest is not opened or has already been sent',
            'InvalidStateError'
          );
        }
        const normalized = String(name).toLowerCase();
        this.requestHeaders[normalized] = this.requestHeaders[normalized]
          ? this.requestHeaders[normalized] + ', ' + String(value)
          : String(value);
      }

      getResponseHeader(name) {
        return this.local
          ? this.localHeaders[String(name).toLowerCase()] || null
          : this.native.getResponseHeader(name);
      }

      getAllResponseHeaders() {
        if (!this.local) return this.native.getAllResponseHeaders();
        return Object.entries(this.localHeaders)
          .map(([name, value]) => name + ': ' + value)
          .join('\r\n');
      }

      overrideMimeType(value) {
        if (!this.local) this.native.overrideMimeType(value);
      }

      get readyState() {
        return this.local ? this.state : this.native.readyState;
      }

      get response() {
        return this.local ? this.localResponse : this.native.response;
      }

      get responseText() {
        if (!this.local) return this.native.responseText;
        if (this.localResponseType !== '' && this.localResponseType !== 'text') {
          throw new globalThis.DOMException(
            'responseText is unavailable for this responseType',
            'InvalidStateError'
          );
        }
        return this.localResponseText;
      }

      get responseType() {
        return this.local ? this.localResponseType : this.native.responseType;
      }

      set responseType(value) {
        this.localResponseType = value;
        if (!this.local && this.native.readyState > 0) this.native.responseType = value;
      }

      get responseURL() {
        return this.local ? this.localUrl : this.native.responseURL;
      }

      get responseXML() {
        return this.local ? null : this.native.responseXML;
      }

      get status() {
        return this.local ? this.localStatus : this.native.status;
      }

      get statusText() {
        return this.local ? this.localStatusText : this.native.statusText;
      }

      get timeout() {
        return this.local ? this.localTimeout : this.native.timeout;
      }

      set timeout(value) {
        this.localTimeout = Number(value);
        if (!this.local && this.native.readyState > 0) this.native.timeout = value;
      }

      get upload() {
        return this.native.upload;
      }

      get withCredentials() {
        return this.local ? this.localWithCredentials : this.native.withCredentials;
      }

      set withCredentials(value) {
        this.localWithCredentials = Boolean(value);
        if (!this.local && this.native.readyState > 0) this.native.withCredentials = value;
      }
    }

    for (const [name, value] of [
      ['UNSENT', 0],
      ['OPENED', 1],
      ['HEADERS_RECEIVED', 2],
      ['LOADING', 3],
      ['DONE', 4]
    ]) {
      Object.defineProperty(LocalWorkerXMLHttpRequest, name, { value });
      Object.defineProperty(LocalWorkerXMLHttpRequest.prototype, name, { value });
    }
    globalThis.XMLHttpRequest = LocalWorkerXMLHttpRequest;
  }

  if (typeof globalThis.importScripts === 'function') {
    const nativeImportScripts = globalThis.importScripts.bind(globalThis);
    globalThis.importScripts = (...urls) => nativeImportScripts(...urls.map(resolve));
  }
  const installNestedWorkerRelay = (endpoint) => {
    if (!endpoint || typeof endpoint.addEventListener !== 'function') return;
    endpoint.addEventListener('message', (event) => {
      const request = event.data;
      if (
        !request ||
        request.channel !== relayChannel ||
        (request.kind !== 'request' && request.kind !== 'probe')
      ) {
        return;
      }
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      const port = event.ports && event.ports[0];
      if (!port) return;
      if (request.kind === 'probe') {
        try {
          port.postMessage({
            kind: 'probe-ack',
            probeId: request.probeId
          });
          if (typeof port.close === 'function') port.close();
        } catch {}
        return;
      }
      void sendToParent(request, [port]).catch((error) => {
        try {
          port.postMessage({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
            requestId: request.requestId
          });
        } catch {}
      });
    });
    if (typeof endpoint.start === 'function') endpoint.start();
  };
  for (const name of ['Worker', 'SharedWorker']) {
    const NativeWorker = globalThis[name];
    if (typeof NativeWorker !== 'function') continue;
    const LocalWorker = function LocalWorker(url, options) {
      const instance = new NativeWorker(resolve(url), options);
      installNestedWorkerRelay(name === 'SharedWorker' ? instance.port : instance);
      return instance;
    };
    Object.setPrototypeOf(LocalWorker, NativeWorker);
    LocalWorker.prototype = NativeWorker.prototype;
    globalThis[name] = LocalWorker;
  }
})();
`;
}
