import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import {
  createReactNativeBlobUtilCacheAdapter,
  LocalWebView,
  type LocalWebViewCacheAdapter,
  type MirroredWebBundle,
} from 'react-native-local-webview';

const MIB = 1024 * 1024;
const COOKIE = 'local-webview-benchmark=allowed';
const MOUNT_TIMEOUT_MS = 45 * 60 * 1000;

type BenchmarkConfiguration = {
  origin: string;
  platform: string;
  profile: string;
  runId: string;
  suite: 'full' | 'smoke';
};

type BridgeMetrics = {
  bytes: number;
  calls: number;
  firstStartedAt?: number;
  lastFinishedAt?: number;
};

type PageMessage =
  | {
      channel: 'local-webview-benchmark:page';
      kind: 'error';
      message: string;
    }
  | {
      channel: 'local-webview-benchmark:page';
      kind: 'ready';
      metrics: Record<string, unknown>;
    };

type ActiveMount = {
  allowContentSecurityPolicyBypass: boolean;
  cacheDirectory: string;
  expectedError: boolean;
  id: number;
  label: string;
  virtualUrl: string;
};

type MountResult =
  | {
      bridge: ReturnType<typeof finishBridgeMetrics>;
      bundle: MirroredWebBundle;
      bundleReadyMilliseconds: number;
      page: Record<string, unknown>;
      totalMilliseconds: number;
    }
  | {
      error: string;
      expectedError: true;
      totalMilliseconds: number;
    };

type PendingMount = {
  bridge: BridgeMetrics;
  bundle?: MirroredWebBundle;
  bundleReadyMilliseconds?: number;
  expectedError: boolean;
  page?: Record<string, unknown>;
  reject: (error: Error) => void;
  resolve: (result: MountResult) => void;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

function parseConfiguration(url: string): BenchmarkConfiguration | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'local-webview-benchmark:') return undefined;
    const origin = parsed.searchParams.get('origin');
    const runId = parsed.searchParams.get('runId');
    if (!origin || !runId || new URL(origin).protocol !== 'https:') return undefined;
    return {
      origin: new URL(origin).origin,
      platform: parsed.searchParams.get('platform') || 'unknown',
      profile: parsed.searchParams.get('profile') || 'default',
      runId,
      suite: parsed.searchParams.get('suite') === 'smoke' ? 'smoke' : 'full',
    };
  } catch {
    return undefined;
  }
}

