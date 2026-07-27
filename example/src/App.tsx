import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { createReactNativeBlobUtilCacheAdapter, LocalWebView } from 'react-native-local-webview';

const ENTRY_URL = 'https://book.jingjing2222.com/';

export default function App() {
  const [origin, setOrigin] = useState('Checking origin…');
  const cacheAdapter = useMemo(
    () => createReactNativeBlobUtilCacheAdapter(ReactNativeBlobUtil),
    []
  );

  return (
    <View style={styles.container}>
      <LocalWebView
        cacheAdapter={cacheAdapter}
        allowContentSecurityPolicyBypass
        injectedJavaScript={`
          (() => {
            let finished = false;
            const report = (historyWorks, details = '') => {
              if (finished) return;
              finished = true;
              window.ReactNativeWebView.postMessage(JSON.stringify({
                channel: 'local-webview-example:diagnostic',
                details,
                historyWorks,
                origin: location.origin,
                secure: isSecureContext
              }));
            };
            const nextPopState = () => new Promise((resolve) => {
              addEventListener('popstate', resolve, { once: true });
            });

            void (async () => {
              const originalUrl = location.href;
              history.replaceState({ step: 'root' }, '', originalUrl);
              const initialLength = history.length;

              const originalScrollRestoration = history.scrollRestoration;
              history.scrollRestoration = 'manual';
              const scrollRestorationWorks =
                history.scrollRestoration === 'manual';
              history.scrollRestoration = originalScrollRestoration;

              history.pushState({ step: 'a' }, '', '/__history_a__#one');
              history.replaceState(
                { step: 'a-replaced' },
                '',
                '/__history_a_replaced__#two'
              );
              history.pushState({ step: 'b' }, '', '/__history_b__#three');

              const pushAndReplaceWork =
                history.length === initialLength + 2 &&
                history.state?.step === 'b';

              let traversal = nextPopState();
              history.back();
              await traversal;
              const backWorks =
                location.pathname === '/__history_a_replaced__' &&
                history.state?.step === 'a-replaced';

              traversal = nextPopState();
              history.forward();
              await traversal;
              const forwardWorks =
                location.pathname === '/__history_b__' &&
                history.state?.step === 'b';

              traversal = nextPopState();
              history.go(-2);
              await traversal;
              const goWorks =
                location.href === originalUrl &&
                history.state?.step === 'root';

              const results = {
                backWorks,
                forwardWorks,
                goWorks,
                pushAndReplaceWork,
                scrollRestorationWorks
              };
              report(
                Object.values(results).every(Boolean),
                JSON.stringify({
                  ...results,
                  historyLength: history.length,
                  initialLength
                })
              );
            })().catch((error) => report(false, String(error?.stack || error)));

            setTimeout(() => report(false), 3000);
          })();
          true;
        `}
        onMessage={({ nativeEvent }) => {
          let diagnostic: {
            channel?: string;
            details?: string;
            historyWorks?: boolean;
            origin?: string;
            secure?: boolean;
          };
          try {
            diagnostic = JSON.parse(nativeEvent.data) as typeof diagnostic;
          } catch {
            return;
          }
          if (
            diagnostic.channel !== 'local-webview-example:diagnostic' ||
            typeof diagnostic.origin !== 'string'
          ) {
            return;
          }
          setOrigin(
            `${diagnostic.origin} · secure=${String(diagnostic.secure === true)} · history=${String(diagnostic.historyWorks === true)} ${diagnostic.historyWorks === true ? '' : (diagnostic.details ?? '')}`
          );
        }}
        virtualUrl={ENTRY_URL}
        style={styles.webView}
      />
      <Text style={styles.origin}>{origin}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  origin: {
    backgroundColor: '#211a16',
    bottom: 20,
    color: '#fff',
    fontSize: 12,
    left: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    position: 'absolute',
    right: 20,
  },
  webView: {
    flex: 1,
  },
});
