import { parse as parseJavaScript } from 'acorn';
import type { Node as AcornNode } from 'acorn';
import { full as walkJavaScript, fullAncestor as walkJavaScriptAncestors } from 'acorn-walk';
import {
  generate as generateCss,
  parse as parseCss,
  walk as walkCss,
} from 'css-tree/dist/csstree.esm';
import type { Atrule, CssNode, StringNode, Url } from 'css-tree/dist/csstree.esm';
import { analyze as analyzeScopes, type Variable } from 'eslint-scope';
import MagicString from 'magic-string';
import {
  parse as parseHtml,
  parseFragment,
  serialize,
  type ChildNode,
  type Element,
  type Node,
  type TextNode,
} from 'parse5';
import { parseSrcset, stringifySrcset } from 'srcset';
import { URL } from 'react-native-url-polyfill';

import {
  DYNAMIC_SCRIPT_CATALOG_INSTALLER_SOURCE,
  WORKER_CATALOG_INSTALLER_SOURCE,
} from './catalogInstallerSource';
import { isEffectiveMetaContentSecurityPolicy } from './htmlContentSecurityPolicy';
import { escapeStyleRawText } from './htmlRawText';
import { base64ToBytes, bytesToUtf8, sha256Text } from './binary';
import {
  integrityDigestForBytes,
  verifySubresourceIntegrity,
  type SubresourceIntegrityDigests,
} from './subresourceIntegrity';
import { createWorkerRuntimeBootstrap } from './workerRuntime';

type HtmlNode = Node;
type HtmlChildNode = ChildNode;
type HtmlElement = Element;

export class ContentSecurityPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentSecurityPolicyError';
  }
}

export type LoadedResource = {
  contentSecurityPolicy?: string;
  contentSecurityPolicyReportOnly?: string;
  content?: string;
  declaredMediaType?: string;
  delivery?: ResourceDelivery;
  encoding: 'base64';
  etag?: string;
  integrity?: SubresourceIntegrityDigests;
  localPath?: string;
  mediaType: string;
  redirected?: boolean;
  responseHeaders?: Record<string, string>;
  responseUrl?: string;
  sha256: string;
  size: number;
  url: string;
};

export type ResourceDelivery = 'file' | 'inline';

export type ResourceLoadOptions = {
  delivery?: ResourceDelivery;
  integrity?: string;
};

export type ResourceLoader = (
  url: string,
  options?: ResourceLoadOptions
) => Promise<LoadedResource>;

export type LocalizedDocument = {
  assets: LoadedResource[];
  html: string;
};

type JavaScriptNode = AcornNode & {
  argument?: AcornNode;
  arguments?: AcornNode[];
  body?: AcornNode[];
  callee?: AcornNode;
  computed?: boolean;
  declaration?: AcornNode;
  declarations?: AcornNode[];
  end: number;
  elements?: Array<AcornNode | null>;
  exported?: AcornNode;
  expressions?: AcornNode[];
  id?: AcornNode;
  init?: AcornNode;
  imported?: AcornNode;
  key?: AcornNode;
  left?: AcornNode;
  local?: AcornNode;
  meta?: AcornNode;
  name?: string;
  object?: AcornNode;
  operator?: string;
  optional?: boolean;
  options?: AcornNode;
  properties?: AcornNode[];
  property?: AcornNode;
  quasis?: Array<{ value?: { cooked?: string | null } }>;
  right?: AcornNode;
  shorthand?: boolean;
  source?: AcornNode;
  specifiers?: AcornNode[];
  start: number;
  value?: unknown;
};

type Replacement = {
  deferred?: boolean;
  eager?: boolean;
  end: number;
  expression?: string;
  kind:
    | 'asset'
    | 'classic-import'
    | 'classic-script'
    | 'classic-script-insert'
    | 'classic-worker'
    | 'current-script'
    | 'dynamic-import'
    | 'external-import'
    | 'fetch-asset'
    | 'import'
    | 'network'
    | 'rebase'
    | 'worker';
  propertyName?: string;
  scriptTarget?: string;
  start: number;
  url: string;
};

type ModuleRecord = {
  code: string;
  replacements: Replacement[];
  runtimeBaseUrl: string;
  url: string;
};

type WorkerContext = {
  rootKey: string;
  runtimeBaseUrl: string;
};

type ResolvedImportMap = {
  elements: HtmlElement[];
  imports: Map<string, string | null>;
  integrity: Map<string, string>;
  scopes: Map<string, Map<string, string | null>>;
};

type ReplacementValue =
  | string
  | {
      expression: string;
    };

type MaterializedBytesReservation = (size: number, label: string) => void;

type WorkerCatalogNode = {
  bootstrap?: string;
  code: string;
  format: 'classic' | 'module';
  links: Record<string, string>;
};

type WorkerCatalog = {
  id: string;
  nodes: Record<string, WorkerCatalogNode>;
};

type DynamicScriptCatalog = {
  id: string;
  nodes: Record<
    string,
    {
      code: string;
      integrity: Required<SubresourceIntegrityDigests>;
    }
  >;
};

const WORKER_MATERIALIZER_NAME = '__reactNativeLocalWebViewMaterializeWorker__';
const DYNAMIC_SCRIPT_MATERIALIZER_NAME = '__reactNativeLocalWebViewMaterializeDynamicScript__';
const DYNAMIC_SCRIPT_PREPARER_NAME = '__reactNativeLocalWebViewPrepareDynamicScript__';
const ORIGINAL_SCRIPT_SOURCE_ATTRIBUTE = 'data-react-native-local-webview-original-src';

function hermesSafeInstallerSource(installer: unknown, source: string): string {
  if (typeof installer !== 'function') throw new TypeError('Catalog installer must be a function');
  return source;
}

function installDynamicScriptCatalog(catalog: DynamicScriptCatalog): void {
  const materializerName = '__reactNativeLocalWebViewMaterializeDynamicScript__';
  const preparerName = '__reactNativeLocalWebViewPrepareDynamicScript__';
  const stateName = '__reactNativeLocalWebViewDynamicScriptMaterializerState__';
  const scope = globalThis as typeof globalThis & {
    [key: string]: unknown;
  };
  const existing = scope[stateName] as
    | {
        catalogId: string;
        urls: Map<string, string>;
      }
    | undefined;
  if (existing?.catalogId === catalog.id && scope[materializerName] && scope[preparerName]) return;

  const urls = new Map<string, string>();
  const canonicalBase64 = (value: string): string | null => {
    const unpadded = String(value).replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '');
    if (unpadded.length % 4 === 1) return null;
    const padded = unpadded.padEnd(unpadded.length + ((4 - (unpadded.length % 4)) % 4), '=');
    try {
      return globalThis.btoa(globalThis.atob(padded));
    } catch {
      return null;
    }
  };
  const verifyElementIntegrity = (
    node: DynamicScriptCatalog['nodes'][string],
    element: {
      getAttribute?: (name: string) => string | null;
      integrity?: string;
      removeAttribute?: (name: string) => void;
    }
  ): boolean => {
    const metadata =
      typeof element.integrity === 'string'
        ? element.integrity
        : (element.getAttribute?.('integrity') ?? '');
    const candidates = String(metadata)
      .trim()
      .split(/[\t\n\f\r ]+/)
      .flatMap((token) => {
        const match = token.match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})(?:\?[^\s]*)?$/);
        return match ? [{ algorithm: match[1]!, digest: match[2]! }] : [];
      });
    const strength: Record<string, number> = { sha256: 1, sha384: 2, sha512: 3 };
    const strongest = candidates.reduce<string | null>(
      (current, candidate) =>
        !current || strength[candidate.algorithm]! > strength[current]!
          ? candidate.algorithm
          : current,
      null
    );
    if (String(metadata).trim() && !strongest) return false;
    if (strongest) {
      const actual = canonicalBase64(node.integrity[strongest as keyof typeof node.integrity]);
      const matches =
        actual !== null &&
        candidates
          .filter((candidate) => candidate.algorithm === strongest)
          .some((candidate) => canonicalBase64(candidate.digest) === actual);
      if (!matches) {
        return false;
      }
    }
    element.removeAttribute?.('integrity');
    if (typeof element.integrity === 'string') element.integrity = '';
    return true;
  };
  const materialize = (
    id: string,
    element?: {
      getAttribute?: (name: string) => string | null;
      integrity?: string;
      removeAttribute?: (name: string) => void;
    }
  ): string => {
    const node = catalog.nodes[id];
    if (node === undefined) throw new Error(`Unknown localized dynamic script: ${id}`);
    if (element && !verifyElementIntegrity(node, element)) return id;
    const cached = urls.get(id);
    if (cached) return cached;
    const url = globalThis.URL.createObjectURL(
      new globalThis.Blob([node.code], { lastModified: 0, type: 'text/javascript' })
    );
    urls.set(id, url);
    return url;
  };
  scope[stateName] = {
    catalogId: catalog.id,
    urls,
  };
  scope[materializerName] = materialize;
  scope[preparerName] = (
    id: string,
    element: {
      getAttribute?: (name: string) => string | null;
      integrity?: string;
      removeAttribute?: (name: string) => void;
      src: string;
    }
  ) => {
    element.src = materialize(id, element);
    return element;
  };
}

function installWorkerCatalog(catalog: WorkerCatalog): void {
  const materializerName = '__reactNativeLocalWebViewMaterializeWorker__';
  const registerModuleName = '__reactNativeLocalWebViewRegisterWorkerModule__';
  const stateName = '__reactNativeLocalWebViewWorkerMaterializerState__';
  const scope = globalThis as typeof globalThis & {
    [key: string]: unknown;
  };
  const existing = scope[stateName] as
    | {
        catalogId: string;
        helperUrl: string;
        urls: Map<string, string>;
      }
    | undefined;
  if (existing?.catalogId === catalog.id && scope[materializerName] && scope[registerModuleName]) {
    return;
  }

  const urls = new Map<string, string>();
  const bootstrapUrls = new Map<string, string>();
  const installerSource = `(${installWorkerCatalog.toString()})(${JSON.stringify(catalog)})`;
  const helperUrl = globalThis.URL.createObjectURL(
    new globalThis.Blob([installerSource], { lastModified: 0, type: 'text/javascript' })
  );
  const materialize = (id: string): string => {
    const existingUrl = urls.get(id);
    if (existingUrl) return existingUrl;
    const visiting = new Set<string>();
    const stack: Array<{ expanded: boolean; id: string }> = [{ expanded: false, id }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (urls.has(frame.id)) {
        visiting.delete(frame.id);
        stack.pop();
        continue;
      }
      const node = catalog.nodes[frame.id];
      if (!node) throw new Error(`Unknown localized Worker module: ${frame.id}`);
      if (!frame.expanded) {
        if (visiting.has(frame.id)) {
          throw new Error(`Localized Worker graph still contains a cycle at: ${frame.id}`);
        }
        visiting.add(frame.id);
        frame.expanded = true;
        const dependencies = [...new Set(Object.values(node.links))];
        for (let index = dependencies.length - 1; index >= 0; index -= 1) {
          const dependencyId = dependencies[index]!;
          if (visiting.has(dependencyId)) {
            throw new Error(`Localized Worker graph still contains a cycle at: ${dependencyId}`);
          }
          if (!urls.has(dependencyId)) {
            stack.push({ expanded: false, id: dependencyId });
          }
        }
        continue;
      }
      let code = node.code;
      for (const [token, dependencyId] of Object.entries(node.links)) {
        const dependencyUrl = urls.get(dependencyId);
        if (!dependencyUrl) {
          throw new Error(`Localized Worker dependency was not materialized: ${dependencyId}`);
        }
        code = code.split(token).join(dependencyUrl);
      }
      if (node.format === 'module') {
        const imports = [helperUrl];
        if (node.bootstrap) {
          let bootstrapUrl = bootstrapUrls.get(node.bootstrap);
          if (!bootstrapUrl) {
            bootstrapUrl = globalThis.URL.createObjectURL(
              new globalThis.Blob([node.bootstrap], {
                lastModified: 0,
                type: 'text/javascript',
              })
            );
            bootstrapUrls.set(node.bootstrap, bootstrapUrl);
          }
          imports.push(bootstrapUrl);
        }
        code = `${imports.map((url) => `import ${JSON.stringify(url)};`).join('\n')}
globalThis[${JSON.stringify(registerModuleName)}](${JSON.stringify(frame.id)}, import.meta.url);
${code}`;
      } else {
        code = `importScripts(${JSON.stringify(helperUrl)});\n${node.bootstrap ?? ''}\n${code}`;
      }
      const url = globalThis.URL.createObjectURL(
        new globalThis.Blob([code], { lastModified: 0, type: 'text/javascript' })
      );
      urls.set(frame.id, url);
      visiting.delete(frame.id);
      stack.pop();
    }
    return urls.get(id)!;
  };
  scope[stateName] = {
    catalogId: catalog.id,
    helperUrl,
    urls,
  };
  scope[materializerName] = materialize;
  scope[registerModuleName] = (id: string, url: string): void => {
    urls.set(id, url);
  };
}

