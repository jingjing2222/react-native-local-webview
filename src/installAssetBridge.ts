import { parse, parseFragment, serialize, type Element, type Node } from 'parse5';

import { WORKER_ASSET_MESSAGE_CHANNEL } from './assetBridgeProtocol';
import { escapeScriptRawText } from './htmlRawText';

export const ASSET_MESSAGE_CHANNEL = 'react-native-local-webview:asset';
export const ASSET_BRIDGE_MARKER = 'data-react-native-local-webview-assets';

export type AssetBridgeDescriptor = {
  integrity?: Partial<Record<'sha256' | 'sha384' | 'sha512', string>>;
  mediaType: string;
  redirected?: boolean;
  responseUrl?: string;
  size: number;
  url: string;
};

function bridgeScript(assets: Record<string, AssetBridgeDescriptor>): string {
  const inventory = JSON.stringify(assets).replaceAll('<', '\\u003c');
  return String.raw`
(() => {
  if (window.__REACT_NATIVE_LOCAL_WEBVIEW_ASSETS__) return;

  const channel = ${JSON.stringify(ASSET_MESSAGE_CHANNEL)};
  const workerChannel = ${JSON.stringify(WORKER_ASSET_MESSAGE_CHANNEL)};
  const inventory = ${inventory};
  const pending = new Map();
  const nativeAdmissionQueue = [];
  const maxNativeRequests = 4;
  const maxPendingRequests = 512;
  const maxWorkerRelays = 128;
  let activeNativeRequests = 0;
  let dispatchingNativeRequests = false;
  let sequence = 0;

  const send = (message) => {
    if (!window.ReactNativeWebView) return false;
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({ channel, ...message }));
      return true;
    } catch {
      return false;
    }
  };

  const decode = (value) => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  };

  const integrityCandidates = (metadata) =>
    String(metadata || '')
      .trim()
      .split(/[\t\n\f\r ]+/)
      .flatMap((token) => {
        const match = token.match(
          /^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})(?:\?[^\s]*)?$/
        );
        return match ? [{ algorithm: match[1], digest: match[2] }] : [];
      });

  const validateIntegrity = (asset, metadata, url) => {
    const candidates = integrityCandidates(metadata);
    const strength = { sha256: 1, sha384: 2, sha512: 3 };
    const strongest = candidates.reduce(
      (current, candidate) =>
        !current || strength[candidate.algorithm] > strength[current]
          ? candidate.algorithm
          : current,
      null
    );
    if (!strongest) return;
    if (!asset.integrity || !asset.integrity[strongest]) {
      throw new TypeError(
        'Cannot verify ' + strongest + ' Subresource Integrity for local asset ' + url
      );
    }
    const canonical = (value) => {
      const unpadded = String(value)
        .replaceAll('-', '+')
        .replaceAll('_', '/')
        .replace(/=+$/, '');
      if (unpadded.length % 4 === 1) return null;
      const padded = unpadded.padEnd(
        unpadded.length + ((4 - (unpadded.length % 4)) % 4),
        '='
      );
      try {
        return atob(padded);
      } catch {
        return null;
      }
    };
    const actualDigest = canonical(asset.integrity[strongest]);
    if (
      actualDigest === null ||
      !candidates
        .filter((candidate) => candidate.algorithm === strongest)
        .some((candidate) => canonical(candidate.digest) === actualDigest)
    ) {
      throw new TypeError('Subresource Integrity verification failed for local asset ' + url);
    }
  };

  const acknowledge = (requestId, request) => {
    if (!request.awaitingAcknowledgement) return;
    request.awaitingAcknowledgement = false;
    send({ direction: 'web', kind: 'ack', requestId });
  };

  const abortReason = (signal) =>
    signal && signal.reason !== undefined
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError');

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

  const finishRequest = (requestId, request) => {
    if (pending.get(requestId) === request) pending.delete(requestId);
    if (request.nativeStarted) {
      request.nativeStarted = false;
      activeNativeRequests -= 1;
    } else {
      const queuedIndex = nativeAdmissionQueue.indexOf(requestId);
      if (queuedIndex >= 0) nativeAdmissionQueue.splice(queuedIndex, 1);
    }
    if (
      request.signal &&
      request.abort &&
      typeof request.signal.removeEventListener === 'function'
    ) {
      request.signal.removeEventListener('abort', request.abort);
    }
    request.signal = null;
    request.abort = null;
    dispatchNativeRequests();
  };

  const dispatchNativeRequests = () => {
    if (dispatchingNativeRequests) return;
    dispatchingNativeRequests = true;
    try {
      while (
        activeNativeRequests < maxNativeRequests &&
        nativeAdmissionQueue.length > 0
      ) {
        const requestId = nativeAdmissionQueue.shift();
        const request = pending.get(requestId);
        if (!request || request.nativeStarted) continue;
        request.nativeStarted = true;
        activeNativeRequests += 1;
        if (
          !send({
            direction: 'web',
            kind: 'request',
            requestId,
            url: request.url
          })
        ) {
          finishRequest(requestId, request);
          request.controller.error(
            new Error('ReactNativeWebView bridge is unavailable')
          );
        }
      }
    } finally {
      dispatchingNativeRequests = false;
    }
  };

  const receive = (event) => {
    if (event.source != null) return;
    let message;
    try {
      message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (!message || message.channel !== channel || message.direction !== 'native') return;
    const request = pending.get(message.requestId);
    if (!request) return;
    if (message.kind === 'chunk') {
      try {
        const bytes = decode(message.data);
        request.receivedBytes += bytes.byteLength;
        if (request.receivedBytes > request.asset.size) {
          throw new RangeError(
            'Local asset stream exceeded its verified size for ' + request.url
          );
        }
        request.controller.enqueue(bytes);
        request.awaitingAcknowledgement = true;
        if ((request.controller.desiredSize || 0) > 0) {
          acknowledge(message.requestId, request);
        }
      } catch (error) {
        finishRequest(message.requestId, request);
        send({ direction: 'web', kind: 'cancel', requestId: message.requestId });
        request.controller.error(error);
      }
      return;
    }
    finishRequest(message.requestId, request);
    if (message.kind === 'end' && request.receivedBytes === request.asset.size) {
      request.controller.close();
    } else if (message.kind === 'end') {
      request.controller.error(
        new RangeError(
          'Local asset stream ended at ' +
            String(request.receivedBytes) +
            ' of ' +
            String(request.asset.size) +
            ' verified bytes for ' +
            request.url
        )
      );
    }
    else request.controller.error(new Error(message.message || 'Local asset stream failed'));
  };

  addEventListener('message', receive);
  document.addEventListener('message', receive);

  const resolveAsset = (input, integrityMetadata = '', signal = null) => {
    let url;
    try {
      const parsed = new URL(input, document.baseURI || location.href);
      parsed.hash = '';
      url = parsed.href;
    } catch {
      return null;
    }
    const asset = inventory[url];
    if (!asset || typeof ReadableStream !== 'function') return null;
    validateIntegrity(asset, integrityMetadata, url);
    if (signal && signal.aborted) throw abortReason(signal);
    if (pending.size >= maxPendingRequests) {
      throw new RangeError(
        'Too many pending local asset requests (maximum ' +
          String(maxPendingRequests) +
          ')'
      );
    }

    const requestId = String(Date.now()) + ':' + String(sequence++);
    let controller;
    const stream = new ReadableStream({
      start(nextController) {
        controller = nextController;
      },
      pull() {
        const request = pending.get(requestId);
        if (request) acknowledge(requestId, request);
      },
      cancel() {
        const request = pending.get(requestId);
        if (!request) return;
        finishRequest(requestId, request);
        send({ direction: 'web', kind: 'cancel', requestId });
      }
    });
    const request = {
      abort: null,
      asset,
      awaitingAcknowledgement: false,
      controller,
      nativeStarted: false,
      receivedBytes: 0,
      url,
      signal: null
    };
    pending.set(requestId, request);
    if (signal && typeof signal.addEventListener === 'function') {
      request.signal = signal;
      request.abort = () => {
        if (pending.get(requestId) !== request) return;
        finishRequest(requestId, request);
        send({ direction: 'web', kind: 'cancel', requestId });
        controller.error(abortReason(signal));
      };
      signal.addEventListener('abort', request.abort, { once: true });
    }
    nativeAdmissionQueue.push(requestId);
    dispatchNativeRequests();
    return exposeResponseMetadata(
      new Response(stream, {
        headers: {
          'Content-Length': String(asset.size),
          'Content-Type': asset.mediaType
        },
        status: 200
      }),
      asset.responseUrl || url,
      Boolean(asset.redirected)
    );
  };

  const installWorkerRelay = (endpoint, closeMethodName) => {
    if (!endpoint || typeof endpoint.addEventListener !== 'function') return;
    const activeRelays = new Set();

    const cancelRelay = (relay, reason) => {
      if (relay.cancelled) return;
      relay.cancelled = true;
      if (relay.acknowledgement) {
        clearTimeout(relay.acknowledgement.timeout);
        relay.acknowledgement.reject(reason);
        relay.acknowledgement = null;
      }
      if (relay.reader) void relay.reader.cancel(reason).catch(() => {});
    };

    const closeRelay = (relay) => {
      if (relay.acknowledgement) {
        clearTimeout(relay.acknowledgement.timeout);
        relay.acknowledgement = null;
      }
      activeRelays.delete(relay);
      try {
        relay.port.close();
      } catch {}
    };

    const postToRelay = (relay, message, transfer) => {
      if (relay.cancelled) throw new DOMException('Worker asset request was cancelled', 'AbortError');
      const response = { requestId: relay.requestId, ...message };
      if (transfer) relay.port.postMessage(response, transfer);
      else relay.port.postMessage(response);
    };

    const waitForWorkerAcknowledgement = (relay, sequence) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!relay.acknowledgement || relay.acknowledgement.sequence !== sequence) return;
          relay.acknowledgement = null;
          reject(new Error('Timed out waiting for worker asset acknowledgement'));
        }, 30000);
        relay.acknowledgement = { reject, resolve, sequence, timeout };
      });

    const pumpRelay = async (relay, request) => {
      try {
        const response = resolveAsset(request.url, request.integrity || '');
        if (!response) {
          postToRelay(relay, { kind: 'miss' });
          return;
        }
        const reader = response.body && response.body.getReader();
        if (!reader) throw new Error('Local worker asset response has no readable body');
        relay.reader = reader;
        postToRelay(relay, {
          headers: Array.from(response.headers.entries()),
          kind: 'response',
          redirected: response.redirected,
          status: response.status,
          statusText: response.statusText,
          url: response.url
        });

        let sequence = 0;
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          const data = result.value.slice().buffer;
          postToRelay(relay, { data, kind: 'chunk', sequence }, [data]);
          await waitForWorkerAcknowledgement(relay, sequence);
          sequence += 1;
        }
        postToRelay(relay, { kind: 'end' });
      } catch (error) {
        if (relay.reader) {
          await relay.reader.cancel(error).catch(() => {});
        }
        if (!relay.cancelled) {
          try {
            postToRelay(relay, {
              kind: 'error',
              message: error instanceof Error ? error.message : String(error)
            });
          } catch {}
        }
      } finally {
        if (relay.reader) {
          try {
            relay.reader.releaseLock();
          } catch {}
        }
        closeRelay(relay);
      }
    };

    const receiveWorkerRequest = (event) => {
      const request = event.data;
      if (!request || request.channel !== workerChannel) {
        return;
      }
      if (request.kind !== 'probe' && request.kind !== 'request') return;
      event.stopImmediatePropagation();
      event.stopPropagation();

      const port = event.ports && event.ports[0];
      if (!port || typeof port.postMessage !== 'function') return;
      if (request.kind === 'probe') {
        if (typeof request.probeId !== 'string') {
          try {
            port.close();
          } catch {}
          return;
        }
        try {
          port.postMessage({
            kind: 'probe-ack',
            probeId: request.probeId
          });
        } finally {
          try {
            port.close();
          } catch {}
        }
        return;
      }
      if (activeRelays.size >= maxWorkerRelays) {
        try {
          port.postMessage({
            kind: 'error',
            message:
              'Too many concurrent worker local-asset streams (maximum ' +
              String(maxWorkerRelays) +
              ')',
            requestId: request.requestId
          });
        } finally {
          try {
            port.close();
          } catch {}
        }
        return;
      }
      const relay = {
        acknowledgement: null,
        cancelled: false,
        port,
        requestId: request.requestId,
        reader: null
      };
      activeRelays.add(relay);
      port.addEventListener('message', (portEvent) => {
        const message = portEvent.data;
        if (!message || relay.cancelled) return;
        if (message.kind === 'cancel') {
          cancelRelay(
            relay,
            new DOMException('Worker asset request was cancelled', 'AbortError')
          );
          return;
        }
        if (
          message.kind === 'ack' &&
          relay.acknowledgement &&
          (message.sequence === undefined ||
            message.sequence === relay.acknowledgement.sequence)
        ) {
          const acknowledgement = relay.acknowledgement;
          relay.acknowledgement = null;
          clearTimeout(acknowledgement.timeout);
          acknowledgement.resolve();
        }
      });
      port.start();

      if (
        typeof request.requestId !== 'string' ||
        typeof request.url !== 'string' ||
        (request.integrity !== undefined && typeof request.integrity !== 'string')
      ) {
        try {
          postToRelay(relay, {
            kind: 'error',
            message: 'Invalid worker asset request'
          });
        } finally {
          closeRelay(relay);
        }
        return;
      }
      void pumpRelay(relay, request);
    };

    endpoint.addEventListener('message', receiveWorkerRequest);

    const close = endpoint[closeMethodName];
    if (typeof close === 'function') {
      try {
        Object.defineProperty(endpoint, closeMethodName, {
          configurable: true,
          value: function closeLocalWorker(...args) {
            for (const relay of activeRelays) {
              cancelRelay(
                relay,
                new DOMException('Worker asset owner was closed', 'AbortError')
              );
              closeRelay(relay);
            }
            return close.apply(this, args);
          },
          writable: true
        });
      } catch {}
    }
  };

  const wrapWorkerConstructor = (name) => {
    const NativeWorker = window[name];
    if (typeof NativeWorker !== 'function') return;
    window[name] = new Proxy(NativeWorker, {
      construct(Target, argumentsList, NewTarget) {
        const instance = Reflect.construct(Target, argumentsList, NewTarget);
        if (name === 'SharedWorker') {
          installWorkerRelay(instance.port, 'close');
        } else {
          installWorkerRelay(instance, 'terminate');
        }
        return instance;
      }
    });
  };

  wrapWorkerConstructor('Worker');
  wrapWorkerConstructor('SharedWorker');

  const networkFetch = window.fetch.bind(window);
  window.fetch = function localAssetFetch(resource, init) {
    const method =
      (init && init.method) ||
      (resource && typeof resource !== 'string' && resource.method) ||
      'GET';
    const input =
      typeof resource === 'string' || resource instanceof URL ? resource : resource.url;
    const integrity =
      init && 'integrity' in Object(init)
        ? String(init.integrity || '')
        : resource && typeof resource !== 'string' && !(resource instanceof URL)
          ? String(resource.integrity || '')
          : '';
    const signal =
      init && 'signal' in Object(init)
        ? init.signal
        : resource && typeof resource !== 'string' && !(resource instanceof URL)
          ? resource.signal
          : null;
    let response;
    try {
      response =
        method.toUpperCase() === 'GET' ? resolveAsset(input, integrity, signal) : null;
    } catch (error) {
      return Promise.reject(error);
    }
    return response ? Promise.resolve(response) : networkFetch(resource, init);
  };

  const NativeXMLHttpRequest = window.XMLHttpRequest;
  if (typeof NativeXMLHttpRequest === 'function' && typeof EventTarget === 'function') {
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

    class LocalAssetXMLHttpRequest extends EventTarget {
      constructor() {
        super();
        this.native = new NativeXMLHttpRequest();
        this.local = null;
        this.localHeaders = {};
        this.localResponse = null;
        this.localResponseText = '';
        this.localResponseType = '';
        this.localStatus = 0;
        this.localStatusText = '';
        this.localTimeout = 0;
        this.localUrl = '';
        this.localWithCredentials = false;
        this.requestHeaders = {};
        this.activeResponse = null;
        this.activeReader = null;
        this.localSendStarted = false;
        this.nativeRequestEpoch = -1;
        this.requestEpoch = 0;
        this.state = 0;
        this.timer = null;

        for (const name of eventNames) {
          this.native.addEventListener(name, (event) => {
            if (this.local !== null || this.nativeRequestEpoch !== this.requestEpoch) {
              return;
            }
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
      }

      emit(name, init) {
        const event =
          name === 'progress' && typeof ProgressEvent === 'function'
            ? new ProgressEvent(name, init)
            : new Event(name);
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
        this.requestEpoch += 1;
        this.nativeRequestEpoch = -1;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        if (this.activeReader) {
          void this.activeReader.cancel().catch(() => {});
        } else if (this.activeResponse?.body) {
          void this.activeResponse.body.cancel().catch(() => {});
        }
        this.activeReader = null;
        this.activeResponse = null;
        try {
          this.native.abort();
        } catch {}

        let absolute;
        try {
          const parsed = new URL(input, document.baseURI || location.href);
          parsed.hash = '';
          absolute = parsed.href;
        } catch {
          absolute = String(input);
        }
        this.local = null;
        this.resetLocalResponse();
        this.localSendStarted = false;
        this.requestHeaders = {};
        this.state = 0;
        this.local =
          String(method).toUpperCase() === 'GET' && inventory[absolute] ? absolute : null;
        if (this.local) {
          if (async === false) {
            throw new DOMException(
              'Synchronous XHR is not supported for local mirrored assets',
              'NotSupportedError'
            );
          }
          this.transition(1);
          return;
        }
        this.nativeRequestEpoch = this.requestEpoch;
        this.native.open(method, input, async, username, password);
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
        if (this.state !== 1 || this.localSendStarted) {
          throw new DOMException(
            'The object is in an invalid state for send()',
            'InvalidStateError'
          );
        }
        this.localSendStarted = true;
        const requestEpoch = this.requestEpoch;

        this.emit('loadstart');
        const descriptor = inventory[this.local];
        const response = resolveAsset(this.local);
        if (!response) {
          this.resetLocalResponse();
          this.transition(4);
          this.emit('error');
          this.emit('loadend');
          return;
        }
        this.activeResponse = response;

        if (this.localTimeout > 0) {
          this.timer = setTimeout(() => {
            if (this.requestEpoch !== requestEpoch) return;
            this.timer = null;
            void this.activeReader?.cancel().catch(() => {});
            this.resetLocalResponse();
            this.transition(4);
            this.emit('timeout');
            this.emit('loadend');
          }, this.localTimeout);
        }

        void (async () => {
          try {
            const reader = response.body?.getReader();
            if (!reader) throw new Error('Local asset response has no readable body');
            this.activeReader = reader;
            await 0;
            if (this.requestEpoch !== requestEpoch) return;
            this.localStatus = 200;
            this.localStatusText = 'OK';
            this.localUrl = response.url;
            this.localHeaders = {
              'content-length': String(descriptor.size),
              'content-type': descriptor.mediaType
            };
            this.transition(2);
            const merged = new Uint8Array(descriptor.size);
            let received = 0;
            while (true) {
              const result = await reader.read();
              if (this.requestEpoch !== requestEpoch) return;
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
                total: descriptor.size
              });
            }
            if (this.requestEpoch !== requestEpoch) return;
            if (received !== merged.byteLength) {
              throw new Error('Local asset response did not match its verified size');
            }
            const bytes = merged.buffer;
            if (this.state === 4) return;
            if (this.localResponseType === 'arraybuffer') {
              this.localResponse = bytes;
            } else if (this.localResponseType === 'blob') {
              this.localResponse = new Blob([bytes], { type: descriptor.mediaType });
            } else {
              const text = new TextDecoder().decode(bytes);
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
            this.transition(4);
            this.emit('load');
            this.emit('loadend');
          } catch {
            if (this.requestEpoch !== requestEpoch || this.state === 4) return;
            await this.activeReader?.cancel().catch(() => {});
            this.resetLocalResponse();
            this.transition(4);
            this.emit('error');
            this.emit('loadend');
          } finally {
            if (this.requestEpoch === requestEpoch) {
              if (this.timer !== null) clearTimeout(this.timer);
              this.timer = null;
              this.activeResponse = null;
              this.activeReader = null;
            }
          }
        })();
      }

      abort() {
        if (!this.local) {
          this.native.abort();
          return;
        }
        const active =
          (this.state === 1 && this.localSendStarted) ||
          this.state === 2 ||
          this.state === 3;
        if (!active && this.state !== 4) return;
        this.requestEpoch += 1;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        void this.activeReader?.cancel().catch(() => {});
        this.activeReader = null;
        this.activeResponse = null;
        this.resetLocalResponse();
        this.localSendStarted = false;
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
        if (this.state !== 1 || this.localSendStarted) {
          throw new DOMException(
            'The object is in an invalid state for setRequestHeader()',
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
          throw new DOMException(
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
      Object.defineProperty(LocalAssetXMLHttpRequest, name, { value });
      Object.defineProperty(LocalAssetXMLHttpRequest.prototype, name, { value });
    }
    window.XMLHttpRequest = LocalAssetXMLHttpRequest;
  }

  window.__REACT_NATIVE_LOCAL_WEBVIEW_ASSETS__ = {
    inventory,
    resolve: resolveAsset
  };
})();
`;
}

