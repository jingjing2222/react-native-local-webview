import { parse, type Node } from 'parse5';
import { describe, expect, it } from 'vitest';

import { ContentSecurityPolicyError } from '../src/resourceGraph';
import { prepareRuntimeDocument, prepareWebViewDocument } from '../src/prepareWebViewDocument';

type HtmlNode = Node;

function bridgeMarkers(html: string): string[] {
  const result: string[] = [];
  const visit = (node: HtmlNode): void => {
    if ('tagName' in node && node.tagName === 'script') {
      for (const attribute of node.attrs) {
        if (attribute.name.startsWith('data-react-native-local-webview-')) {
          result.push(attribute.name);
        }
      }
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(parse(html));
  return result;
}

describe('prepareWebViewDocument', () => {
  it('installs both bridges in one document transformation', () => {
    const result = prepareWebViewDocument(
      '<!doctype html><html><head><title>game</title></head><body></body></html>',
      {
        'https://game.example/game.wasm': {
          mediaType: 'application/wasm',
          size: 4,
          url: 'https://game.example/game.wasm',
        },
      }
    );

    expect(bridgeMarkers(result)).toEqual([
      'data-react-native-local-webview-history',
      'data-react-native-local-webview-assets',
    ]);
  });

  it('is idempotent and enforces meta CSP in the same pass', () => {
    const html =
      '<!doctype html><html><head><meta http-equiv="CONTENT-SECURITY-POLICY" content="default-src self"></head></html>';
    expect(() => prepareWebViewDocument(html, {})).toThrow(ContentSecurityPolicyError);

    const first = prepareWebViewDocument(html, {}, true);
    expect(first).not.toMatch(/content-security-policy/i);
    expect(prepareWebViewDocument(first, {}, true)).toBe(first);
  });

  it('replaces untrusted marker scripts with the current runtime and inventory', () => {
    const html = `<!doctype html><html><head>
      <script data-react-native-local-webview-history>globalThis.fakeHistory = true</script>
      <script data-react-native-local-webview-assets>globalThis.staleAsset = '/old.wasm'</script>
    </head><body></body></html>`;
    const assetUrl = 'https://game.example/current.wasm';

    const result = prepareWebViewDocument(html, {
      [assetUrl]: {
        mediaType: 'application/wasm',
        size: 4,
        url: assetUrl,
      },
    });

    expect(bridgeMarkers(result)).toEqual([
      'data-react-native-local-webview-history',
      'data-react-native-local-webview-assets',
    ]);
    expect(result).not.toContain('fakeHistory');
    expect(result).not.toContain('staleAsset');
    expect(result).toContain(assetUrl);
  });

  it('preserves browser-inert CSP meta elements', () => {
    const html = `<!doctype html><html><head>
      <meta data-case="missing" http-equiv="Content-Security-Policy">
      <meta data-case="empty" http-equiv="Content-Security-Policy" content="">
    </head><body>
      <meta data-case="body" http-equiv="Content-Security-Policy" content="script-src 'none'">
    </body></html>`;

    const result = prepareWebViewDocument(html, {}, true);

    expect(result).toContain('data-case="missing"');
    expect(result).toContain('data-case="empty"');
    expect(result).toContain('data-case="body"');
    expect(() => prepareWebViewDocument(html, {})).not.toThrow();
  });
});

describe('prepareRuntimeDocument', () => {
  it('does not install JS transport or History API shims', () => {
    const html = '<!doctype html><html><head></head><body>runtime</body></html>';
    expect(prepareRuntimeDocument(html)).toBe(html);
  });

  it('applies the same explicit meta CSP bypass policy', () => {
    const html =
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src none"></head><body></body></html>';
    expect(() => prepareRuntimeDocument(html)).toThrow(ContentSecurityPolicyError);
    expect(prepareRuntimeDocument(html, true)).not.toContain('Content-Security-Policy');
  });

  it('places a document-start script before page scripts', () => {
    const prepared = prepareRuntimeDocument(
      '<!doctype html><html><head><script>globalThis.order = ["page"]</script></head></html>',
      false,
      'globalThis.order = ["runtime"]'
    );

    expect(prepared.indexOf('globalThis.order = ["runtime"]')).toBeLessThan(
      prepared.indexOf('globalThis.order = ["page"]')
    );
    expect(prepared).toContain('data-local-webview-bootstrap');
  });
});