const RESOURCE_ATTRIBUTES: Record<string, string[]> = {
  audio: ['src'],
  embed: ['src'],
  image: ['href', 'xlink:href'],
  img: ['src'],
  input: ['src'],
  object: ['data'],
  source: ['src'],
  track: ['src'],
  use: ['href', 'xlink:href'],
  video: ['poster', 'src'],
};

const ASSET_LITERAL_EXTENSION =
  /\.(?:avif|br|css|data|gif|gz|ico|jpe?g|js|json|mem|mjs|mp3|mp4|ogg|otf|png|svg|unityweb|wasm|webm|webp|woff2?)(?:[?#].*)?$/i;

const STREAMED_RUNTIME_ASSET =
  /(?:\.(?:data|mem|symbols\.json|wasm)(?:\.(?:br|gz|unityweb))?|\.framework\.js\.unityweb)(?:[?#].*)?$/i;

const WEBGL_CONFIG_RESOURCE_NAMES = new Set([
  'asmcodeurl',
  'asmframeworkurl',
  'asmmemoryurl',
  'codeurl',
  'dataurl',
  'frameworkurl',
  'loaderurl',
  'memoryurl',
  'streamingassetsurl',
  'symbolsurl',
  'wasmcodeurl',
  'wasmframeworkurl',
  'wasmmemoryurl',
  'wasmurl',
  'workerurl',
]);
const WEBGL_DYNAMIC_SCRIPT_RESOURCE_NAMES = new Set([
  'asmframeworkurl',
  'frameworkurl',
  'wasmframeworkurl',
]);
const DIRECT_RESOURCE_SINK_NAMES = new Set(['href', 'src']);
const URL_LIKE_SPECIFIER = /^(?:\/|\.\/|\.\.\/|[a-zA-Z][a-zA-Z\d+.-]*:)/;
const EXECUTABLE_JAVASCRIPT_URL = /\.(?:js|mjs)(?:\.(?:br|gz))?(?:[?#].*)?$/i;

const JAVASCRIPT_MEDIA_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

function isHtmlElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node;
}

function childrenOf(node: HtmlNode): HtmlChildNode[] {
  if ('childNodes' in node) return node.childNodes;
  return [];
}

function walkHtml(node: HtmlNode, visitor: (element: HtmlElement) => void): void {
  if (isHtmlElement(node)) {
    visitor(node);
    // parse5 6 predates the HTML5 fix that keeps <noframes> body content
    // as RAWTEXT. Browsers do not activate or fetch markup inside it.
    if (node.tagName === 'noframes') return;
    const templateContent = (node as HtmlElement & { content?: HtmlNode }).content;
    if (node.tagName === 'template' && templateContent) {
      walkHtml(templateContent, visitor);
    }
  }
  for (const child of childrenOf(node)) walkHtml(child, visitor);
}

function walkActiveHtml(node: HtmlNode, visitor: (element: HtmlElement) => void): void {
  if (isHtmlElement(node)) {
    visitor(node);
    if (node.tagName === 'noframes') return;
  }
  for (const child of childrenOf(node)) walkActiveHtml(child, visitor);
}

function attribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((item) => item.name.toLowerCase() === name)?.value;
}

function setAttribute(element: HtmlElement, name: string, value: string): void {
  const current = element.attrs.find((item) => item.name.toLowerCase() === name);
  if (current) current.value = value;
  else element.attrs.push({ name, value });
}

function removeAttribute(element: HtmlElement, name: string): void {
  element.attrs = element.attrs.filter((item) => item.name.toLowerCase() !== name);
}

function removeElement(element: HtmlElement): void {
  const parent = element.parentNode;
  if (!parent || !('childNodes' in parent)) return;
  parent.childNodes = parent.childNodes.filter((child) => child !== element);
}

function elementFromHtml(source: string): HtmlElement {
  const fragment = parseFragment(source);
  const element = fragment.childNodes.find(isHtmlElement);
  if (!element) throw new Error('Failed to construct an HTML element');
  return element;
}

function textContent(element: HtmlElement): string {
  return element.childNodes
    .filter((node) => node.nodeName === '#text')
    .map((node) => ('value' in node ? node.value : ''))
    .join('');
}

function setTextContent(element: HtmlElement, value: string): void {
  const text: TextNode = {
    nodeName: '#text',
    parentNode: element,
    value,
  };
  element.childNodes = [text];
}

function absoluteUrl(value: string, baseUrl: string): string {
  if (
    value.startsWith('data:') ||
    value.startsWith('blob:') ||
    value.startsWith('javascript:') ||
    value.startsWith('#')
  ) {
    return value;
  }
  return new URL(value, baseUrl).toString();
}

function normalizedModuleSpecifier(value: string, baseUrl: string): string | undefined {
  if (!URL_LIKE_SPECIFIER.test(value)) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function addImportMapEntries(
  target: Map<string, string | null>,
  source: unknown,
  baseUrl: string
): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = normalizedModuleSpecifier(rawKey, baseUrl);
    if (!key || target.has(key)) continue;
    if (rawValue === null) {
      target.set(key, null);
      continue;
    }
    if (typeof rawValue !== 'string') continue;
    try {
      const value = new URL(rawValue, baseUrl).toString();
      if (key.endsWith('/') && !value.endsWith('/')) continue;
      target.set(key, value);
    } catch {
      // Invalid import-map entries are ignored by the browser as well.
    }
  }
}

function collectImportMap(document: HtmlNode, baseUrl: string): ResolvedImportMap {
  const result: ResolvedImportMap = {
    elements: [],
    imports: new Map(),
    integrity: new Map(),
    scopes: new Map(),
  };
  walkActiveHtml(document, (element) => {
    if (element.tagName !== 'script' || scriptType(element) !== 'importmap') return;
    result.elements.push(element);
    if (attribute(element, 'src')) return;
    try {
      const parsed = JSON.parse(textContent(element)) as {
        imports?: unknown;
        integrity?: unknown;
        scopes?: unknown;
      };
      addImportMapEntries(result.imports, parsed.imports, baseUrl);
      if (
        parsed.integrity &&
        typeof parsed.integrity === 'object' &&
        !Array.isArray(parsed.integrity)
      ) {
        for (const [rawUrl, metadata] of Object.entries(parsed.integrity)) {
          if (typeof metadata !== 'string') continue;
          try {
            const url = new URL(rawUrl, baseUrl).toString();
            if (!result.integrity.has(url)) result.integrity.set(url, metadata);
          } catch {
            // Invalid integrity URLs are ignored by the browser as well.
          }
        }
      }
      if (!parsed.scopes || typeof parsed.scopes !== 'object' || Array.isArray(parsed.scopes))
        return;
      for (const [rawScope, entries] of Object.entries(parsed.scopes)) {
        let scope: string;
        try {
          scope = new URL(rawScope, baseUrl).toString();
        } catch {
          continue;
        }
        const mappings = result.scopes.get(scope) ?? new Map<string, string | null>();
        addImportMapEntries(mappings, entries, baseUrl);
        result.scopes.set(scope, mappings);
      }
    } catch {
      // Preserve malformed maps so the browser reports the same parse error.
    }
  });
  return result;
}

function resolveFromSpecifierMap(
  specifier: string,
  mappings: Map<string, string | null>
): string | null | undefined {
  if (mappings.has(specifier)) return mappings.get(specifier);
  const prefix = [...mappings.keys()]
    .filter((key) => key.endsWith('/') && specifier.startsWith(key))
    .sort((left, right) => right.length - left.length)[0];
  if (!prefix) return undefined;
  const target = mappings.get(prefix);
  if (target === null || target === undefined) return target;
  try {
    const resolved = new URL(specifier.slice(prefix.length), target).toString();
    return resolved.startsWith(target) ? resolved : null;
  } catch {
    return null;
  }
}

function resolveModuleSpecifier(
  value: string,
  referrerUrl: string,
  importMap: ResolvedImportMap | undefined
): string | null | undefined {
  const normalized = normalizedModuleSpecifier(value, referrerUrl);
  if (normalized === undefined) return undefined;
  if (importMap) {
    const scopes = [...importMap.scopes.keys()]
      .filter((candidate) => referrerUrl.startsWith(candidate))
      .sort((left, right) => right.length - left.length);
    for (const scope of scopes) {
      const scoped = resolveFromSpecifierMap(normalized, importMap.scopes.get(scope)!);
      if (scoped !== undefined) return scoped;
    }
    const imported = resolveFromSpecifierMap(normalized, importMap.imports);
    if (imported !== undefined) return imported;
  }
  return URL_LIKE_SPECIFIER.test(value) ? normalized : undefined;
}

function shouldLoad(url: string): boolean {
  return url.startsWith('https:') || url.startsWith('http:');
}

function shouldLocalize(url: string, canLoad: (url: string) => boolean): boolean {
  return shouldLoad(url) && canLoad(url);
}

function percentEncodedUtf8Length(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (
      (first >= 0x41 && first <= 0x5a) ||
      (first >= 0x61 && first <= 0x7a) ||
      (first >= 0x30 && first <= 0x39) ||
      first === 0x21 ||
      first === 0x27 ||
      first === 0x28 ||
      first === 0x29 ||
      first === 0x2a ||
      first === 0x2d ||
      first === 0x2e ||
      first === 0x5f ||
      first === 0x7e
    ) {
      length += 1;
    } else if (first <= 0x7f) {
      length += 3;
    } else if (first <= 0x7ff) {
      length += 6;
    } else if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (second < 0xdc00 || second > 0xdfff) {
        throw new URIError('URI malformed');
      }
      length += 12;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new URIError('URI malformed');
    } else {
      length += 9;
    }
  }
  return length;
}

function dataUrl(
  mediaType: string,
  value: string,
  reserveMaterializedBytes?: MaterializedBytesReservation,
  label = mediaType
): string {
  const prefix = `data:${mediaType};charset=utf-8,`;
  reserveMaterializedBytes?.(prefix.length + percentEncodedUtf8Length(value), label);
  return `${prefix}${encodeURIComponent(value)}`;
}

function resourceContent(asset: LoadedResource): string {
  if (asset.content === undefined) {
    throw new Error(`Inline content is unavailable for ${asset.url}`);
  }
  return asset.content;
}

function resourceBytes(asset: LoadedResource): Uint8Array | undefined {
  return asset.content === undefined ? undefined : base64ToBytes(asset.content);
}

function verifyElementIntegrity(element: HtmlElement, asset: LoadedResource, url: string): void {
  verifySubresourceIntegrity({
    bytes: resourceBytes(asset),
    digests: asset.integrity,
    metadata: attribute(element, 'integrity'),
    url,
  });
}

function assertedMediaType(asset: LoadedResource): string {
  return (asset.declaredMediaType ?? asset.mediaType).split(';')[0]!.trim().toLowerCase();
}

function assertJavaScriptMediaType(asset: LoadedResource, url: string): void {
  const mediaType = assertedMediaType(asset);
  if (!JAVASCRIPT_MEDIA_TYPES.has(mediaType)) {
    throw new Error(`JavaScript resource ${url} has an invalid MIME type: ${mediaType}`);
  }
}

function assertStylesheetMediaType(asset: LoadedResource, url: string): void {
  const mediaType = assertedMediaType(asset);
  if (mediaType !== 'text/css') {
    throw new Error(`Stylesheet ${url} has an invalid MIME type: ${mediaType}`);
  }
}

function scriptType(element: HtmlElement): string {
  return (attribute(element, 'type') ?? '').trim().toLowerCase().split(';', 1)[0]!;
}

function isClassicJavaScript(element: HtmlElement): boolean {
  const type = scriptType(element);
  return type === '' || JAVASCRIPT_MEDIA_TYPES.has(type);
}

function assetToDataUrl(
  asset: LoadedResource,
  referenceUrl = asset.url,
  reserveMaterializedBytes?: MaterializedBytesReservation
): string {
  let fragment = '';
  try {
    fragment = new URL(referenceUrl).hash;
  } catch {
    // Loaded network resources are absolute URLs, but retaining an empty
    // fragment is safer than failing serialization for a custom loader.
  }
  const prefix = `data:${asset.mediaType};base64,`;
  const content = resourceContent(asset);
  reserveMaterializedBytes?.(prefix.length + content.length + fragment.length, referenceUrl);
  return `${prefix}${content}${fragment}`;
}

function mediaTypeForUrl(url: string): string {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.unityweb')) return 'application/octet-stream';
  const path = pathname.replace(/\.(?:br|gz)$/, '');
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript';
  if (path.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

function isIdentifier(node: AcornNode | undefined, name: string): boolean {
  const candidate = node as JavaScriptNode | undefined;
  return candidate?.type === 'Identifier' && 'name' in candidate && candidate.name === name;
}

function staticPropertyName(node: AcornNode | undefined): string | undefined {
  const candidate = node as JavaScriptNode | undefined;
  if (candidate?.type === 'Identifier') return candidate.name;
  return candidate?.type === 'Literal' && typeof candidate.value === 'string'
    ? candidate.value
    : undefined;
}

function urlBearingTargetName(node: AcornNode | undefined): string | undefined {
  const candidate = node as JavaScriptNode | undefined;
  if (candidate?.type === 'Identifier') return candidate.name;
  if (candidate?.type === 'MemberExpression' && !candidate.computed) {
    return staticPropertyName(candidate.property);
  }
  if (candidate?.type === 'MemberExpression' && candidate.computed) {
    return staticPropertyName(candidate.property);
  }
  return undefined;
}

function isImportMetaUrl(node: AcornNode | undefined): boolean {
  const candidate = node as JavaScriptNode | undefined;
  const object = candidate?.object as JavaScriptNode | undefined;
  return (
    candidate?.type === 'MemberExpression' &&
    object?.type === 'MetaProperty' &&
    isIdentifier(object.meta, 'import') &&
    isIdentifier(object.property, 'meta') &&
    staticPropertyName(candidate.property) === 'url'
  );
}

type StaticValue = number | string;

function immutableInitializer(
  rawNode: AcornNode | undefined,
  identifierVariables: Map<AcornNode, Variable>
): AcornNode | undefined {
  const node = rawNode as JavaScriptNode | undefined;
  if (node?.type !== 'Identifier') return undefined;
  const variable = identifierVariables.get(node);
  if (!variable || variable.defs.length !== 1) return undefined;
  const definition = variable.defs[0];
  if (
    definition?.type !== 'Variable' ||
    !definition.node.init ||
    (definition.node.init as unknown as AcornNode).end > node.start ||
    variable.references.some((reference) => reference.isWrite() && reference.init !== true)
  ) {
    return undefined;
  }
  return definition.node.init as unknown as AcornNode;
}

function constantValue(
  rawNode: AcornNode | undefined,
  identifierVariables: Map<AcornNode, Variable>,
  resolving = new Set<Variable>()
): StaticValue | undefined {
  const node = rawNode as JavaScriptNode | undefined;
  if (!node) return undefined;
  if (node.type === 'Literal') {
    return typeof node.value === 'string' || typeof node.value === 'number'
      ? node.value
      : undefined;
  }
  if (node.type === 'Identifier') {
    const variable = identifierVariables.get(node);
    if (!variable || resolving.has(variable) || variable.defs.length !== 1) return undefined;
    const initializer = immutableInitializer(node, identifierVariables);
    if (!initializer) return undefined;
    const nextResolving = new Set(resolving);
    nextResolving.add(variable);
    return constantValue(initializer, identifierVariables, nextResolving);
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = constantValue(node.left, identifierVariables, resolving);
    const right = constantValue(node.right, identifierVariables, resolving);
    if (left === undefined || right === undefined) return undefined;
    return typeof left === 'number' && typeof right === 'number'
      ? left + right
      : String(left) + String(right);
  }
  if (node.type === 'TemplateLiteral' && node.quasis && node.expressions) {
    let output = '';
    for (let index = 0; index < node.quasis.length; index += 1) {
      output += node.quasis[index]?.value?.cooked ?? '';
      const expression = node.expressions[index];
      if (!expression) continue;
      const value = constantValue(expression, identifierVariables, resolving);
      if (value === undefined) return undefined;
      output += String(value);
    }
    return output;
  }
  return undefined;
}

function isUrlBearingValue(node: JavaScriptNode, parent: JavaScriptNode | undefined): boolean {
  if (!parent) return false;
  if (parent.type === 'Property' && parent.value === node) {
    const name = staticPropertyName(parent.key);
    return name !== undefined && WEBGL_CONFIG_RESOURCE_NAMES.has(name.toLowerCase());
  }
  if (parent.type === 'AssignmentExpression' && parent.right === node) {
    if ((parent.left as JavaScriptNode | undefined)?.type !== 'MemberExpression') return false;
    const name = urlBearingTargetName(parent.left);
    return (
      name !== undefined &&
      (DIRECT_RESOURCE_SINK_NAMES.has(name.toLowerCase()) ||
        WEBGL_CONFIG_RESOURCE_NAMES.has(name.toLowerCase()))
    );
  }
  return false;
}

function isWebGlDynamicScriptValue(
  node: JavaScriptNode,
  parent: JavaScriptNode | undefined
): boolean {
  if (!parent) return false;
  if (parent.type === 'Property' && parent.value === node) {
    const name = staticPropertyName(parent.key);
    return name !== undefined && WEBGL_DYNAMIC_SCRIPT_RESOURCE_NAMES.has(name.toLowerCase());
  }
  if (parent.type === 'AssignmentExpression' && parent.right === node) {
    if ((parent.left as JavaScriptNode | undefined)?.type !== 'MemberExpression') return false;
    const name = urlBearingTargetName(parent.left);
    return name !== undefined && WEBGL_DYNAMIC_SCRIPT_RESOURCE_NAMES.has(name.toLowerCase());
  }
  return false;
}

function scriptSourceAssignment(
  node: JavaScriptNode,
  parent: JavaScriptNode | undefined,
  identifierVariables: Map<AcornNode, Variable>,
  parents: Map<AcornNode, AcornNode>
):
  | {
      insertionOperands?: JavaScriptNode[];
      stableTarget?: JavaScriptNode;
    }
  | {
      preserveNetwork: true;
    }
  | undefined {
  if (
    parent?.type !== 'AssignmentExpression' ||
    parent.right !== node ||
    urlBearingTargetName(parent.left) !== 'src'
  ) {
    return undefined;
  }
  const target = parent.left as JavaScriptNode | undefined;
  const object = target?.object as JavaScriptNode | undefined;
  const initializer =
    object?.type === 'Identifier'
      ? (immutableInitializer(object, identifierVariables) as JavaScriptNode | undefined)
      : object;
  const callee = initializer?.callee as JavaScriptNode | undefined;
  const isScriptElement =
    initializer?.type === 'CallExpression' &&
    callee?.type === 'MemberExpression' &&
    isIdentifier(callee.object, 'document') &&
    !identifierVariables.has(callee.object!) &&
    staticPropertyName(callee.property) === 'createElement' &&
    constantValue(initializer.arguments?.[0], identifierVariables)?.toString().toLowerCase() ===
      'script';
  if (!isScriptElement) return undefined;
  if (object?.type !== 'Identifier') return {};

  const variable = identifierVariables.get(object);
  if (!variable) return { preserveNetwork: true };
  const insertionOperands: JavaScriptNode[] = [];
  for (const [rawReference, referenceVariable] of identifierVariables) {
    if (referenceVariable !== variable) continue;
    const reference = rawReference as JavaScriptNode;
    const referenceParent = parents.get(reference) as JavaScriptNode | undefined;
    if (referenceParent?.type === 'VariableDeclarator' && referenceParent.id === reference) {
      continue;
    }
    if (referenceParent?.type === 'MemberExpression' && referenceParent.object === reference) {
      const grandparent = parents.get(referenceParent) as JavaScriptNode | undefined;
      if (
        staticPropertyName(referenceParent.property) === 'src' &&
        grandparent?.type === 'AssignmentExpression' &&
        grandparent.left === referenceParent &&
        grandparent !== parent
      ) {
        return { preserveNetwork: true };
      }
      continue;
    }
    if (referenceParent?.type !== 'CallExpression') return { preserveNetwork: true };
    const argumentIndex = referenceParent.arguments?.indexOf(reference) ?? -1;
    const callee = referenceParent.callee as JavaScriptNode | undefined;
    if (
      argumentIndex < 0 ||
      callee?.type !== 'MemberExpression' ||
      !(
        (['append', 'appendChild', 'prepend', 'before', 'after', 'replaceWith'].includes(
          staticPropertyName(callee.property) ?? ''
        ) &&
          argumentIndex >= 0) ||
        (['insertBefore', 'replaceChild'].includes(staticPropertyName(callee.property) ?? '') &&
          argumentIndex === 0) ||
        (staticPropertyName(callee.property) === 'insertAdjacentElement' && argumentIndex === 1)
      )
    ) {
      return { preserveNetwork: true };
    }
    if (referenceParent.start <= parent.end) return { preserveNetwork: true };
    insertionOperands.push(reference);
  }
  if (insertionOperands.length === 0) return { preserveNetwork: true };
  return {
    insertionOperands,
    stableTarget: object,
  };
}

function dynamicImportExpression(
  expression: string,
  referrerUrl: string,
  importMap: ResolvedImportMap | undefined
): string {
  const base = JSON.stringify(referrerUrl).replaceAll('<', '\\u003c');
  const applicableScopes = importMap
    ? [...importMap.scopes.keys()]
        .filter((candidate) => referrerUrl.startsWith(candidate))
        .sort((left, right) => right.length - left.length)
    : [];
  const maps = [
    ...applicableScopes.map((scope) => importMap!.scopes.get(scope)!),
    ...(importMap ? [importMap.imports] : []),
  ].map((mappings) => [...mappings]);
  const serializedMaps = JSON.stringify(maps).replaceAll('<', '\\u003c');
  return `((value) => {
    if (typeof value === 'symbol') {
      throw new globalThis.TypeError('Cannot convert a Symbol value to a string');
    }
    let specifier = globalThis.String(value);
    if (specifier.startsWith('/') ||
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      /^[A-Za-z][A-Za-z\\d+.-]*:/.test(specifier)) {
      specifier = new globalThis.URL(specifier, ${base}).href;
    }
    const maps = ${serializedMaps};
    for (const mappings of maps) {
      const exact = mappings.find(([key]) => key === specifier);
      let match = exact;
      if (!match) {
        match = mappings
          .filter(([key]) => key.endsWith('/') && specifier.startsWith(key))
          .sort(([left], [right]) => right.length - left.length)[0];
      }
      if (!match) continue;
      if (match[1] === null) {
        throw new globalThis.TypeError('Import map blocked ' + specifier);
      }
      if (match[0] === specifier) return match[1];
      const resolved = new globalThis.URL(
        specifier.slice(match[0].length),
        match[1]
      ).href;
      if (!resolved.startsWith(match[1])) {
        throw new globalThis.TypeError(
          'Import map blocked backtracking for ' + specifier
        );
      }
      return resolved;
    }
    return specifier;
  })(${expression})`;
}

function analyzeJavaScript(
  code: string,
  {
    canLoad = () => true,
    currentScriptUrl,
    environment = 'window',
    importMap,
    referrerUrl,
    runtimeBaseUrl,
    sourceType = 'module',
  }: {
    canLoad?: (url: string) => boolean;
    currentScriptUrl?: string;
    environment?: 'window' | 'worker';
    importMap?: ResolvedImportMap;
    referrerUrl: string;
    runtimeBaseUrl: string;
    sourceType?: 'module' | 'script';
  }
): {
  imports: string[];
  replacements: Replacement[];
} {
  const ast = parseJavaScript(code, {
    allowHashBang: true,
    ecmaVersion: 'latest',
    ranges: true,
    sourceType,
  });
  const replacements = new Map<number, Replacement>();
  const imports = new Set<string>();
  const parents = new Map<AcornNode, AcornNode>();
  walkJavaScriptAncestors(ast, (node, _state, ancestors) => {
    const parent = ancestors.at(-2);
    if (parent) parents.set(node, parent);
  });
  const addReplacement = (candidate: Replacement): void => {
    if (
      [...replacements.values()].some(
        (current) =>
          current.start <= candidate.start &&
          current.end >= candidate.end &&
          (current.start !== candidate.start || current.end !== candidate.end)
      )
    ) {
      return;
    }
    for (const [start, current] of replacements) {
      if (
        candidate.start <= current.start &&
        candidate.end >= current.end &&
        (candidate.start !== current.start || candidate.end !== current.end)
      ) {
        replacements.delete(start);
      }
    }
    replacements.set(candidate.start, candidate);
  };
  const scopeManager = analyzeScopes(ast as never, {
    ecmaVersion: 2022,
    sourceType,
  });
  const identifierVariables = new Map<AcornNode, Variable>();
  for (const scope of scopeManager.scopes) {
    for (const variable of scope.variables) {
      for (const reference of variable.references) {
        identifierVariables.set(reference.identifier as unknown as AcornNode, variable);
      }
    }
  }
  const isGlobalIdentifier = (node: AcornNode | undefined, name: string): boolean =>
    isIdentifier(node, name) && !identifierVariables.has(node!);
  const isGlobalCallable = (rawNode: AcornNode | undefined, name: string): boolean => {
    const node = rawNode as JavaScriptNode | undefined;
    if (isGlobalIdentifier(node, name)) return true;
    if (node?.type !== 'MemberExpression' || staticPropertyName(node.property) !== name) {
      return false;
    }
    const receivers =
      environment === 'worker' ? ['globalThis', 'self'] : ['globalThis', 'self', 'window'];
    return receivers.some((receiver) => isGlobalIdentifier(node.object, receiver));
  };
  const isWorkerLocation = (rawNode: AcornNode | undefined): boolean => {
    const node = rawNode as JavaScriptNode | undefined;
    if (isGlobalIdentifier(node, 'location')) return true;
    if (node?.type !== 'MemberExpression' || staticPropertyName(node.property) !== 'location') {
      return false;
    }
    return isGlobalIdentifier(node.object, 'self') || isGlobalIdentifier(node.object, 'globalThis');
  };
  const isWorkerLocationHref = (rawNode: AcornNode | undefined): boolean => {
    const node = rawNode as JavaScriptNode | undefined;
    return (
      environment === 'worker' &&
      node?.type === 'MemberExpression' &&
      staticPropertyName(node.property) === 'href' &&
      isWorkerLocation(node.object)
    );
  };
  const isDocumentCurrentScriptSource = (rawNode: AcornNode | undefined): boolean => {
    const node = rawNode as JavaScriptNode | undefined;
    const currentScript = node?.object as JavaScriptNode | undefined;
    return (
      currentScriptUrl !== undefined &&
      node?.type === 'MemberExpression' &&
      staticPropertyName(node.property) === 'src' &&
      currentScript?.type === 'MemberExpression' &&
      staticPropertyName(currentScript.property) === 'currentScript' &&
      isGlobalIdentifier(currentScript.object, 'document')
    );
  };
  const suppressedNewUrlOperands = new Set<number>();
  const resolvedNewUrl = (
    rawNode: AcornNode | undefined
  ): { operand: JavaScriptNode; url: string } | undefined => {
    const node = rawNode as JavaScriptNode | undefined;
    if (node?.type !== 'NewExpression' || !isGlobalCallable(node.callee, 'URL')) {
      return undefined;
    }
    const operand = node.arguments?.[0] as JavaScriptNode | undefined;
    if (!operand) return undefined;
    const value = constantValue(operand, identifierVariables);
    if (typeof value !== 'string') return undefined;
    const baseNode = node.arguments?.[1] as JavaScriptNode | undefined;
    try {
      if (!baseNode) return { operand, url: new URL(value).toString() };
      if (isImportMetaUrl(baseNode)) {
        return { operand, url: new URL(value, referrerUrl).toString() };
      }
      if (isWorkerLocationHref(baseNode)) {
        return { operand, url: new URL(value, runtimeBaseUrl).toString() };
      }
      const base = constantValue(baseNode, identifierVariables);
      return typeof base === 'string'
        ? { operand, url: new URL(value, base).toString() }
        : undefined;
    } catch {
      return undefined;
    }
  };
  const addResolvedReplacement = (
    operand: JavaScriptNode,
    url: string,
    kind: Replacement['kind'],
    expression?: string,
    eager?: boolean,
    scriptTarget?: string,
    deferred?: boolean,
    propertyName?: string
  ): void => {
    addReplacement({
      ...(deferred === undefined ? {} : { deferred }),
      ...(eager === undefined ? {} : { eager }),
      end: operand.end,
      expression,
      kind,
      ...(propertyName === undefined ? {} : { propertyName }),
      ...(scriptTarget === undefined ? {} : { scriptTarget }),
      start: operand.start,
      url,
    });
  };
  const addStaticUrlReplacement = (
    operand: JavaScriptNode | undefined,
    kind: Replacement['kind'],
    {
      baseUrl,
      preserveNetwork = false,
      propertyName,
      requireAssetExtension = false,
      scriptInsertionOperands,
      scriptTarget,
      valueOperand,
    }: {
      baseUrl: string;
      preserveNetwork?: boolean;
      propertyName?: string;
      requireAssetExtension?: boolean;
      scriptInsertionOperands?: JavaScriptNode[];
      scriptTarget?: string;
      valueOperand?: JavaScriptNode;
    }
  ): void => {
    if (!operand) return;
    const value = constantValue(valueOperand ?? operand, identifierVariables);
    if (typeof value !== 'string') return;
    let url: string;
    try {
      url = absoluteUrl(value, baseUrl);
    } catch {
      return;
    }
    const isAsset = !requireAssetExtension || ASSET_LITERAL_EXTENSION.test(value);
    if (isAsset && shouldLocalize(url, canLoad)) {
      const deferred = kind === 'classic-script' && Boolean(scriptInsertionOperands?.length);
      addResolvedReplacement(
        operand,
        url,
        kind,
        undefined,
        undefined,
        scriptTarget,
        deferred,
        propertyName
      );
      for (const insertionOperand of scriptInsertionOperands ?? []) {
        addResolvedReplacement(
          insertionOperand,
          url,
          'classic-script-insert',
          undefined,
          undefined,
          scriptTarget
        );
      }
    } else if (preserveNetwork && shouldLoad(url)) {
      addResolvedReplacement(operand, url, 'network');
    }
  };
  const isModuleWorker = (optionsNode: AcornNode | undefined): boolean => {
    const direct = optionsNode as JavaScriptNode | undefined;
    const options = (
      direct?.type === 'Identifier' ? immutableInitializer(direct, identifierVariables) : direct
    ) as JavaScriptNode | undefined;
    if (options?.type !== 'ObjectExpression') return false;
    for (const rawProperty of options.properties ?? []) {
      const property = rawProperty as JavaScriptNode;
      if (property.type !== 'Property' || staticPropertyName(property.key) !== 'type') continue;
      return (
        constantValue(property.value as AcornNode | undefined, identifierVariables) === 'module'
      );
    }
    return false;
  };
  const workerTarget = (
    rawArgument: AcornNode | undefined
  ): { operand: JavaScriptNode; sourceOperand?: JavaScriptNode; url: string } | undefined => {
    const argument = rawArgument as JavaScriptNode | undefined;
    if (!argument) return undefined;
    const directUrl = resolvedNewUrl(argument);
    if (directUrl) {
      return {
        operand: directUrl.operand,
        sourceOperand: directUrl.operand,
        url: directUrl.url,
      };
    }
    const initializer = immutableInitializer(argument, identifierVariables);
    const indirectUrl = resolvedNewUrl(initializer);
    if (indirectUrl) {
      return {
        operand: argument,
        sourceOperand: indirectUrl.operand,
        url: indirectUrl.url,
      };
    }
    const value = constantValue(argument, identifierVariables);
    if (typeof value !== 'string') return undefined;
    try {
      return {
        operand: argument,
        url: absoluteUrl(value, runtimeBaseUrl),
      };
    } catch {
      return undefined;
    }
  };
  const isGlobalConstructedInstance = (
    rawNode: AcornNode | undefined,
    constructorName: string,
    resolving = new Set<Variable>()
  ): boolean => {
    const node = rawNode as JavaScriptNode | undefined;
    if (node?.type === 'NewExpression' && isGlobalCallable(node.callee, constructorName)) {
      return true;
    }
    if (node?.type !== 'Identifier') return false;
    const variable = identifierVariables.get(node);
    if (!variable || resolving.has(variable)) return false;
    const initializer = immutableInitializer(node, identifierVariables);
    if (!initializer) return false;
    const nextResolving = new Set(resolving);
    nextResolving.add(variable);
    return isGlobalConstructedInstance(initializer, constructorName, nextResolving);
  };

  walkJavaScript(ast, (rawNode: AcornNode) => {
    const node = rawNode as JavaScriptNode;
    let importSource: JavaScriptNode | undefined;
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ImportExpression'
    ) {
      importSource = node.source as JavaScriptNode | undefined;
    }
    const imported = constantValue(importSource, identifierVariables);
    if (typeof imported === 'string') {
      const url = resolveModuleSpecifier(imported, referrerUrl, importMap);
      if (typeof url === 'string' && shouldLocalize(url, canLoad)) {
        imports.add(url);
        addResolvedReplacement(
          importSource!,
          url,
          'import',
          undefined,
          node.type !== 'ImportExpression'
        );
      } else if (typeof url === 'string') {
        addResolvedReplacement(importSource!, url, 'external-import');
      } else if (url === null) {
        throw new TypeError(`Import map blocked ${JSON.stringify(imported)} from ${referrerUrl}`);
      }
    } else if (node.type === 'ImportExpression' && importSource) {
      const sourceExpression = code.slice(importSource.start, importSource.end);
      const options = node.options as JavaScriptNode | undefined;
      const optionsExpression = options ? code.slice(options.start, options.end) : undefined;
      addResolvedReplacement(
        node,
        referrerUrl,
        'dynamic-import',
        `((${optionsExpression ? 'value, options' : 'value'}) => {
          try {
            return import(${dynamicImportExpression('value', referrerUrl, importMap)}${
              optionsExpression ? ', options' : ''
            });
          } catch (error) {
            return (async () => { throw error; })();
          }
        })(((${sourceExpression}))${optionsExpression ? `, ((${optionsExpression}))` : ''})`
      );
    }

    if (
      node.type === 'NewExpression' &&
      (isGlobalCallable(node.callee, 'Worker') || isGlobalCallable(node.callee, 'SharedWorker'))
    ) {
      const target = workerTarget(node.arguments?.[0]);
      if (target && shouldLocalize(target.url, canLoad)) {
        if (target.sourceOperand) {
          suppressedNewUrlOperands.add(target.sourceOperand.start);
          replacements.delete(target.sourceOperand.start);
        }
        addResolvedReplacement(
          target.operand,
          target.url,
          isModuleWorker(node.arguments?.[1]) ? 'worker' : 'classic-worker'
        );
      }
    }

    if (node.type === 'NewExpression' && isGlobalCallable(node.callee, 'URL')) {
      const resolved = resolvedNewUrl(node);
      const parent = parents.get(node) as JavaScriptNode | undefined;
      const isFetchArgument =
        parent?.type === 'CallExpression' &&
        isGlobalCallable(parent.callee, 'fetch') &&
        parent.arguments?.[0] === node;
      if (
        resolved &&
        !suppressedNewUrlOperands.has(resolved.operand.start) &&
        !replacements.has(resolved.operand.start) &&
        ASSET_LITERAL_EXTENSION.test(resolved.url) &&
        shouldLocalize(resolved.url, canLoad)
      ) {
        addResolvedReplacement(
          resolved.operand,
          resolved.url,
          isFetchArgument ? 'fetch-asset' : 'asset'
        );
      }
    }

    if (
      node.type === 'CallExpression' &&
      isGlobalCallable(node.callee, 'fetch') &&
      node.arguments?.[0]
    ) {
      addStaticUrlReplacement(node.arguments[0] as JavaScriptNode, 'fetch-asset', {
        baseUrl: runtimeBaseUrl,
        preserveNetwork: environment === 'worker',
        requireAssetExtension: true,
      });
    }

    const callTarget = node.callee as JavaScriptNode | undefined;
    if (
      node.type === 'CallExpression' &&
      callTarget?.type === 'MemberExpression' &&
      staticPropertyName(callTarget.property) === 'open' &&
      isGlobalConstructedInstance(callTarget.object, 'XMLHttpRequest') &&
      String(constantValue(node.arguments?.[0], identifierVariables)).toUpperCase() === 'GET'
    ) {
      addStaticUrlReplacement(node.arguments?.[1] as JavaScriptNode | undefined, 'fetch-asset', {
        baseUrl: runtimeBaseUrl,
        preserveNetwork: environment === 'worker',
        requireAssetExtension: true,
      });
    }

    if (
      sourceType === 'script' &&
      node.type === 'CallExpression' &&
      isGlobalCallable(node.callee, 'importScripts')
    ) {
      for (const argument of node.arguments ?? []) {
        addStaticUrlReplacement(argument as JavaScriptNode, 'classic-import', {
          baseUrl: runtimeBaseUrl,
          preserveNetwork: environment === 'worker',
        });
      }
    }

    if (isImportMetaUrl(node)) {
      const parent = parents.get(node) as JavaScriptNode | undefined;
      if (!(parent?.type === 'AssignmentExpression' && parent.left === node)) {
        addResolvedReplacement(node, referrerUrl, 'rebase');
      }
    }
    if (isWorkerLocationHref(node)) {
      const parent = parents.get(node) as JavaScriptNode | undefined;
      if (!(parent?.type === 'AssignmentExpression' && parent.left === node)) {
        addResolvedReplacement(node, runtimeBaseUrl, 'rebase');
      }
    }
    if (isDocumentCurrentScriptSource(node)) {
      const parent = parents.get(node) as JavaScriptNode | undefined;
      const writesValue =
        (parent?.type === 'AssignmentExpression' && parent.left === node) ||
        (parent?.type === 'UpdateExpression' && parent.argument === node) ||
        (parent?.type === 'UnaryExpression' &&
          parent.operator === 'delete' &&
          parent.argument === node);
      if (!writesValue) {
        const marker = JSON.stringify(ORIGINAL_SCRIPT_SOURCE_ATTRIBUTE);
        const read = `script.getAttribute(${marker}) || script.src`;
        addReplacement({
          end: node.end,
          expression: `((script) => ${
            node.optional ? `script == null ? undefined : ${read}` : read
          })(document.currentScript)`,
          kind: 'current-script',
          start: node.start,
          url: currentScriptUrl!,
        });
      }
    }

    if (
      isUrlBearingValue(node, parents.get(node) as JavaScriptNode | undefined) &&
      !replacements.has(node.start) &&
      ![...replacements.values()].some(
        (replacement) => replacement.start <= node.start && replacement.end >= node.end
      )
    ) {
      const parent = parents.get(node) as JavaScriptNode | undefined;
      const value = constantValue(node, identifierVariables);
      const shorthandProperty =
        parent?.type === 'Property' && parent.shorthand && parent.value === node
          ? parent
          : undefined;
      const scriptAssignment =
        environment === 'window' &&
        typeof value === 'string' &&
        EXECUTABLE_JAVASCRIPT_URL.test(value)
          ? scriptSourceAssignment(node, parent, identifierVariables, parents)
          : undefined;
      const webGlDynamicScript =
        environment === 'window' &&
        typeof value === 'string' &&
        EXECUTABLE_JAVASCRIPT_URL.test(value) &&
        isWebGlDynamicScriptValue(node, parent);
      if (scriptAssignment && 'preserveNetwork' in scriptAssignment) return;
      addStaticUrlReplacement(
        shorthandProperty ?? node,
        scriptAssignment || webGlDynamicScript ? 'classic-script' : 'asset',
        {
          baseUrl: runtimeBaseUrl,
          preserveNetwork: environment === 'worker',
          ...(shorthandProperty
            ? {
                propertyName: staticPropertyName(shorthandProperty.key),
                valueOperand: node,
              }
            : {}),
          requireAssetExtension: true,
          ...(scriptAssignment?.stableTarget
            ? {
                scriptTarget: code.slice(
                  scriptAssignment.stableTarget.start,
                  scriptAssignment.stableTarget.end
                ),
              }
            : {}),
          ...('insertionOperands' in (scriptAssignment ?? {})
            ? { scriptInsertionOperands: scriptAssignment?.insertionOperands }
            : {}),
        }
      );
    }
  });

  return { imports: [...imports], replacements: [...replacements.values()] };
}

export function isStreamedRuntimeAsset(url: string): boolean {
  return STREAMED_RUNTIME_ASSET.test(new URL(url).pathname);
}

function rewriteJavaScript(
  record: ModuleRecord,
  resolve: (replacement: Replacement) => ReplacementValue
): string {
  const output = new MagicString(record.code);
  for (const replacement of [...record.replacements].sort(
    (left, right) => right.start - left.start
  )) {
    const resolved = resolve(replacement);
    output.overwrite(
      replacement.start,
      replacement.end,
      typeof resolved === 'string' ? JSON.stringify(resolved) : resolved.expression
    );
  }
  return output.toString();
}

async function bundleCyclicWorkerModules(
  entryUrl: string,
  sources: ReadonlyMap<string, string>
): Promise<string> {
  const { rollup } = await import('rollup/dist/es/rollup.browser.js');
  const bundle = await rollup({
    input: entryUrl,
    onwarn: () => {
      // Circular dependencies are the reason this fallback exists. Other
      // Rollup diagnostics do not change the generated module's semantics and
      // should not leak into an application's console during cache refresh.
    },
    plugins: [
      {
        load(id) {
          return sources.get(id) ?? null;
        },
        name: 'react-native-local-webview-worker-graph',
        resolveId(source) {
          return sources.has(source) ? source : { external: true, id: source };
        },
      },
    ],
    preserveEntrySignatures: 'strict',
    treeshake: false,
  });
  try {
    const generated = await bundle.generate({
      format: 'es',
      inlineDynamicImports: true,
    });
    const chunks = generated.output.filter((item) => item.type === 'chunk');
    if (chunks.length !== 1 || generated.output.length !== 1) {
      throw new Error(`Cyclic module Worker bundle produced ${generated.output.length} outputs`);
    }
    return chunks[0]!.code;
  } finally {
    await bundle.close();
  }
}

function importUrlFromAtrule(node: Atrule): StringNode | Url | undefined {
  if (node.name.toLowerCase() !== 'import' || node.prelude?.type !== 'AtrulePrelude') {
    return undefined;
  }
  const first = node.prelude.children.first;
  return first?.type === 'String' || first?.type === 'Url' ? first : undefined;
}

async function localizeCss(
  css: string,
  stylesheetUrl: string,
  load: ResourceLoader,
  loaded: Map<string, LoadedResource>,
  stack: Set<string>,
  canLoad: (url: string) => boolean,
  reserveMaterializedBytes?: MaterializedBytesReservation
): Promise<string> {
  const ast = parseCss(css);
  const references: Array<{
    imported: boolean;
    node: StringNode | Url;
    url: string;
  }> = [];
  const importNodes = new Set<StringNode | Url>();

  walkCss(ast, {
    visit: 'Atrule',
    enter(node) {
      const imported = importUrlFromAtrule(node);
      if (imported) importNodes.add(imported);
    },
  });
  walkCss(ast, (node: CssNode) => {
    if (node.type !== 'Url' && node.type !== 'String') return;
    if (node.type === 'String' && !importNodes.has(node)) return;
    const url = absoluteUrl(node.value, stylesheetUrl);
    if (shouldLocalize(url, canLoad)) {
      references.push({
        imported: importNodes.has(node),
        node,
        url,
      });
    }
  });

  for (const reference of references) {
    if (reference.imported && stack.has(reference.url)) {
      reference.node.value = dataUrl('text/css', '', reserveMaterializedBytes, reference.url);
      continue;
    }
    const asset = await load(reference.url, { delivery: 'inline' });
    loaded.set(reference.url, asset);
    if (reference.imported) {
      assertStylesheetMediaType(asset, reference.url);
      const nextStack = new Set(stack);
      nextStack.add(reference.url);
      if (asset.responseUrl) nextStack.add(asset.responseUrl);
      const importedCss = await localizeCss(
        bytesToUtf8(base64ToBytes(resourceContent(asset))),
        asset.responseUrl ?? reference.url,
        load,
        loaded,
        nextStack,
        canLoad,
        reserveMaterializedBytes
      );
      reference.node.value = dataUrl(
        'text/css',
        importedCss,
        reserveMaterializedBytes,
        reference.url
      );
    } else {
      reference.node.value = assetToDataUrl(asset, reference.url, reserveMaterializedBytes);
    }
  }
  return generateCss(ast);
}

function findDocumentBase(document: HtmlNode, entryUrl: string): string {
  let baseUrl = entryUrl;
  let found = false;
  walkActiveHtml(document, (element) => {
    if (!found && element.tagName === 'base') {
      const href = attribute(element, 'href');
      if (href) {
        baseUrl = absoluteUrl(href, entryUrl);
        found = true;
      }
    }
  });
  return baseUrl;
}

function findHead(document: HtmlNode): HtmlElement | undefined {
  let head: HtmlElement | undefined;
  walkHtml(document, (element) => {
    if (!head && element.tagName === 'head') head = element;
  });
  return head;
}

function prependToHead(document: HtmlNode, element: HtmlElement): void {
  const head = findHead(document);
  if (!head) throw new Error('HTML document does not contain a <head>');
  element.parentNode = head;
  head.childNodes.unshift(element);
}

function isStylesheet(element: HtmlElement): boolean {
  return (
    element.tagName === 'link' &&
    (attribute(element, 'rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet')
  );
}

function isModulePreload(element: HtmlElement): boolean {
  const relations = (attribute(element, 'rel') ?? '').toLowerCase().split(/\s+/);
  return element.tagName === 'link' && relations.includes('modulepreload');
}

function shouldInlineLink(element: HtmlElement): boolean {
  if (element.tagName !== 'link') return false;
  const relations = (attribute(element, 'rel') ?? '').toLowerCase().split(/\s+/);
  return relations.some((relation) => ['icon', 'manifest', 'preload'].includes(relation));
}

function enforceContentSecurityPolicy(document: HtmlNode, allowBypass: boolean): void {
  const policies: HtmlElement[] = [];
  walkActiveHtml(document, (element) => {
    if (isEffectiveMetaContentSecurityPolicy(element)) policies.push(element);
  });
  if (policies.length === 0) return;
  if (!allowBypass) {
    throw new ContentSecurityPolicyError(
      'The entry HTML contains a Content-Security-Policy meta tag. Set allowContentSecurityPolicyBypass to true only when removing that policy is intentional.'
    );
  }
  for (const policy of policies) removeElement(policy);
}

export function prepareWebDocumentHtml(
  html: string,
  allowContentSecurityPolicyBypass = false
): string {
  const document = parseHtml(html);
  enforceContentSecurityPolicy(document, allowContentSecurityPolicyBypass);
  return serialize(document);
}

export async function localizeWebDocument({
  allowContentSecurityPolicyBypass = false,
  canLoad,
  entryUrl,
  html,
  load,
  reserveMaterializedBytes,
}: {
  allowContentSecurityPolicyBypass?: boolean;
  canLoad?: (url: string) => boolean;
  entryUrl: string;
  html: string;
  load: ResourceLoader;
  reserveMaterializedBytes?: MaterializedBytesReservation;
}): Promise<LocalizedDocument> {
  const document = parseHtml(html);
  enforceContentSecurityPolicy(document, allowContentSecurityPolicyBypass);
  const documentBase = findDocumentBase(document, entryUrl);
  const existingImportMap = collectImportMap(document, documentBase);
  const entryOrigin = new URL(entryUrl).origin;
  const canLocalize = canLoad ?? ((url: string) => new URL(url).origin === entryOrigin);
  const loaded = new Map<string, LoadedResource>();
  const inlineJavaScriptAssetUrls = new Set<string>();
  const elements: HtmlElement[] = [];
  walkHtml(document, (element) => elements.push(element));
  const inlineScripts = elements.filter(
    (element) =>
      element.tagName === 'script' &&
      !attribute(element, 'src') &&
      (scriptType(element) === 'module' || isClassicJavaScript(element))
  );

  const moduleEntries: Array<{ element: HtmlElement; url: string }> = [];
  const dynamicScriptRecords = new Map<string, ModuleRecord>();
  const dynamicScriptQueue: string[] = [];
  const classicWorkerRecords = new Map<string, ModuleRecord>();
  const classicWorkerQueue: Array<{ context: WorkerContext; url: string }> = [];
  const moduleRecords = new Map<string, ModuleRecord>();
  const moduleQueue: string[] = [];
  const workerModuleRecords = new Map<string, ModuleRecord>();
  const workerModuleQueue: Array<{ context: WorkerContext; url: string }> = [];
  const scriptRecords: Array<{
    analysis: ReturnType<typeof analyzeJavaScript>;
    code: string;
    element: HtmlElement;
    external: boolean;
    originalSourceUrl?: string;
  }> = [];

  const enqueueModule = (url: string) => {
    if (!moduleRecords.has(url) && !moduleQueue.includes(url)) moduleQueue.push(url);
  };
  const workerKey = (url: string, context: WorkerContext): string =>
    `${context.rootKey}\u0000${url}`;
  const enqueueWorkerModule = (url: string, context: WorkerContext) => {
    const key = workerKey(url, context);
    if (
      !workerModuleRecords.has(key) &&
      !workerModuleQueue.some((queued) => workerKey(queued.url, queued.context) === key)
    ) {
      workerModuleQueue.push({ context, url });
    }
  };
  const enqueueClassicWorker = (url: string, context: WorkerContext) => {
    const key = workerKey(url, context);
    if (
      !classicWorkerRecords.has(key) &&
      !classicWorkerQueue.some((queued) => workerKey(queued.url, queued.context) === key)
    ) {
      classicWorkerQueue.push({ context, url });
    }
  };
  const enqueueDynamicScript = (url: string): void => {
    if (!dynamicScriptRecords.has(url) && !dynamicScriptQueue.includes(url)) {
      dynamicScriptQueue.push(url);
    }
  };
  const enqueueWindowDependencies = (analysis: ReturnType<typeof analyzeJavaScript>): void => {
    for (const imported of analysis.imports) enqueueModule(imported);
    for (const replacement of analysis.replacements) {
      if (replacement.kind === 'worker') {
        enqueueWorkerModule(replacement.url, {
          rootKey: replacement.url,
          runtimeBaseUrl: replacement.url,
        });
      } else if (replacement.kind === 'classic-worker') {
        enqueueClassicWorker(replacement.url, {
          rootKey: replacement.url,
          runtimeBaseUrl: replacement.url,
        });
      } else if (replacement.kind === 'classic-script') {
        enqueueDynamicScript(replacement.url);
      }
    }
  };
  const enqueueWorkerDependencies = (
    analysis: ReturnType<typeof analyzeJavaScript>,
    context: WorkerContext
  ): void => {
    for (const imported of analysis.imports) enqueueWorkerModule(imported, context);
    for (const replacement of analysis.replacements) {
      if (replacement.kind === 'worker') {
        enqueueWorkerModule(replacement.url, {
          rootKey: replacement.url,
          runtimeBaseUrl: replacement.url,
        });
      } else if (replacement.kind === 'classic-worker') {
        enqueueClassicWorker(replacement.url, {
          rootKey: replacement.url,
          runtimeBaseUrl: replacement.url,
        });
      } else if (replacement.kind === 'classic-import') {
        enqueueClassicWorker(replacement.url, context);
      }
    }
  };

  const recordScript = (
    element: HtmlElement,
    code: string,
    baseUrl: string,
    sourceType: 'module' | 'script',
    external = false,
    originalSourceUrl?: string
  ): void => {
    if (!code.trim()) return;
    try {
      const analysis = analyzeJavaScript(code, {
        canLoad: canLocalize,
        ...(originalSourceUrl ? { currentScriptUrl: originalSourceUrl } : {}),
        importMap: existingImportMap,
        referrerUrl: baseUrl,
        runtimeBaseUrl: documentBase,
        sourceType,
      });
      scriptRecords.push({
        analysis,
        code,
        element,
        external,
        originalSourceUrl,
      });
      enqueueWindowDependencies(analysis);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Non-JavaScript script types and syntax unsupported by Acorn stay untouched.
    }
  };

  for (const element of elements) {
    if (element.tagName !== 'script') continue;
    const source = attribute(element, 'src');
    if (!source) continue;
    const url = absoluteUrl(source, documentBase);
    if (!shouldLocalize(url, canLocalize)) continue;
    const type = scriptType(element);
    if (type === 'module') {
      moduleEntries.push({ element, url });
      enqueueModule(url);
    } else if (isClassicJavaScript(element)) {
      const asset = await load(url, {
        delivery: 'inline',
        integrity: attribute(element, 'integrity'),
      });
      loaded.set(url, asset);
      assertJavaScriptMediaType(asset, url);
      verifyElementIntegrity(element, asset, url);
      const code = bytesToUtf8(base64ToBytes(resourceContent(asset)));
      setAttribute(element, 'src', assetToDataUrl(asset, url, reserveMaterializedBytes));
      removeAttribute(element, 'integrity');
      recordScript(element, code, asset.responseUrl ?? url, 'script', true, url);
    }
  }
  for (const element of inlineScripts) {
    recordScript(
      element,
      textContent(element),
      documentBase,
      scriptType(element) === 'module' ? 'module' : 'script'
    );
  }

  const loadAnalyzedAssets = async (
    analysis: ReturnType<typeof analyzeJavaScript>
  ): Promise<void> => {
    for (const replacement of analysis.replacements) {
      if (replacement.kind !== 'asset' && replacement.kind !== 'fetch-asset') continue;
      const delivery =
        replacement.kind === 'fetch-asset' || isStreamedRuntimeAsset(replacement.url)
          ? 'file'
          : 'inline';
      if (delivery === 'inline') inlineJavaScriptAssetUrls.add(replacement.url);
      const dependency = await load(replacement.url, {
        delivery,
      });
      const existing = loaded.get(replacement.url);
      loaded.set(
        replacement.url,
        existing
          ? {
              ...existing,
              ...dependency,
              ...(existing.content === undefined ? {} : { content: existing.content }),
              delivery:
                existing.delivery === 'file' || dependency.delivery === 'file'
                  ? 'file'
                  : (dependency.delivery ?? existing.delivery),
              ...(existing.localPath === undefined ? {} : { localPath: existing.localPath }),
            }
          : dependency
      );
    }
  };
  const enforceWorkerResponseContentSecurityPolicy = (
    asset: LoadedResource,
    url: string,
    root: boolean
  ): void => {
    if (
      !root ||
      (!asset.contentSecurityPolicy?.trim() && !asset.contentSecurityPolicyReportOnly?.trim())
    ) {
      return;
    }
    if (!allowContentSecurityPolicyBypass) {
      throw new ContentSecurityPolicyError(
        `Worker response ${url} has a Content-Security-Policy or Content-Security-Policy-Report-Only header. Set allowContentSecurityPolicyBypass to true only when discarding that policy is intentional.`
      );
    }
  };

  let classicWorkerIndex = 0;
  let dynamicScriptIndex = 0;
  let moduleIndex = 0;
  let workerModuleIndex = 0;
  while (
    moduleIndex < moduleQueue.length ||
    workerModuleIndex < workerModuleQueue.length ||
    classicWorkerIndex < classicWorkerQueue.length ||
    dynamicScriptIndex < dynamicScriptQueue.length
  ) {
    const moduleUrl = moduleQueue[moduleIndex];
    if (moduleUrl) {
      moduleIndex += 1;
      if (moduleRecords.has(moduleUrl)) continue;
      const moduleEntry = moduleEntries.find((entry) => entry.url === moduleUrl);
      const importMapIntegrity = existingImportMap.integrity.get(moduleUrl);
      const asset = await load(moduleUrl, {
        delivery: 'inline',
        integrity:
          (moduleEntry ? attribute(moduleEntry.element, 'integrity') : undefined) ??
          importMapIntegrity,
      });
      loaded.set(moduleUrl, asset);
      assertJavaScriptMediaType(asset, moduleUrl);
      const entries = moduleEntries.filter((entry) => entry.url === moduleUrl);
      if (entries.length === 0) {
        verifySubresourceIntegrity({
          bytes: resourceBytes(asset),
          digests: asset.integrity,
          metadata: importMapIntegrity,
          url: moduleUrl,
        });
      } else {
        for (const entry of entries) {
          verifySubresourceIntegrity({
            bytes: resourceBytes(asset),
            digests: asset.integrity,
            metadata: attribute(entry.element, 'integrity') ?? importMapIntegrity,
            url: moduleUrl,
          });
        }
      }
      const code = bytesToUtf8(base64ToBytes(resourceContent(asset)));
      const analysis = analyzeJavaScript(code, {
        canLoad: canLocalize,
        importMap: existingImportMap,
        referrerUrl: asset.responseUrl ?? moduleUrl,
        runtimeBaseUrl: documentBase,
      });
      moduleRecords.set(moduleUrl, {
        code,
        replacements: analysis.replacements,
        runtimeBaseUrl: documentBase,
        url: asset.responseUrl ?? moduleUrl,
      });
      enqueueWindowDependencies(analysis);
      await loadAnalyzedAssets(analysis);
      continue;
    }

    const workerModule = workerModuleQueue[workerModuleIndex];
    if (workerModule) {
      workerModuleIndex += 1;
      const key = workerKey(workerModule.url, workerModule.context);
      if (workerModuleRecords.has(key)) continue;
      const asset = await load(workerModule.url, { delivery: 'inline' });
      loaded.set(workerModule.url, asset);
      assertJavaScriptMediaType(asset, workerModule.url);
      enforceWorkerResponseContentSecurityPolicy(
        asset,
        workerModule.url,
        workerModule.url === workerModule.context.rootKey
      );
      const context =
        workerModule.url === workerModule.context.rootKey
          ? {
              ...workerModule.context,
              runtimeBaseUrl: asset.responseUrl ?? workerModule.url,
            }
          : workerModule.context;
      const code = bytesToUtf8(base64ToBytes(resourceContent(asset)));
      const analysis = analyzeJavaScript(code, {
        canLoad: canLocalize,
        environment: 'worker',
        referrerUrl: asset.responseUrl ?? workerModule.url,
        runtimeBaseUrl: context.runtimeBaseUrl,
      });
      workerModuleRecords.set(key, {
        code,
        replacements: analysis.replacements,
        runtimeBaseUrl: context.runtimeBaseUrl,
        url: asset.responseUrl ?? workerModule.url,
      });
      enqueueWorkerDependencies(analysis, context);
      await loadAnalyzedAssets(analysis);
      continue;
    }

    const classicWorker = classicWorkerQueue[classicWorkerIndex];
    if (classicWorker) {
      classicWorkerIndex += 1;
      const key = workerKey(classicWorker.url, classicWorker.context);
      if (classicWorkerRecords.has(key)) continue;
      const asset = await load(classicWorker.url, { delivery: 'inline' });
      loaded.set(classicWorker.url, asset);
      assertJavaScriptMediaType(asset, classicWorker.url);
      enforceWorkerResponseContentSecurityPolicy(
        asset,
        classicWorker.url,
        classicWorker.url === classicWorker.context.rootKey
      );
      const context =
        classicWorker.url === classicWorker.context.rootKey
          ? {
              ...classicWorker.context,
              runtimeBaseUrl: asset.responseUrl ?? classicWorker.url,
            }
          : classicWorker.context;
      const code = bytesToUtf8(base64ToBytes(resourceContent(asset)));
      const analysis = analyzeJavaScript(code, {
        canLoad: canLocalize,
        environment: 'worker',
        referrerUrl: asset.responseUrl ?? classicWorker.url,
        runtimeBaseUrl: context.runtimeBaseUrl,
        sourceType: 'script',
      });
      classicWorkerRecords.set(key, {
        code,
        replacements: analysis.replacements,
        runtimeBaseUrl: context.runtimeBaseUrl,
        url: asset.responseUrl ?? classicWorker.url,
      });
      enqueueWorkerDependencies(analysis, context);
      await loadAnalyzedAssets(analysis);
      continue;
    }

    const dynamicScriptUrl = dynamicScriptQueue[dynamicScriptIndex++];
    if (!dynamicScriptUrl || dynamicScriptRecords.has(dynamicScriptUrl)) continue;
    const asset = await load(dynamicScriptUrl, { delivery: 'inline' });
    loaded.set(dynamicScriptUrl, asset);
    assertJavaScriptMediaType(asset, dynamicScriptUrl);
    const code = bytesToUtf8(base64ToBytes(resourceContent(asset)));
    const analysis = analyzeJavaScript(code, {
      canLoad: canLocalize,
      currentScriptUrl: dynamicScriptUrl,
      importMap: existingImportMap,
      referrerUrl: asset.responseUrl ?? dynamicScriptUrl,
      runtimeBaseUrl: documentBase,
      sourceType: 'script',
    });
    dynamicScriptRecords.set(dynamicScriptUrl, {
      code,
      replacements: analysis.replacements,
      runtimeBaseUrl: documentBase,
      url: asset.responseUrl ?? dynamicScriptUrl,
    });
    enqueueWindowDependencies(analysis);
    await loadAnalyzedAssets(analysis);
  }

  const workerLocalAssetUrls = [
    ...new Set(
      [...loaded.entries()]
        .flatMap(([requestUrl, asset]) => {
          if (asset.delivery !== 'file') return [];
          return [requestUrl, asset.url];
        })
        .map((value) => {
          const url = new URL(value);
          Reflect.set(url, 'hash', '');
          return url.toString();
        })
    ),
  ];
  const workerBootstrap = (baseUrl: string): string =>
    createWorkerRuntimeBootstrap(baseUrl, workerLocalAssetUrls);
  const moduleWorkerNodeId = (url: string, context: WorkerContext): string =>
    `module\u0000${workerKey(url, context)}`;
  const classicWorkerNodeId = (url: string, context: WorkerContext): string =>
    `classic\u0000${workerKey(url, context)}`;
  const workerUrlExpression = (
    url: string,
    context: WorkerContext,
    format: 'classic' | 'module'
  ): ReplacementValue => ({
    expression: `globalThis[${JSON.stringify(WORKER_MATERIALIZER_NAME)}](${JSON.stringify(
      format === 'module' ? moduleWorkerNodeId(url, context) : classicWorkerNodeId(url, context)
    )})`,
  });
  const directReplacement = (replacement: Replacement): ReplacementValue | undefined => {
    if (replacement.kind === 'current-script' || replacement.kind === 'dynamic-import') {
      return { expression: replacement.expression! };
    }
    if (
      replacement.kind === 'external-import' ||
      replacement.kind === 'fetch-asset' ||
      replacement.kind === 'network' ||
      replacement.kind === 'rebase'
    ) {
      return replacement.url;
    }
    return undefined;
  };
  const assetReplacement = (replacement: Replacement, label: string): ReplacementValue => {
    const asset = loaded.get(replacement.url);
    if (!asset) throw new Error(`${label} asset was not loaded: ${replacement.url}`);
    const value = inlineJavaScriptAssetUrls.has(replacement.url)
      ? assetToDataUrl(asset, replacement.url, reserveMaterializedBytes)
      : replacement.url;
    return replacement.propertyName
      ? {
          expression: `${JSON.stringify(replacement.propertyName)}: ${JSON.stringify(value)}`,
        }
      : value;
  };
  const workerCatalogNodes = new Map<string, WorkerCatalogNode>();
  let workerLinkIndex = 0;
  const linkedWorkerSpecifier = (links: Record<string, string>, targetId: string): string => {
    const token = `__RN_LOCAL_WEBVIEW_WORKER_LINK_${workerLinkIndex++}_${sha256Text(targetId).slice(
      0,
      12
    )}__`;
    links[token] = targetId;
    return token;
  };
  const contextFromWorkerKey = (
    key: string,
    record: ModuleRecord
  ): { context: WorkerContext; requestUrl: string } => {
    const separator = key.indexOf('\u0000');
    const rootKey = key.slice(0, separator);
    return {
      context: {
        rootKey,
        runtimeBaseUrl: record.runtimeBaseUrl,
      },
      requestUrl: key.slice(separator + 1),
    };
  };

  for (const [key, record] of workerModuleRecords) {
    const { context, requestUrl } = contextFromWorkerKey(key, record);
    const links: Record<string, string> = {};
    const code = rewriteJavaScript(record, (replacement) => {
      const direct = directReplacement(replacement);
      if (direct) return direct;
      if (replacement.kind === 'import') {
        const targetId = moduleWorkerNodeId(replacement.url, context);
        if (replacement.eager === false) {
          return workerUrlExpression(replacement.url, context, 'module');
        }
        return linkedWorkerSpecifier(links, targetId);
      }
      if (replacement.kind === 'worker') {
        const nested = {
          rootKey: replacement.url,
          runtimeBaseUrl: replacement.url,
        };
        return workerUrlExpression(replacement.url, nested, 'module');
      }
      if (replacement.kind === 'classic-worker') {
        const nested = {
          rootKey: replacement.url,
          runtimeBaseUrl: replacement.url,
        };
        return workerUrlExpression(replacement.url, nested, 'classic');
      }
      if (replacement.kind === 'classic-import') {
        return linkedWorkerSpecifier(links, classicWorkerNodeId(replacement.url, context));
      }
      return assetReplacement(replacement, 'Worker');
    });
    workerCatalogNodes.set(moduleWorkerNodeId(requestUrl, context), {
      ...(requestUrl === context.rootKey
        ? { bootstrap: workerBootstrap(record.runtimeBaseUrl) }
        : {}),
      code,
      format: 'module',
      links,
    });
  }

  for (const [key, record] of classicWorkerRecords) {
    const { context, requestUrl } = contextFromWorkerKey(key, record);
    const links: Record<string, string> = {};
    const code = rewriteJavaScript(record, (replacement) => {
      const direct = directReplacement(replacement);
      if (direct) return direct;
      if (replacement.kind === 'classic-import') {
        const targetId = classicWorkerNodeId(replacement.url, context);
        return linkedWorkerSpecifier(links, targetId);
      }
      if (replacement.kind === 'import') {
        const targetId = moduleWorkerNodeId(replacement.url, context);
        if (replacement.eager === false) {
          return workerUrlExpression(replacement.url, context, 'module');
        }
        return linkedWorkerSpecifier(links, targetId);
      }
      if (replacement.kind === 'worker') {
        const nested = {
          rootKey: replacement.url,
          runtimeBaseUrl: replacement.url,
        };
        return workerUrlExpression(replacement.url, nested, 'module');
      }
      if (replacement.kind === 'classic-worker') {
        const nested = {
          rootKey: replacement.url,
          runtimeBaseUrl: replacement.url,
        };
        return workerUrlExpression(replacement.url, nested, 'classic');
      }
      return assetReplacement(replacement, 'Classic worker');
    });
    workerCatalogNodes.set(classicWorkerNodeId(requestUrl, context), {
      ...(requestUrl === context.rootKey
        ? { bootstrap: workerBootstrap(record.runtimeBaseUrl) }
        : {}),
      code,
      format: 'classic',
      links,
    });
  }

  const moduleGraphs = new Map<
    string,
    {
      context: WorkerContext;
      records: Map<string, ModuleRecord>;
    }
  >();
  for (const [key, record] of workerModuleRecords) {
    const { context, requestUrl } = contextFromWorkerKey(key, record);
    let graph = moduleGraphs.get(context.rootKey);
    if (!graph) {
      graph = { context, records: new Map() };
      moduleGraphs.set(context.rootKey, graph);
    }
    graph.records.set(requestUrl, record);
  }

  for (const graph of moduleGraphs.values()) {
    const adjacency = new Map<string, string[]>();
    const reverseAdjacency = new Map<string, string[]>();
    for (const [url, record] of graph.records) {
      const targets = [
        ...new Set(
          record.replacements.flatMap((replacement) =>
            replacement.kind === 'import' && graph.records.has(replacement.url)
              ? [replacement.url]
              : []
          )
        ),
      ];
      adjacency.set(url, targets);
      reverseAdjacency.set(url, []);
    }
    for (const [url, targets] of adjacency) {
      for (const target of targets) reverseAdjacency.get(target)!.push(url);
    }
    const finishOrder: string[] = [];
    const visited = new Set<string>();
    for (const start of graph.records.keys()) {
      if (visited.has(start)) continue;
      visited.add(start);
      const stack: Array<{ index: number; url: string }> = [{ index: 0, url: start }];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        const targets = adjacency.get(frame.url) ?? [];
        const target = targets[frame.index];
        if (target) {
          frame.index += 1;
          if (!visited.has(target)) {
            visited.add(target);
            stack.push({ index: 0, url: target });
          }
          continue;
        }
        finishOrder.push(frame.url);
        stack.pop();
      }
    }
    const cyclicUrls = new Set<string>();
    const assigned = new Set<string>();
    for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
      const start = finishOrder[index]!;
      if (assigned.has(start)) continue;
      const component: string[] = [];
      const stack = [start];
      assigned.add(start);
      while (stack.length > 0) {
        const member = stack.pop()!;
        component.push(member);
        for (const predecessor of reverseAdjacency.get(member) ?? []) {
          if (assigned.has(predecessor)) continue;
          assigned.add(predecessor);
          stack.push(predecessor);
        }
      }
      if (
        component.length > 1 ||
        (component.length === 1 && adjacency.get(component[0]!)?.includes(component[0]!))
      ) {
        for (const member of component) cyclicUrls.add(member);
      }
    }
    const dependencies = (url: string): string[] => adjacency.get(url) ?? [];
    if (cyclicUrls.size === 0) continue;

    const entries = new Set<string>();
    if (graph.records.has(graph.context.rootKey)) entries.add(graph.context.rootKey);
    for (const [key, record] of classicWorkerRecords) {
      const { context } = contextFromWorkerKey(key, record);
      if (context.rootKey !== graph.context.rootKey) continue;
      for (const replacement of record.replacements) {
        if (replacement.kind === 'import' && graph.records.has(replacement.url)) {
          entries.add(replacement.url);
        }
      }
    }
    const reachesCycle = (entryUrl: string): boolean => {
      const visited = new Set<string>();
      const pending = [entryUrl];
      while (pending.length > 0) {
        const url = pending.pop()!;
        if (cyclicUrls.has(url)) return true;
        if (visited.has(url)) continue;
        visited.add(url);
        pending.push(...dependencies(url));
      }
      return false;
    };

    for (const entryUrl of entries) {
      if (!reachesCycle(entryUrl)) continue;
      const sources = new Map<string, string>();
      for (const [url, record] of graph.records) {
        sources.set(
          url,
          rewriteJavaScript(record, (replacement) => {
            const direct = directReplacement(replacement);
            if (direct) return direct;
            if (replacement.kind === 'import') return replacement.url;
            if (replacement.kind === 'worker') {
              const nested = {
                rootKey: replacement.url,
                runtimeBaseUrl: replacement.url,
              };
              return workerUrlExpression(replacement.url, nested, 'module');
            }
            if (replacement.kind === 'classic-worker') {
              const nested = {
                rootKey: replacement.url,
                runtimeBaseUrl: replacement.url,
              };
              return workerUrlExpression(replacement.url, nested, 'classic');
            }
            return assetReplacement(replacement, 'Cyclic module Worker');
          })
        );
      }
      const code = await bundleCyclicWorkerModules(entryUrl, sources);
      workerCatalogNodes.set(moduleWorkerNodeId(entryUrl, graph.context), {
        ...(entryUrl === graph.context.rootKey
          ? { bootstrap: workerBootstrap(graph.context.runtimeBaseUrl) }
          : {}),
        code,
        format: 'module',
        links: {},
      });
    }
  }

  if (workerCatalogNodes.size > 0) {
    const nodes = Object.fromEntries(workerCatalogNodes);
    const catalog: WorkerCatalog = {
      id: sha256Text(JSON.stringify(nodes)),
      nodes,
    };
    const serializedCatalog = JSON.stringify(catalog).replaceAll('<', '\\u003c');
    const installerSource = hermesSafeInstallerSource(
      installWorkerCatalog,
      WORKER_CATALOG_INSTALLER_SOURCE
    );
    const installer = `(${installerSource})(${serializedCatalog},${JSON.stringify(
      installerSource
    )});`;
    const installerElement = elementFromHtml('<script></script>');
    setTextContent(installerElement, installer);
    prependToHead(document, installerElement);
  }

  const dynamicScriptUrlExpression = (url: string, scriptTarget?: string): ReplacementValue => {
    const record = dynamicScriptRecords.get(url);
    if (!record) return assetReplacement({ end: 0, kind: 'asset', start: 0, url }, 'Script');
    return {
      expression: `globalThis[${JSON.stringify(
        DYNAMIC_SCRIPT_MATERIALIZER_NAME
      )}](${JSON.stringify(url)}${scriptTarget ? `, ${scriptTarget}` : ''})`,
    };
  };
  const dynamicScriptReplacement = (replacement: Replacement): ReplacementValue | undefined => {
    if (replacement.kind === 'classic-script-insert') {
      if (!replacement.scriptTarget) {
        throw new Error(`Dynamic script insertion has no stable target: ${replacement.url}`);
      }
      return {
        expression: `globalThis[${JSON.stringify(
          DYNAMIC_SCRIPT_PREPARER_NAME
        )}](${JSON.stringify(replacement.url)}, ${replacement.scriptTarget})`,
      };
    }
    if (replacement.kind !== 'classic-script') return undefined;
    return replacement.deferred
      ? replacement.url
      : dynamicScriptUrlExpression(replacement.url, replacement.scriptTarget);
  };

  const dynamicScriptNodes: DynamicScriptCatalog['nodes'] = {};
  for (const [url, record] of dynamicScriptRecords) {
    let code = rewriteJavaScript(record, (replacement) => {
      const direct = directReplacement(replacement);
      if (direct) return direct;
      if (replacement.kind === 'import') return replacement.url;
      const dynamicScript = dynamicScriptReplacement(replacement);
      if (dynamicScript) return dynamicScript;
      if (replacement.kind === 'worker') {
        const context = {
          rootKey: replacement.url,
          runtimeBaseUrl: replacement.url,
        };
        return workerUrlExpression(replacement.url, context, 'module');
      }
      if (replacement.kind === 'classic-worker') {
        const context = {
          rootKey: replacement.url,
          runtimeBaseUrl: replacement.url,
        };
        return workerUrlExpression(replacement.url, context, 'classic');
      }
      return assetReplacement(replacement, 'Script');
    });
    if (record.replacements.some((replacement) => replacement.kind === 'current-script')) {
      code = `document.currentScript?.setAttribute(${JSON.stringify(
        ORIGINAL_SCRIPT_SOURCE_ATTRIBUTE
      )}, ${JSON.stringify(url)});\n${code}`;
    }
    const asset = loaded.get(url);
    const bytes = asset && resourceBytes(asset);
    if (!bytes) throw new Error(`Dynamic script bytes are unavailable for ${url}`);
    dynamicScriptNodes[url] = {
      code,
      integrity: {
        sha256: integrityDigestForBytes(bytes, 'sha256'),
        sha384: integrityDigestForBytes(bytes, 'sha384'),
        sha512: integrityDigestForBytes(bytes, 'sha512'),
      },
    };
  }

  if (Object.keys(dynamicScriptNodes).length > 0) {
    const catalog: DynamicScriptCatalog = {
      id: sha256Text(JSON.stringify(dynamicScriptNodes)),
      nodes: dynamicScriptNodes,
    };
    const serializedCatalog = JSON.stringify(catalog).replaceAll('<', '\\u003c');
    const installerSource = hermesSafeInstallerSource(
      installDynamicScriptCatalog,
      DYNAMIC_SCRIPT_CATALOG_INSTALLER_SOURCE
    );
    const installer = `(${installerSource})(${serializedCatalog});`;
    const installerElement = elementFromHtml('<script></script>');
    setTextContent(installerElement, installer);
    prependToHead(document, installerElement);
  }

  const generatedImports = new Map<string, string>();
  for (const [url, record] of moduleRecords) {
    const code = rewriteJavaScript(record, (replacement) => {
      const direct = directReplacement(replacement);
      if (direct) return direct;
      if (replacement.kind === 'import') return replacement.url;
      const dynamicScript = dynamicScriptReplacement(replacement);
      if (dynamicScript) return dynamicScript;
      if (replacement.kind === 'worker') {
        const context = {
          rootKey: replacement.url,
          runtimeBaseUrl: replacement.url,
        };
        return workerUrlExpression(replacement.url, context, 'module');
      }
      if (replacement.kind === 'classic-worker') {
        const context = {
          rootKey: replacement.url,
          runtimeBaseUrl: replacement.url,
        };
        return workerUrlExpression(replacement.url, context, 'classic');
      }
      return assetReplacement(replacement, 'Module');
    });
    generatedImports.set(url, dataUrl('text/javascript', code, reserveMaterializedBytes, url));
  }

  if (generatedImports.size > 0) {
    for (const element of existingImportMap.elements) removeElement(element);
    const imports = Object.fromEntries(existingImportMap.imports);
    for (const [url, mapped] of generatedImports) imports[url] = mapped;
    const scopes = Object.fromEntries(
      [...existingImportMap.scopes].map(([scope, mappings]) => [
        scope,
        Object.fromEntries(mappings),
      ])
    );
    const integrity = Object.fromEntries(existingImportMap.integrity);
    const json = JSON.stringify({
      imports,
      ...(Object.keys(scopes).length > 0 ? { scopes } : {}),
      ...(Object.keys(integrity).length > 0 ? { integrity } : {}),
    }).replaceAll('<', '\\u003c');
    prependToHead(document, elementFromHtml(`<script type="importmap">${json}</script>`));
  }
  for (const { element, url } of moduleEntries) {
    removeAttribute(element, 'src');
    removeAttribute(element, 'integrity');
    setTextContent(element, `import ${JSON.stringify(url)};`);
  }

  for (const { analysis, code, element, external, originalSourceUrl } of scriptRecords) {
    await loadAnalyzedAssets(analysis);
    const rewritten = rewriteJavaScript(
      {
        code,
        replacements: analysis.replacements,
        runtimeBaseUrl: documentBase,
        url: documentBase,
      },
      (replacement) => {
        const direct = directReplacement(replacement);
        if (direct) return direct;
        if (replacement.kind === 'import') return replacement.url;
        const dynamicScript = dynamicScriptReplacement(replacement);
        if (dynamicScript) return dynamicScript;
        if (replacement.kind === 'worker') {
          const context = {
            rootKey: replacement.url,
            runtimeBaseUrl: replacement.url,
          };
          return workerUrlExpression(replacement.url, context, 'module');
        }
        if (replacement.kind === 'classic-worker') {
          const context = {
            rootKey: replacement.url,
            runtimeBaseUrl: replacement.url,
          };
          return workerUrlExpression(replacement.url, context, 'classic');
        }
        if (replacement.kind === 'classic-import') {
          const context = {
            rootKey: replacement.url,
            runtimeBaseUrl: replacement.url,
          };
          return workerUrlExpression(replacement.url, context, 'classic');
        }
        return assetReplacement(replacement, 'Script');
      }
    );
    if (external) {
      if (
        originalSourceUrl &&
        analysis.replacements.some((replacement) => replacement.kind === 'current-script')
      ) {
        setAttribute(element, ORIGINAL_SCRIPT_SOURCE_ATTRIBUTE, originalSourceUrl);
      }
      setAttribute(
        element,
        'src',
        dataUrl(
          'text/javascript',
          rewritten,
          reserveMaterializedBytes,
          originalSourceUrl ?? documentBase
        )
      );
      setTextContent(element, '');
    } else {
      setTextContent(element, rewritten);
    }
  }

  for (const element of elements) {
    if (isModulePreload(element)) {
      const href = attribute(element, 'href');
      if (!href) continue;
      const url = absoluteUrl(href, documentBase);
      if (!shouldLocalize(url, canLocalize)) continue;
      const asset =
        loaded.get(url) ??
        (await load(url, {
          delivery: 'inline',
          integrity: attribute(element, 'integrity'),
        }));
      loaded.set(url, asset);
      assertJavaScriptMediaType(asset, url);
      verifyElementIntegrity(element, asset, url);
      removeElement(element);
      continue;
    }
    if (isStylesheet(element)) {
      const href = attribute(element, 'href');
      if (!href) continue;
      const url = absoluteUrl(href, documentBase);
      if (!shouldLocalize(url, canLocalize)) continue;
      const asset = await load(url, {
        delivery: 'inline',
        integrity: attribute(element, 'integrity'),
      });
      loaded.set(url, asset);
      assertStylesheetMediaType(asset, url);
      verifyElementIntegrity(element, asset, url);
      const css = await localizeCss(
        bytesToUtf8(base64ToBytes(resourceContent(asset))),
        asset.responseUrl ?? url,
        load,
        loaded,
        new Set([url, asset.responseUrl ?? url]),
        canLocalize,
        reserveMaterializedBytes
      );
      setAttribute(element, 'href', dataUrl('text/css', css, reserveMaterializedBytes, url));
      removeAttribute(element, 'integrity');
      continue;
    }
    if (element.tagName === 'style') {
      const css = textContent(element);
      setTextContent(
        element,
        escapeStyleRawText(
          await localizeCss(
            css,
            documentBase,
            load,
            loaded,
            new Set(),
            canLocalize,
            reserveMaterializedBytes
          )
        )
      );
    }

    const styleAttribute = attribute(element, 'style');
    if (styleAttribute) {
      const wrapped = `x{${styleAttribute}}`;
      const localized = await localizeCss(
        wrapped,
        documentBase,
        load,
        loaded,
        new Set(),
        canLocalize,
        reserveMaterializedBytes
      );
      setAttribute(
        element,
        'style',
        localized.startsWith('x{') && localized.endsWith('}')
          ? localized.slice(2, -1)
          : styleAttribute
      );
    }

    for (const name of RESOURCE_ATTRIBUTES[element.tagName] ?? []) {
      const value = attribute(element, name);
      if (!value) continue;
      const url = absoluteUrl(value, documentBase);
      if (!shouldLocalize(url, canLocalize)) continue;
      const asset = await load(url, { delivery: 'inline' });
      loaded.set(url, asset);
      setAttribute(element, name, assetToDataUrl(asset, url, reserveMaterializedBytes));
    }

    if (['img', 'source'].includes(element.tagName)) {
      const value = attribute(element, 'srcset');
      if (value) {
        const candidates = parseSrcset(value);
        const localized = [];
        for (const candidate of candidates) {
          const url = absoluteUrl(candidate.url, documentBase);
          if (!shouldLocalize(url, canLocalize)) {
            localized.push(candidate);
            continue;
          }
          const asset = await load(url, { delivery: 'inline' });
          loaded.set(url, asset);
          localized.push({
            ...candidate,
            url: assetToDataUrl(asset, url, reserveMaterializedBytes),
          });
        }
        setAttribute(element, 'srcset', stringifySrcset(localized));
      }
    }

    if (shouldInlineLink(element)) {
      const href = attribute(element, 'href');
      if (!href) continue;
      const url = absoluteUrl(href, documentBase);
      if (!shouldLocalize(url, canLocalize)) continue;
      const relations = (attribute(element, 'rel') ?? '').toLowerCase().split(/\s+/);
      const supportsIntegrity = relations.includes('preload');
      const asset = await load(url, {
        delivery: isStreamedRuntimeAsset(url) ? 'file' : 'inline',
        integrity: supportsIntegrity ? attribute(element, 'integrity') : undefined,
      });
      loaded.set(url, asset);
      if (supportsIntegrity) verifyElementIntegrity(element, asset, url);
      const destination = (attribute(element, 'as') ?? '').toLowerCase();
      if (destination === 'script') assertJavaScriptMediaType(asset, url);
      else if (destination === 'style') assertStylesheetMediaType(asset, url);
      if (asset.delivery === 'file') removeElement(element);
      else {
        setAttribute(element, 'href', assetToDataUrl(asset, url, reserveMaterializedBytes));
        removeAttribute(element, 'integrity');
      }
    }
  }

  return {
    assets: [...loaded.values()],
    html: serialize(document),
  };
}

export function mediaTypeFromPath(path: string): string {
  const inferred = mediaTypeForUrl(new URL(path, 'https://local.invalid/').toString());
  if (inferred !== 'application/octet-stream') return inferred;
  const lower = path.toLowerCase();
  if (lower.endsWith('.avif')) return 'image/avif';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.html')) return 'text/html';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  if (lower.endsWith('.jpeg') || lower.endsWith('.jpg')) return 'image/jpeg';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.otf')) return 'font/otf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.woff')) return 'font/woff';
  return 'application/octet-stream';
}
