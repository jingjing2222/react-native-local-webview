import type { HybridView, HybridViewMethods, HybridViewProps } from 'react-native-nitro-modules';

export interface LocalWebViewNativeProps extends HybridViewProps {
  assetsJson: string;
  baseUrl: string;
  configurationJson: string;
  documentId: string;
  html: string;
  sourceJson: string;
  onEvent: (event: string) => void;
  onShouldStartLoadWithRequest: (request: string) => boolean;
}

export interface LocalWebViewNativeMethods extends HybridViewMethods {
  clearCache(includeDiskFiles: boolean): void;
  clearFormData(): void;
  clearHistory(): void;
  goBack(): void;
  goForward(): void;
  injectJavaScript(script: string): void;
  postMessage(message: string): void;
  reload(): void;
  requestFocus(): void;
  stopLoading(): void;
}

export type NativeLocalWebView = HybridView<LocalWebViewNativeProps, LocalWebViewNativeMethods>;
