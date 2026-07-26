import LocalWebview from './NativeLocalWebview';

export function multiply(a: number, b: number): number {
  return LocalWebview.multiply(a, b);
}