async function postJson(origin: string, path: string, value: unknown): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${origin}${path}`, {
        body: JSON.stringify(value),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return;
    } catch (error) {
      failure = error;
      await new Promise<void>((resolve) =>
        setTimeout(() => resolve(), Math.min(5000, 250 * 2 ** attempt))
      );
    }
  }
  throw failure instanceof Error ? failure : new Error(String(failure));
}

function finishBridgeMetrics(metrics: BridgeMetrics) {
  const milliseconds =
    metrics.firstStartedAt === undefined || metrics.lastFinishedAt === undefined
      ? 0
      : Math.max(0, metrics.lastFinishedAt - metrics.firstStartedAt);
  return {
    bytes: metrics.bytes,
    calls: metrics.calls,
    mebibytesPerSecond: milliseconds > 0 ? metrics.bytes / MIB / (milliseconds / 1000) : 0,
    milliseconds,
  };
}

function cacheName(runId: string, label: string): string {
  return `${runId}-${label}`.replaceAll(/[^a-zA-Z0-9._-]/g, '-');
}

export function configurationFromBenchmarkUrl(url: string | null) {
  return url ? parseConfiguration(url) : undefined;
}

export default function BenchmarkApp({ configuration }: { configuration: BenchmarkConfiguration }) {
  const [active, setActive] = useState<ActiveMount>();
  const [status, setStatus] = useState('Preparing production benchmark…');
  const [failure, setFailure] = useState<string>();
  const mountSequence = useRef(0);
  const pending = useRef<PendingMount | undefined>(undefined);

  // The adapter is deliberately co-located with the LocalWebView that consumes it.
  // It adds the benchmark's authenticated download cookie and instruments direct
  // positional reads, which are the JS-to-native bridge path for local WebGL assets.
  const cacheAdapter = useMemo<LocalWebViewCacheAdapter>(() => {
    const base = createReactNativeBlobUtilCacheAdapter(ReactNativeBlobUtil);
    return {
      ...base,
      download: (options) =>
        base.download({
          ...options,
          headers: {
            ...options.headers,
            Cookie: COOKIE,
          },
        }),
      readFileRange: async (path, start, end, encoding) => {
        const bridge = pending.current?.bridge;
        const startedAt = Date.now();
        if (bridge && bridge.firstStartedAt === undefined) bridge.firstStartedAt = startedAt;
        const value = await base.readFileRange(path, start, end, encoding);
        if (bridge) {
          bridge.bytes += end - start;
          bridge.calls += 1;
          bridge.lastFinishedAt = Date.now();
        }
        return value;
      },
    };
  }, []);

  const settleIfReady = useCallback(() => {
    const current = pending.current;
    if (!current?.bundle || !current.page || current.bundleReadyMilliseconds === undefined) return;
    clearTimeout(current.timeout);
    pending.current = undefined;
    current.resolve({
      bridge: finishBridgeMetrics(current.bridge),
      bundle: current.bundle,
      bundleReadyMilliseconds: current.bundleReadyMilliseconds,
      page: current.page,
      totalMilliseconds: Date.now() - current.startedAt,
    });
  }, []);

  const mount = useCallback(
    (next: Omit<ActiveMount, 'id'>): Promise<MountResult> =>
      new Promise((resolve, reject) => {
        if (pending.current) {
          reject(new Error('A benchmark WebView is already active'));
          return;
        }
        const startedAt = Date.now();
        const timeout = setTimeout(() => {
          if (pending.current?.startedAt !== startedAt) return;
          pending.current = undefined;
          setActive(undefined);
          reject(new Error(`Timed out after ${MOUNT_TIMEOUT_MS}ms: ${next.label}`));
        }, MOUNT_TIMEOUT_MS);
        pending.current = {
          bridge: { bytes: 0, calls: 0 },
          expectedError: next.expectedError,
          reject,
          resolve,
          startedAt,
          timeout,
        };
        setActive({ ...next, id: ++mountSequence.current });
      }),
    []
  );

  const unmount = useCallback(async () => {
    setActive(undefined);
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 750));
  }, []);

  const run = useCallback(async () => {
    const { origin, platform, profile, runId, suite } = configuration;
    const sizes = suite === 'smoke' ? [50] : [50, 200, 500];
    const resourceCounts = suite === 'smoke' ? [100] : [100, 500, 1000];
    const report = async (value: Record<string, unknown>) =>
      postJson(origin, '/__control/report', {
        platform,
        profile,
        runId,
        suite,
        ...value,
      });
    const execute = async ({
      allowContentSecurityPolicyBypass = false,
      cacheDirectory,
      expectedError = false,
      label,
      phase,
      virtualUrl,
    }: {
      allowContentSecurityPolicyBypass?: boolean;
      cacheDirectory: string;
      expectedError?: boolean;
      label: string;
      phase: string;
      virtualUrl: string;
    }) => {
      setStatus(`${label}: ${phase}`);
      await report({ kind: 'scenario-start', label, phase, virtualUrl });
      const result = await mount({
        allowContentSecurityPolicyBypass,
        cacheDirectory,
        expectedError,
        label: `${label}:${phase}`,
        virtualUrl,
      });
      await unmount();
      await report({ kind: 'scenario-result', label, phase, result, virtualUrl });
      return result;
    };
    const removeCache = async (cacheDirectory: string) => {
      if (await cacheAdapter.exists(cacheDirectory)) await cacheAdapter.remove(cacheDirectory);
    };
    const scenarioCache = (label: string) =>
      `${cacheAdapter.directories.documents}/local-webview-benchmark/${cacheName(runId, label)}`;

    await postJson(origin, '/__control/reset', { runId });
    await report({
      kind: 'environment',
      userAgent: `React Native ${platform} ${profile}`,
    });

    for (const size of sizes) {
      const label = `unity-${size}MiB-etag`;
      const prefix = `/game/${size}/etag`;
      const virtualUrl = `${origin}${prefix}/index.html`;
      const cacheDirectory = scenarioCache(label);
      await removeCache(cacheDirectory);
      await execute({ cacheDirectory, label, phase: 'initial', virtualUrl });
      await execute({ cacheDirectory, label, phase: 'warm', virtualUrl });
      await postJson(origin, '/__control/offline', { offline: true, prefix });
      try {
        await execute({ cacheDirectory, label, phase: 'offline', virtualUrl });
      } finally {
        await postJson(origin, '/__control/offline', { offline: false, prefix });
      }
      await removeCache(cacheDirectory);
    }

    for (const count of resourceCounts) {
      const label = `resources-${count}`;
      const virtualUrl = `${origin}/resources/${count}/index.html`;
      const cacheDirectory = scenarioCache(label);
      await removeCache(cacheDirectory);
      await execute({ cacheDirectory, label, phase: 'initial', virtualUrl });
      await execute({ cacheDirectory, label, phase: 'warm-304', virtualUrl });
      await removeCache(cacheDirectory);
    }

    const noEtagSize = suite === 'smoke' ? 50 : 200;
    const noEtagLabel = `unity-${noEtagSize}MiB-no-etag`;
    const noEtagUrl = `${origin}/game/${noEtagSize}/no-etag/index.html`;
    const noEtagCache = scenarioCache(noEtagLabel);
    await removeCache(noEtagCache);
    await execute({
      cacheDirectory: noEtagCache,
      label: noEtagLabel,
      phase: 'initial',
      virtualUrl: noEtagUrl,
    });
    await execute({
      cacheDirectory: noEtagCache,
      label: noEtagLabel,
      phase: 'warm-no-etag',
      virtualUrl: noEtagUrl,
    });
    await removeCache(noEtagCache);

    const edgeLabel = 'csp-cookie-range-worker';
    const edgeUrl = `${origin}/edge/50/etag/index.html`;
    const edgeCache = scenarioCache(edgeLabel);
    await removeCache(edgeCache);
    await execute({
      cacheDirectory: edgeCache,
      expectedError: true,
      label: edgeLabel,
      phase: 'csp-rejected',
      virtualUrl: edgeUrl,
    });
    await execute({
      allowContentSecurityPolicyBypass: true,
      cacheDirectory: edgeCache,
      label: edgeLabel,
      phase: 'csp-bypass',
      virtualUrl: edgeUrl,
    });
    await removeCache(edgeCache);

    await postJson(origin, '/__control/complete', {
      kind: 'complete',
      platform,
      profile,
      runId,
      suite,
    });
    setStatus('Benchmark complete');
  }, [cacheAdapter, configuration, mount, unmount]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run().catch(async (error: unknown) => {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      pending.current = undefined;
      setActive(undefined);
      setFailure(message);
      setStatus('Benchmark failed');
      await postJson(configuration.origin, '/__control/complete', {
        error: message,
        kind: 'complete',
        platform: configuration.platform,
        profile: configuration.profile,
        runId: configuration.runId,
        suite: configuration.suite,
      }).catch(() => undefined);
    });
  }, [configuration, run]);

  return (
    <View style={styles.container}>
      {active ? (
        <LocalWebView
          key={active.id}
          cacheAdapter={cacheAdapter}
          cacheDirectory={active.cacheDirectory}
          cachePolicy={{
            maxBytes: 800 * MIB,
            maxGenerations: 1,
            maxInlineBytes: 4 * MIB,
          }}
          allowContentSecurityPolicyBypass={active.allowContentSecurityPolicyBypass}
          onBundleError={(error) => {
            const current = pending.current;
            if (!current) return;
            clearTimeout(current.timeout);
            pending.current = undefined;
            if (current.expectedError) {
              current.resolve({
                error: error.message,
                expectedError: true,
                totalMilliseconds: Date.now() - current.startedAt,
              });
            } else {
              current.reject(error);
            }
          }}
          onBundleReady={(bundle) => {
            const current = pending.current;
            if (!current) return;
            current.bundle = bundle;
            current.bundleReadyMilliseconds = Date.now() - current.startedAt;
            settleIfReady();
          }}
          onMessage={({ nativeEvent }) => {
            let message: PageMessage;
            try {
              message = JSON.parse(nativeEvent.data) as PageMessage;
            } catch {
              return;
            }
            if (message.channel !== 'local-webview-benchmark:page') return;
            const current = pending.current;
            if (!current) return;
            if (message.kind === 'error') {
              clearTimeout(current.timeout);
              pending.current = undefined;
              current.reject(new Error(message.message));
              return;
            }
            current.page = message.metrics;
            settleIfReady();
          }}
          virtualUrl={active.virtualUrl}
          style={styles.webView}
        />
      ) : (
        <View style={styles.placeholder} />
      )}
      <View style={styles.status}>
        <Text style={styles.statusText}>{status}</Text>
        {failure ? <Text style={styles.failure}>{failure}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#111',
    flex: 1,
  },
  failure: {
    color: '#ff8d8d',
    fontFamily: 'monospace',
    fontSize: 10,
    marginTop: 8,
  },
  placeholder: {
    flex: 1,
  },
  status: {
    backgroundColor: '#000d',
    left: 8,
    padding: 8,
    position: 'absolute',
    right: 8,
    top: 8,
  },
  statusText: {
    color: '#fff',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  webView: {
    flex: 1,
  },
});
