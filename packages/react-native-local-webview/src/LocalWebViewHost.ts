import { getHostComponent, type HybridRef } from 'react-native-nitro-modules';

import LocalWebViewConfig from '../nitrogen/generated/shared/json/LocalWebViewConfig.json';
import type { LocalWebViewViewMethods, LocalWebViewViewProps } from './LocalWebView.nitro';

export const LocalWebViewHost = getHostComponent<LocalWebViewViewProps, LocalWebViewViewMethods>(
  'LocalWebView',
  () => LocalWebViewConfig
);

export type LocalWebViewHostRef = HybridRef<LocalWebViewViewProps, LocalWebViewViewMethods>;