function publicAssetInventory(
  assets: Record<string, AssetBridgeDescriptor>
): Record<string, AssetBridgeDescriptor> {
  return Object.fromEntries(
    Object.entries(assets).map(([key, asset]) => [
      key,
      {
        ...(asset.integrity
          ? {
              integrity: {
                sha256: asset.integrity.sha256,
                sha384: asset.integrity.sha384,
                sha512: asset.integrity.sha512,
              },
            }
          : {}),
        mediaType: asset.mediaType,
        redirected: asset.redirected,
        responseUrl: asset.responseUrl,
        size: asset.size,
        url: asset.url,
      },
    ])
  );
}

export function createAssetBridgeScript(assets: Record<string, AssetBridgeDescriptor>): string {
  return bridgeScript(publicAssetInventory(assets));
}

export function installAssetBridge(
  html: string,
  assets: Record<string, AssetBridgeDescriptor>
): string {
  if (Object.keys(assets).length === 0) return html;

  const document = parse(html);
  let installed = false;
  let head: Element | undefined;
  const visit = (node: Node): void => {
    if ('tagName' in node) {
      if (node.tagName === 'head') head = node;
      if (
        node.tagName === 'script' &&
        node.attrs.some((attribute) => attribute.name === ASSET_BRIDGE_MARKER)
      ) {
        installed = true;
      }
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(document);
  if (installed) return html;
  if (!head) throw new Error('HTML document does not contain a <head>');

  const script = parseFragment(
    `<script ${ASSET_BRIDGE_MARKER}>${escapeScriptRawText(
      createAssetBridgeScript(assets)
    )}</script>`
  ).childNodes[0];
  if (!script) throw new Error('Failed to construct the local asset bridge');
  if ('parentNode' in script) script.parentNode = head;
  head.childNodes.unshift(script);
  return serialize(document);
}
