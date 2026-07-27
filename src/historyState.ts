import { HISTORY_MESSAGE_CHANNEL } from './installHistoryBridge';

export type LocalWebViewHistoryState = {
  canGoBack: boolean;
  canGoForward: boolean;
  length: number;
  navigationType: string;
  state: unknown;
  /**
   * `true` when the browser accepted the structured-clone state but the
   * React Native JSON message bridge could not serialize it.
   */
  stateSerializationFailed: boolean;
  url: string;
};

export function historyStateFromMessage(
  data: string,
  nativeState: {
    canGoBack: boolean;
    canGoForward: boolean;
  }
): LocalWebViewHistoryState | undefined {
  try {
    const message = JSON.parse(data) as Partial<LocalWebViewHistoryState> & {
      channel?: string;
    };
    if (message.channel !== HISTORY_MESSAGE_CHANNEL || typeof message.url !== 'string') {
      return undefined;
    }
    return {
      canGoBack: nativeState.canGoBack,
      canGoForward: nativeState.canGoForward,
      length:
        typeof message.length === 'number' && Number.isFinite(message.length) ? message.length : 1,
      navigationType:
        typeof message.navigationType === 'string' ? message.navigationType : 'unknown',
      state: message.state,
      stateSerializationFailed: message.stateSerializationFailed === true,
      url: message.url,
    };
  } catch {
    return undefined;
  }
}
