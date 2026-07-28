import { parse, parseFragment, serialize, type Element, type Node } from 'parse5';

import {
  ASSET_BRIDGE_MARKER,
  createAssetBridgeScript,
  type AssetBridgeDescriptor,
} from './installAssetBridge';
import { isEffectiveMetaContentSecurityPolicy } from './htmlContentSecurityPolicy';
import { HISTORY_BRIDGE_MARKER, HISTORY_BRIDGE_SCRIPT } from './installHistoryBridge';
import { escapeScriptRawText } from './htmlRawText';
import { ContentSecurityPolicyError } from './resourceGraph';

type HtmlNode = Node;
type HtmlElement = Element;

function marker(element: HtmlElement, name: string): boolean {
  return element.attrs.some((attribute) => attribute.name === name);
}

function removeElement(element: HtmlElement): void {
  const parent = element.parentNode;
  if (!parent || !('childNodes' in parent)) return;
  parent.childNodes = parent.childNodes.filter((child) => child !== element);
}

function scriptElement(markerName: string, source: string): HtmlElement {
  const node = parseFragment(`<script ${markerName}>${escapeScriptRawText(source)}</script>`)
    .childNodes[0];
  if (!node || !('tagName' in node)) {
    throw new Error(`Failed to construct ${markerName} bridge`);
  }
  return node;
}

/**
 * Applies the final document policy and both runtime bridges with one HTML5
 * parse/serialize pass. This path runs on the React Native JS thread just
 * before handing the string to the native WebView runtime.
 */
export function prepareWebViewDocument(
  html: string,
  assets: Record<string, AssetBridgeDescriptor>,
  allowContentSecurityPolicyBypass = false
): string {
  const document = parse(html);
  let changed = false;
  let head: HtmlElement | undefined;
  const internalBridgeScripts: HtmlElement[] = [];
  const policies: HtmlElement[] = [];

  const visit = (node: HtmlNode): void => {
    if ('tagName' in node) {
      if (node.tagName === 'head') head = node;
      if (node.tagName === 'script') {
        if (marker(node, ASSET_BRIDGE_MARKER) || marker(node, HISTORY_BRIDGE_MARKER)) {
          internalBridgeScripts.push(node);
        }
      } else if (isEffectiveMetaContentSecurityPolicy(node)) {
        policies.push(node);
      }
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(document);

  if (policies.length > 0 && !allowContentSecurityPolicyBypass) {
    throw new ContentSecurityPolicyError(
      'The entry HTML contains a Content-Security-Policy meta tag. Set allowContentSecurityPolicyBypass to true only when removing that policy is intentional.'
    );
  }
  for (const policy of policies) {
    removeElement(policy);
    changed = true;
  }
  // Marker attributes come from untrusted remote HTML and are not proof that
  // the current runtime (or the current asset inventory) is installed.
  for (const script of internalBridgeScripts) {
    removeElement(script);
    changed = true;
  }

  if (!head) throw new Error('HTML document does not contain a <head>');
  if (Object.keys(assets).length > 0) {
    const assetBridge = scriptElement(ASSET_BRIDGE_MARKER, createAssetBridgeScript(assets));
    assetBridge.parentNode = head;
    head.childNodes.unshift(assetBridge);
    changed = true;
  }
  const historyBridge = scriptElement(HISTORY_BRIDGE_MARKER, HISTORY_BRIDGE_SCRIPT);
  historyBridge.parentNode = head;
  head.childNodes.unshift(historyBridge);
  changed = true;

  return changed ? serialize(document) : html;
}

/**
 * The Nitro runtime serves assets inside a real WKWebView/Android WebView HTTPS
 * document and therefore needs neither the JS asset transport nor a History API
 * shim. It only applies the explicit CSP policy and strips bridge scripts that
 * may have been persisted by an older cache generation.
 */
export function prepareNativeWebViewDocument(
  html: string,
  allowContentSecurityPolicyBypass = false,
  documentStartScript?: string
): string {
  const document = parse(html);
  let head: HtmlElement | undefined;
  const removable: HtmlElement[] = [];
  const policies: HtmlElement[] = [];
  const visit = (node: HtmlNode): void => {
    if ('tagName' in node) {
      if (node.tagName === 'head') head = node;
      if (
        node.tagName === 'script' &&
        (marker(node, ASSET_BRIDGE_MARKER) || marker(node, HISTORY_BRIDGE_MARKER))
      ) {
        removable.push(node);
      } else if (isEffectiveMetaContentSecurityPolicy(node)) {
        policies.push(node);
      }
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(document);
  if (policies.length > 0 && !allowContentSecurityPolicyBypass) {
    throw new ContentSecurityPolicyError(
      'The entry HTML contains a Content-Security-Policy meta tag. Set allowContentSecurityPolicyBypass to true only when removing that policy is intentional.'
    );
  }
  for (const node of [...removable, ...policies]) removeElement(node);
  if (documentStartScript) {
    if (!head) throw new Error('HTML document does not contain a <head>');
    const bootstrap = scriptElement('data-local-webview-native-bootstrap', documentStartScript);
    bootstrap.parentNode = head;
    head.childNodes.unshift(bootstrap);
  }
  return removable.length > 0 || policies.length > 0 || documentStartScript
    ? serialize(document)
    : html;
}
