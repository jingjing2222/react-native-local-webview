import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { WebViewProps } from 'react-native-webview';

import type {
  NativeLocalWebViewHandle,
  NativeLocalWebViewProps,
} from '../src/NativeLocalWebView.native';
import {
  ANDROID_WEBVIEW_PROP_NAMES,
  IOS_WEBVIEW_PROP_NAMES,
  SHARED_WEBVIEW_PROP_NAMES,
  WEBVIEW_METHOD_NAMES,
  WINDOWS_WEBVIEW_PROP_NAMES,
  isOriginAllowed,
  nativeConfigurationFromProps,
  viewPropsFromWebViewProps,
} from '../src/webViewCompatibility';

const require = createRequire(import.meta.url);
const sourcePath = require.resolve('react-native-webview/src/WebViewTypes.ts');
const sourceFile = ts.createSourceFile(
  sourcePath,
  readFileSync(sourcePath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);
const declarationPath = require.resolve('react-native-webview/index.d.ts');
const declarationFile = ts.createSourceFile(
  declarationPath,
  readFileSync(declarationPath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);

function interfacePropertyNames(name: string): string[] {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name
  );
  if (!declaration) throw new Error(`Missing react-native-webview interface ${name}`);
  return declaration.members
    .filter(ts.isPropertySignature)
    .map((member) => member.name.getText(sourceFile));
}

function webViewClassMethodNames(): string[] {
  const declaration = declarationFile.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'WebView'
  );
  if (!declaration) throw new Error('Missing react-native-webview class WebView');
  return declaration.members
    .filter(
      (member): member is ts.MethodDeclaration | ts.PropertyDeclaration =>
        ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)
    )
    .map((member) => member.name.getText(declarationFile));
}

describe('react-native-webview 13.16.0 compatibility inventory', () => {
  it.each([
    ['WebViewSharedProps', SHARED_WEBVIEW_PROP_NAMES],
    ['IOSWebViewProps', IOS_WEBVIEW_PROP_NAMES],
    ['AndroidWebViewProps', ANDROID_WEBVIEW_PROP_NAMES],
    ['WindowsWebViewProps', WINDOWS_WEBVIEW_PROP_NAMES],
  ] as const)('tracks every own property in %s', (interfaceName, inventory) => {
    expect([...inventory]).toEqual(interfacePropertyNames(interfaceName));
  });

  it('tracks every imperative WebView method', () => {
    expect([...WEBVIEW_METHOD_NAMES].sort()).toEqual(webViewClassMethodNames().sort());
  });

  it('preserves the package history, sourcePath, and rollback API', () => {
    expectTypeOf<NativeLocalWebViewProps>().toHaveProperty('sourcePath');
    expectTypeOf<NativeLocalWebViewProps>().toHaveProperty('onHistoryChange');
    expectTypeOf<NativeLocalWebViewProps>().toHaveProperty('onCacheRollback');
    expectTypeOf<NativeLocalWebViewProps>().toHaveProperty('onBundleStored');
    expectTypeOf<NativeLocalWebViewHandle>().toHaveProperty('getHistoryState');
    expectTypeOf<NativeLocalWebViewHandle>().toHaveProperty('rollback');
  });

  it('forwards every defined native value, including false and zero', () => {
    const onMessage = () => undefined;
    expect(
      nativeConfigurationFromProps({
        javaScriptEnabled: false,
        onMessage,
        textZoom: 0,
        userAgent: '',
      } as WebViewProps)
    ).toEqual({
      javaScriptEnabled: false,
      textZoom: 0,
      userAgent: '',
    });
  });

  it('keeps View props while excluding WebView and package-only props', () => {
    expect(
      viewPropsFromWebViewProps(
        {
          accessibilityLabel: 'game',
          cacheAdapter: {},
          javaScriptEnabled: true,
          source: { html: '<html></html>' },
          testID: 'local-webview',
        } as WebViewProps & Record<string, unknown>,
        new Set(['cacheAdapter'])
      )
    ).toEqual({
      accessibilityLabel: 'game',
      testID: 'local-webview',
    });
  });

  it('matches complete standard and custom origins without prefix confusion', () => {
    expect(isOriginAllowed('https://example.com/page', ['https://example.com'])).toBe(true);
    expect(isOriginAllowed('https://example.com.evil/page', ['https://example.com'])).toBe(false);
    expect(isOriginAllowed('local-game://bundle/level', ['local-game://*'])).toBe(true);
    expect(isOriginAllowed('about:blank', [])).toBe(true);
  });
});
