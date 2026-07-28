import type { HybridObject } from 'react-native-nitro-modules';

/**
 * Native storage and networking primitives used by the bundle graph
 * orchestrator. File contents, response bodies, and hashes stay native unless
 * the JavaScript parser explicitly requests a bounded text resource.
 */
export interface LocalWebViewCache extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  readonly documentsDirectory: string;

  cancelDownload(requestId: string): void;
  copyFile(source: string, destination: string): Promise<void>;
  download(requestId: string, requestJson: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  hashFile(path: string, algorithmsJson: string): Promise<string>;
  listDirectory(path: string): Promise<string[]>;
  makeDirectory(path: string): Promise<void>;
  moveFile(source: string, destination: string): Promise<void>;
  readFile(path: string, encoding: string): Promise<string>;
  readFileRange(path: string, start: number, end: number, encoding: string): Promise<string>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<number>;
  writeFile(path: string, value: string, encoding: string): Promise<void>;
}
