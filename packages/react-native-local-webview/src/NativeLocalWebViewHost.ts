import { getHostComponent, type HybridRef } from 'react-native-nitro-modules';

import NativeLocalWebViewConfig from '../nitrogen/generated/shared/json/NativeLocalWebViewConfig.json';
import type { LocalWebViewNativeMethods, LocalWebViewNativeProps } from './LocalWebView.nitro';

export const NativeLocalWebViewHost = getHostComponent<
  LocalWebViewNativeProps,
  LocalWebViewNativeMethods
>('NativeLocalWebView', () => NativeLocalWebViewConfig);

export type NativeLocalWebViewHostRef = HybridRef<
  LocalWebViewNativeProps,
  LocalWebViewNativeMethods
>;
