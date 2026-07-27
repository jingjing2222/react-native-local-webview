import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { utf8ToBytes } from '@noble/hashes/utils.js';
import { parse as parseJavaScript } from 'acorn';
import { parse, type Node } from 'parse5';
import { describe, expect, it } from 'vitest';

import { bytesToBase64, sha256Bytes } from '../src/binary';
import {
  localizeWebDocument,
  mediaTypeFromPath,
  prepareWebDocumentHtml,
  type LoadedResource,
  type ResourceLoader,
} from '../src/resourceGraph';
import {
  integrityDigestForBytes,
  type SubresourceIntegrityAlgorithm,
} from '../src/subresourceIntegrity';

type HtmlNode = Node;

const CREATE_VITE_TEMPLATES = [
  'lit',
  'lit-ts',
  'preact',
  'preact-ts',
  'qwik',
  'qwik-ts',
  'react',
  'react-ts',
  'solid',
  'solid-ts',
  'svelte',
  'svelte-ts',
  'vanilla',
  'vanilla-ts',
  'vue',
  'vue-ts',
] as const;

function resource(
  url: string,
  content: string | Uint8Array,
  mediaType = mediaTypeFromPath(new URL(url).pathname)
): LoadedResource {
  const bytes = typeof content === 'string' ? utf8ToBytes(content) : content;
  return {
    content: bytesToBase64(bytes),
    encoding: 'base64',
    mediaType,
    sha256: sha256Bytes(bytes),
    size: bytes.byteLength,
    url,
  };
}

function loader(resources: LoadedResource[], loaded?: Set<string>): ResourceLoader {
  const byUrl = new Map(resources.map((item) => [item.url, item]));
  return async (url, options) => {
    loaded?.add(url);
    const item = byUrl.get(url);
    if (!item) throw new Error(`Missing fixture resource: ${url}`);
    return { ...item, delivery: options?.delivery ?? 'inline' };
  };
}

function sri(value: string | Uint8Array, algorithm: SubresourceIntegrityAlgorithm): string {
  const bytes = typeof value === 'string' ? utf8ToBytes(value) : value;
  return `${algorithm}-${integrityDigestForBytes(bytes, algorithm)}`;
}

function executableInlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]!) && !/\btype="importmap"/i.test(match[1]!))
    .map((match) => match[2]!);
}

function importMapFromHtml(html: string): {
  imports: Record<string, string>;
  integrity?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
} {
  const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Localized HTML does not contain an import map');
  return JSON.parse(match[1]!) as {
    imports: Record<string, string>;
    integrity?: Record<string, string>;
    scopes?: Record<string, Record<string, string>>;
  };
}

function decodeTextDataUrl(url: string): string {
  const separator = url.indexOf(',');
  if (separator < 0 || !url.startsWith('data:')) throw new Error(`Not a data URL: ${url}`);
  return decodeURIComponent(url.slice(separator + 1));
}

function materializedWorkerGraph(html: string): {
  materialize: (id: string) => string;
  rootIds: string[];
  sources: Map<string, string>;
} {
  const installer = executableInlineScripts(html).find((code) =>
    code.includes('function installWorkerCatalog')
  );
  if (!installer) throw new Error('Localized HTML does not contain a Worker graph installer');
  const sources = new Map<string, string>();
  let sequence = 0;
  class RuntimeBlob {
    readonly parts: unknown[];

    constructor(parts: unknown[]) {
      this.parts = parts;
    }
  }
  const runtimeUrl = {
    createObjectURL(blob: RuntimeBlob): string {
      const url = `blob:localized-worker-${sequence++}`;
      sources.set(url, blob.parts.map(String).join(''));
      return url;
    },
  };
  const context: Record<string, unknown> = {
    Blob: RuntimeBlob,
    Map,
    Object,
    Set,
    URL: runtimeUrl,
  };
  runInNewContext(installer, context);
  const materialize = context.__reactNativeLocalWebViewMaterializeWorker__;
  if (typeof materialize !== 'function') throw new Error('Worker materializer was not installed');
  const rootIds = executableInlineScripts(html).flatMap((code) =>
    [
      ...code.matchAll(
        /globalThis\["__reactNativeLocalWebViewMaterializeWorker__"\]\(("(?:\\.|[^"\\])*")\)/g
      ),
    ].map((match) => JSON.parse(match[1]!) as string)
  );
  return {
    materialize: materialize as (id: string) => string,
    rootIds,
    sources,
  };
}

async function executeBundledWorkerSource(source: string): Promise<unknown[]> {
  const lines = source.split('\n');
  const registrationLine = lines.findIndex((line) =>
    line.includes('__reactNativeLocalWebViewRegisterWorkerModule__')
  );
  if (registrationLine < 0) throw new Error('Worker source does not contain its registration');
  const moduleSource = lines.slice(registrationLine + 1).join('\n');
  const messages: unknown[] = [];
  const scope = globalThis as typeof globalThis & {
    postMessage?: (value: unknown) => void;
  };
  const previous = scope.postMessage;
  scope.postMessage = (value) => messages.push(value);
  try {
    const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`;
    await import(/* @vite-ignore */ moduleUrl);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    if (previous) {
      scope.postMessage = previous;
    } else {
      delete (scope as { postMessage?: unknown }).postMessage;
    }
  }
  return messages;
}

function materializedDynamicScripts(html: string): {
  materialize: (
    id: string,
    element?: {
      getAttribute?: (name: string) => string | null;
      integrity?: string;
      removeAttribute?: (name: string) => void;
    }
  ) => string;
  prepare: <
    T extends {
      getAttribute?: (name: string) => string | null;
      integrity?: string;
      removeAttribute?: (name: string) => void;
      src: string;
    },
  >(
    id: string,
    element: T
  ) => T;
  rootIds: string[];
  sources: Map<string, string>;
} {
  const installer = executableInlineScripts(html).find((code) =>
    code.includes('function installDynamicScriptCatalog')
  );
  if (!installer) throw new Error('Localized HTML does not contain a dynamic script installer');
  const sources = new Map<string, string>();
  let sequence = 0;
  class RuntimeBlob {
    readonly parts: unknown[];

    constructor(parts: unknown[]) {
      this.parts = parts;
    }
  }
  const context: Record<string, unknown> = {
    atob,
    Blob: RuntimeBlob,
    btoa,
    Map,
    URL: {
      createObjectURL(blob: RuntimeBlob): string {
        const url = `blob:localized-script-${sequence++}`;
        sources.set(url, blob.parts.map(String).join(''));
        return url;
      },
    },
  };
  runInNewContext(installer, context);
  const materialize = context.__reactNativeLocalWebViewMaterializeDynamicScript__;
  if (typeof materialize !== 'function') {
    throw new Error('Dynamic script materializer was not installed');
  }
  const prepare = context.__reactNativeLocalWebViewPrepareDynamicScript__;
  if (typeof prepare !== 'function') {
    throw new Error('Dynamic script preparer was not installed');
  }
  const rootIds = executableInlineScripts(html).flatMap((code) =>
    [
      ...code.matchAll(
        /globalThis\["__reactNativeLocalWebView(?:Materialize|Prepare)DynamicScript__"\]\(("(?:\\.|[^"\\])*")(?=,|\))/g
      ),
    ].map((match) => JSON.parse(match[1]!) as string)
  );
  return {
    materialize: materialize as (
      id: string,
      element?: {
        getAttribute?: (name: string) => string | null;
        integrity?: string;
        removeAttribute?: (name: string) => void;
      }
    ) => string,
    prepare: prepare as <
      T extends {
        getAttribute?: (name: string) => string | null;
        integrity?: string;
        removeAttribute?: (name: string) => void;
        src: string;
      },
    >(
      id: string,
      element: T
    ) => T,
    rootIds,
    sources,
  };
}

function viteHtml(template: string, index: number): string {
  const mountId = ['react', 'preact', 'solid', 'qwik'].some((framework) =>
    template.startsWith(framework)
  )
    ? 'root'
    : 'app';
  if (index % 3 === 0) {
    return `<!doctype html><HTML><head><LINK crossorigin HREF=/assets/${template}.css REL=stylesheet><SCRIPT crossorigin SRC=/assets/${template}.js TYPE=module></SCRIPT></head><body><div id=${mountId}></div></body></HTML>`;
  }
  if (index % 3 === 1) {
    return `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <link rel="stylesheet"
                href="/assets/${template}.css"
                crossorigin>
          <script src="/assets/${template}.js"
                  type="module"
                  crossorigin></script>
        </head>
        <body><div id="${mountId}"></div></body>
      </html>`;
  }
  return `<!DOCTYPE html><html><head><script type='module' data-app='${template}' src='/assets/${template}.js'></script><link href='/assets/${template}.css' rel='stylesheet'></head><body><div id='${mountId}'></div></body></html>`;
}

describe('create-vite CSR output compatibility', () => {
  it('covers every static CSR template shipped by pinned create-vite', () => {
    const packageRoot = path.dirname(
      fileURLToPath(import.meta.resolve('create-vite/package.json'))
    );
    const bundled = readdirSync(packageRoot)
      .filter((name) => name.startsWith('template-'))
      .map((name) => name.slice('template-'.length))
      .sort();
    expect(bundled).toEqual([...CREATE_VITE_TEMPLATES].sort());
  });

  it.each(CREATE_VITE_TEMPLATES)(
    'localizes the %s production index.html shape',
    async (template) => {
      const origin = 'https://csr.example';
      const result = await localizeWebDocument({
        entryUrl: `${origin}/`,
        html: viteHtml(template, CREATE_VITE_TEMPLATES.indexOf(template)),
        load: loader([
          resource(
            `${origin}/assets/${template}.js`,
            `document.body.dataset.framework=${JSON.stringify(template)};`,
            'text/javascript'
          ),
          resource(
            `${origin}/assets/${template}.css`,
            `body{background:url("/assets/${template}.png")}`,
            'text/css'
          ),
          resource(
            `${origin}/assets/${template}.png`,
            new Uint8Array([137, 80, 78, 71]),
            'image/png'
          ),
        ]),
      });

      expect(result.html).toContain('type="importmap"');
      expect(result.html).toContain(`import "${origin}/assets/${template}.js"`);
      expect(result.html).toContain('<link');
      expect(result.html).toContain('href="data:text/css;charset=utf-8,');
      expect(result.html).toContain('data%3Aimage%2Fpng%3Bbase64%2C');
      expect(result.html).not.toMatch(/<(?:link|script)\b[^>]+(?:href|src)="(?:\/|https?:)/i);
    }
  );
});

describe('mediaTypeFromPath', () => {
  it.each([
    ['asset.js', 'text/javascript'],
    ['asset.css', 'text/css'],
    ['asset.avif', 'image/avif'],
    ['asset.gif', 'image/gif'],
    ['asset.html', 'text/html'],
    ['asset.ico', 'image/x-icon'],
    ['asset.jpeg', 'image/jpeg'],
    ['asset.json', 'application/json'],
    ['asset.mp3', 'audio/mpeg'],
    ['asset.mp4', 'video/mp4'],
    ['asset.ogg', 'audio/ogg'],
    ['asset.otf', 'font/otf'],
    ['asset.png', 'image/png'],
    ['asset.svg', 'image/svg+xml'],
    ['asset.webm', 'video/webm'],
    ['asset.webp', 'image/webp'],
    ['asset.woff2', 'font/woff2'],
    ['asset.woff', 'font/woff'],
    ['game.framework.js.unityweb', 'application/octet-stream'],
    ['game.wasm.unityweb', 'application/octet-stream'],
    ['asset.unknown', 'application/octet-stream'],
  ])('infers %s as %s', (path, expected) => {
    expect(mediaTypeFromPath(path)).toBe(expected);
  });
});

describe('complete CSR asset graph', () => {
  it('localizes dynamic imports, module workers, WASM, CSS imports, and srcset', async () => {
    const origin = 'https://features.example';
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/`,
      html: `<!doctype html>
        <html>
          <head>
            <link rel="stylesheet" href="/assets/app.css">
            <script type="module" src="/assets/entry.js"></script>
          </head>
          <body>
            <picture>
              <source srcset="/large.png 2x, /small.png 1x">
              <img src="/small.png" srcset="/small.png 320w, /large.png 1280w">
            </picture>
          </body>
        </html>`,
      load: loader(
        [
          resource(
            `${origin}/assets/entry.js`,
            `export const lazy = import("./lazy.js");
             export const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
             export const wasm = fetch(new URL("./math.wasm", import.meta.url));`,
            'text/javascript'
          ),
          resource(
            `${origin}/assets/lazy.js`,
            `import { shared } from "./shared.js"; export default shared;`,
            'text/javascript'
          ),
          resource(
            `${origin}/assets/shared.js`,
            `export const shared = "local";`,
            'text/javascript'
          ),
          resource(
            `${origin}/assets/worker.js`,
            `import { answer } from "./worker-dependency.js"; postMessage(answer);`,
            'text/javascript'
          ),
          resource(
            `${origin}/assets/worker-dependency.js`,
            `export const answer = 42;`,
            'text/javascript'
          ),
          resource(
            `${origin}/assets/math.wasm`,
            new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
            'application/wasm'
          ),
          resource(
            `${origin}/assets/app.css`,
            `@import "./theme.css"; .hero{background:url("./hero.png")}`,
            'text/css'
          ),
          resource(`${origin}/assets/theme.css`, `:root{--accent:#7c3aed}`, 'text/css'),
          resource(`${origin}/assets/hero.png`, new Uint8Array([1, 2, 3]), 'image/png'),
          resource(`${origin}/small.png`, new Uint8Array([4, 5, 6]), 'image/png'),
          resource(`${origin}/large.png`, new Uint8Array([7, 8, 9]), 'image/png'),
        ],
        seen
      ),
    });

    expect(seen).toEqual(
      new Set([
        `${origin}/assets/entry.js`,
        `${origin}/assets/lazy.js`,
        `${origin}/assets/shared.js`,
        `${origin}/assets/worker.js`,
        `${origin}/assets/worker-dependency.js`,
        `${origin}/assets/math.wasm`,
        `${origin}/assets/app.css`,
        `${origin}/assets/theme.css`,
        `${origin}/assets/hero.png`,
        `${origin}/small.png`,
        `${origin}/large.png`,
      ])
    );
    expect(result.html).toContain('type="importmap"');
    expect(result.html).toContain('data:text/javascript;charset=utf-8,');
    expect(result.html).toContain(encodeURIComponent(`${origin}/assets/math.wasm`));
    expect(
      result.assets.find((asset) => asset.url === `${origin}/assets/math.wasm`)?.delivery
    ).toBe('bridge');
    expect(result.html).toContain('data:text/css;charset=utf-8,');
    expect(result.html).toContain('srcset="data:image/png;base64,');
    expect(result.html).not.toContain('src="/assets/');
    expect(result.html).not.toContain('href="/assets/');
  });

  it('uses an HTML5 parser for unusual but valid markup', async () => {
    const origin = 'https://markup.example';
    const result = await localizeWebDocument({
      entryUrl: `${origin}/`,
      html: `<!doctype html><html><head>
        <script data-value="1 > 0" defer SRC = /app.js TYPE = module></script>
        <link HREF=/app.css media=screen REL=STYLESHEET>
      </head><body><IMG alt='hello > world' SRC = /hero.png></body></html>`,
      load: loader([
        resource(`${origin}/app.js`, 'globalThis.ready=true', 'text/javascript'),
        resource(`${origin}/app.css`, 'body{color:navy}', 'text/css'),
        resource(`${origin}/hero.png`, new Uint8Array([1, 2, 3]), 'image/png'),
      ]),
    });

    expect(result.html).toContain('data-value="1 > 0"');
    expect(result.html).toContain('alt="hello > world"');
    expect(result.html).toContain(
      '<link href="data:text/css;charset=utf-8,body%7Bcolor%3Anavy%7D" media="screen" rel="STYLESHEET">'
    );
    expect(result.html).toContain('src="data:image/png;base64,');
  });

  it('does not collect inactive markup inside noframes', async () => {
    const origin = 'https://markup.example';
    const loaded = new Set<string>();
    const mainUrl = `${origin}/main.js`;

    await localizeWebDocument({
      entryUrl: `${origin}/`,
      html: `<!doctype html><html><body>
        <noframes><script src="/legacy.js"></script></noframes>
        <script src="/main.js"></script>
      </body></html>`,
      load: loader([resource(mainUrl, 'globalThis.main = true;', 'text/javascript')], loaded),
    });

    expect(loaded).toEqual(new Set([mainUrl]));
  });

  it('localizes a generic Unity WebGL loader and streams its large runtime files', async () => {
    const origin = 'https://game.example';
    const files = [
      'Build/game.data.gz',
      'Build/game.framework.js.gz',
      'Build/game.wasm.gz',
      'Build/game.symbols.json',
    ];
    const result = await localizeWebDocument({
      entryUrl: `${origin}/play/`,
      html: `<!doctype html>
        <html>
          <head>
            <link rel="preload" href="./Build/game.framework.js.gz" as="script">
          </head>
          <body>
            <canvas id="unity-canvas"></canvas>
            <script>
              const loaderUrl = "Build/game.loader.js";
              const config = {
                dataUrl: "Build/game.data.gz",
                frameworkUrl: "Build/game.framework.js.gz",
                codeUrl: "Build/game.wasm.gz",
                symbolsUrl: "Build/game.symbols.json",
                streamingAssetsUrl: "StreamingAssets"
              };
              const script = document.createElement("script");
              script.src = loaderUrl;
              document.body.appendChild(script);
            </script>
          </body>
        </html>`,
      load: loader([
        resource(
          `${origin}/play/Build/game.loader.js`,
          'globalThis.createUnityInstance = () => Promise.resolve();',
          'text/javascript'
        ),
        ...files.map((file) =>
          resource(
            `${origin}/play/${file}`,
            file.includes('.framework.js')
              ? 'globalThis.unityFramework = true;'
              : new Uint8Array([1, 2, 3, 4]),
            file.includes('.wasm') ? 'application/wasm' : mediaTypeFromPath(file)
          )
        ),
      ]),
    });

    expect(result.html).toContain('<link rel="preload" href="data:text/javascript;base64,');
    expect(result.html).toContain('data:text/javascript;base64,');
    for (const file of files.filter((file) => !file.includes('.framework.js'))) {
      const url = `${origin}/play/${file}`;
      expect(result.html).toContain(url);
      expect(result.assets.find((asset) => asset.url === url)?.delivery).toBe('bridge');
    }
    const frameworkUrl = `${origin}/play/Build/game.framework.js.gz`;
    expect(result.html).not.toContain(frameworkUrl);
    expect(result.assets.find((asset) => asset.url === frameworkUrl)?.delivery).toBe('inline');
    expect(result.html).not.toContain('data:application/wasm;base64,');
  });

  it('evaluates the string constants used by the default Unity WebGL template', async () => {
    const origin = 'https://game.example';
    const result = await localizeWebDocument({
      entryUrl: `${origin}/play/`,
      html: `<!doctype html><html><head></head><body>
        <canvas id="unity-canvas"></canvas>
        <script>
          var buildUrl = "Build";
          var loaderUrl = buildUrl + "/game.loader.js";
          var config = {
            dataUrl: buildUrl + "/game.data",
            frameworkUrl: buildUrl + "/game.framework.js",
            codeUrl: buildUrl + "/game.wasm",
            streamingAssetsUrl: "StreamingAssets"
          };
          var script = document.createElement("script");
          script.src = loaderUrl;
          document.body.appendChild(script);
        </script>
      </body></html>`,
      load: loader([
        resource(
          `${origin}/play/Build/game.loader.js`,
          'globalThis.createUnityInstance = () => Promise.resolve();',
          'text/javascript'
        ),
        resource(
          `${origin}/play/Build/game.data`,
          new Uint8Array([1, 2, 3]),
          'application/octet-stream'
        ),
        resource(
          `${origin}/play/Build/game.framework.js`,
          'globalThis.unityFramework = true;',
          'text/javascript'
        ),
        resource(
          `${origin}/play/Build/game.wasm`,
          new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
          'application/wasm'
        ),
      ]),
    });

    expect(result.html).toContain('data:text/javascript;base64,');
    for (const name of ['game.data', 'game.wasm']) {
      const url = `${origin}/play/Build/${name}`;
      expect(result.html).toContain(url);
      expect(result.assets.find((asset) => asset.url === url)?.delivery).toBe('bridge');
    }
    const frameworkUrl = `${origin}/play/Build/game.framework.js`;
    expect(result.html).not.toContain(frameworkUrl);
    expect(result.assets.find((asset) => asset.url === frameworkUrl)?.delivery).toBe('inline');
    expect(result.html).not.toContain(`${origin}/game.loader.js`);
  });

  it('keeps Unity decompression-fallback framework files on the local fetch bridge', async () => {
    const origin = 'https://game.example';
    const frameworkUrl = `${origin}/play/Build/game.framework.js.unityweb`;
    const result = await localizeWebDocument({
      entryUrl: `${origin}/play/`,
      html: `<!doctype html><html><head></head><body><script>
        const config = {
          frameworkUrl: "Build/game.framework.js.unityweb"
        };
        globalThis.config = config;
      </script></body></html>`,
      load: loader([
        resource(frameworkUrl, new Uint8Array([1, 2, 3, 4]), 'application/octet-stream'),
      ]),
    });

    expect(result.html).toContain(frameworkUrl);
    expect(result.assets.find((asset) => asset.url === frameworkUrl)?.delivery).toBe('bridge');
    expect(result.html).not.toContain('data:text/javascript;base64,AQIDBA==');
  });

  it('does not collect immutable URL-suffixed variables without a URL consumer', async () => {
    const origin = 'https://scope.example';
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/`,
      html: `<!doctype html><html><head></head><body><script>
        const base = "Build";
        const revision = 1 + 2;
        const codeUrl = base + "/game-" + revision + ".wasm";
        let reassigned = "Build";
        reassigned = "Other";
        const unresolved = reassigned + "/ignored.wasm";
        function shadowed(base) {
          return base + "/shadowed.wasm";
        }
      </script></body></html>`,
      load: loader([], seen),
    });

    expect(seen).toEqual(new Set());
    expect(result.html).toContain('const codeUrl = base + "/game-" + revision + ".wasm"');
    expect(result.html).toContain('reassigned + "/ignored.wasm"');
    expect(result.html).toContain('base + "/shadowed.wasm"');
  });

  it('collects only URL-bearing JavaScript values instead of arbitrary display strings', async () => {
    const origin = 'https://context.example';
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/`,
      html: `<!doctype html><html><head></head><body><script>
        const label = "report.json";
        const iconPath = "/assets/icon.png";
        const avatarUrl = "/assets/avatar.png";
        const configUrl = "/api/config.json";
        const config = { dataUrl: "/assets/config.data" };
        const profile = { avatarUrl: "/assets/object-avatar.png" };
        globalThis.configuration = config;
        globalThis.profile = profile;
        globalThis.icon = iconPath;
        globalThis.avatar.textContent = avatarUrl;
        globalThis.runtime = fetch("/assets/runtime.data");
        globalThis.config = fetch(configUrl);
        globalThis.literalConfig = fetch("/api/literal.json");
        globalThis.api = fetch("/api/state");
        globalThis.apiUrl = new URL("/api/live", location.origin);
      </script></body></html>`,
      load: loader(
        [
          resource(
            `${origin}/assets/config.data`,
            new Uint8Array([4, 5, 6]),
            'application/octet-stream'
          ),
          resource(
            `${origin}/assets/runtime.data`,
            new Uint8Array([7, 8, 9]),
            'application/octet-stream'
          ),
          resource(`${origin}/api/config.json`, '{"source":"identifier"}', 'application/json'),
          resource(`${origin}/api/literal.json`, '{"source":"literal"}', 'application/json'),
        ],
        seen
      ),
    });

    expect(seen).toEqual(
      new Set([
        `${origin}/assets/config.data`,
        `${origin}/assets/runtime.data`,
        `${origin}/api/config.json`,
        `${origin}/api/literal.json`,
      ])
    );
    expect(result.html).toContain('const label = "report.json"');
    expect(result.html).not.toContain(`${origin}/report.json`);
    expect(result.html).toContain('const iconPath = "/assets/icon.png"');
    expect(result.html).toContain('const avatarUrl = "/assets/avatar.png"');
    expect(result.html).toContain('const profile = { avatarUrl: "/assets/object-avatar.png" }');
    expect(result.html).toContain('globalThis.avatar.textContent = avatarUrl');
    expect(result.html).toContain(`${origin}/assets/config.data`);
    expect(result.html).not.toContain('data:image/png;base64,');
    expect(result.html).toContain(`${origin}/assets/runtime.data`);
    expect(result.html).toContain(`fetch("${origin}/api/config.json")`);
    expect(result.html).toContain(`fetch("${origin}/api/literal.json")`);
    expect(result.html).toContain('fetch("/api/state")');
    expect(result.html).toContain('new URL("/api/live", location.origin)');
    expect(
      result.assets
        .filter((asset) =>
          [`${origin}/api/config.json`, `${origin}/api/literal.json`].includes(asset.url)
        )
        .map((asset) => asset.delivery)
    ).toEqual(['bridge', 'bridge']);
  });

  it('collects unshadowed global receiver fetch calls without treating arbitrary methods as fetch', async () => {
    const origin = 'https://global-fetch.example';
    const urls = [
      `${origin}/assets/window.json`,
      `${origin}/assets/global.json`,
      `${origin}/assets/self.json`,
    ];
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><script>
        window.fetch("/assets/window.json");
        globalThis.fetch("/assets/global.json");
        self.fetch("/assets/self.json");
        globalThis.api.fetch("/assets/not-an-inventory-entry.json");
        function shadowed(window, globalThis, self) {
          window.fetch("/assets/shadowed-window.json");
          globalThis.fetch("/assets/shadowed-global.json");
          self.fetch("/assets/shadowed-self.json");
        }
      </script>`,
      load: loader(
        urls.map((url) => resource(url, '{}', 'application/json')),
        seen
      ),
    });

    expect(seen).toEqual(new Set(urls));
    for (const url of urls) {
      expect(result.html).toContain(`fetch("${url}")`);
      expect(result.assets.find((asset) => asset.url === url)?.delivery).toBe('bridge');
    }
    expect(result.html).toContain('globalThis.api.fetch("/assets/not-an-inventory-entry.json")');
    expect(result.html).toContain('window.fetch("/assets/shadowed-window.json")');
  });

  it('collects immutable page XMLHttpRequest GET assets without matching shadowed constructors', async () => {
    const origin = 'https://page-xhr.example';
    const dataUrl = `${origin}/Build/game.data`;
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><script>
        const request = new XMLHttpRequest();
        const alias = request;
        const dataPath = "/Build/game.data";
        alias.open("get", dataPath);
        function ignored(XMLHttpRequest) {
          const shadowed = new XMLHttpRequest();
          shadowed.open("GET", "/Build/shadowed.data");
        }
      </script>`,
      load: loader(
        [resource(dataUrl, new Uint8Array([1, 2, 3, 4]), 'application/octet-stream')],
        seen
      ),
    });

    expect(seen).toEqual(new Set([dataUrl]));
    expect(result.html).toContain(`alias.open("get", "${dataUrl}")`);
    expect(result.html).toContain('shadowed.open("GET", "/Build/shadowed.data")');
    expect(result.assets.find((asset) => asset.url === dataUrl)?.delivery).toBe('bridge');
  });

  it('leaves non-executable script data blocks untouched', async () => {
    const origin = 'https://data-block.example';
    const seen = new Set<string>();
    const html = `<!doctype html><html><head>
      <script type="application/ld+json" src="/metadata.json"></script>
      <script type="application/json">{"assetUrl":"/assets/not-code.png"}</script>
    </head><body></body></html>`;

    const result = await localizeWebDocument({
      entryUrl: `${origin}/`,
      html,
      load: loader([], seen),
    });

    expect(seen).toEqual(new Set());
    expect(result.html).toContain('type="application/ld+json" src="/metadata.json"');
    expect(result.html).toContain('{"assetUrl":"/assets/not-code.png"}');
  });

  it('recursively localizes concatenated imports and workers from inline modules', async () => {
    const origin = 'https://inline.example';
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/`,
      html: `<!doctype html><html><head><script type="module">
        const chunkRoot = "/chunks";
        globalThis.lazy = import(chunkRoot + "/lazy.js");
        globalThis.worker = new Worker(chunkRoot + "/worker.js", { type: "module" });
      </script></head><body></body></html>`,
      load: loader(
        [
          resource(
            `${origin}/chunks/lazy.js`,
            'import { value } from "./dependency.js"; export default value;',
            'text/javascript'
          ),
          resource(`${origin}/chunks/dependency.js`, 'export const value = 42;', 'text/javascript'),
          resource(
            `${origin}/chunks/worker.js`,
            'import { message } from "./worker-dependency.js"; postMessage(message);',
            'text/javascript'
          ),
          resource(
            `${origin}/chunks/worker-dependency.js`,
            'export const message = "ready";',
            'text/javascript'
          ),
        ],
        seen
      ),
    });

    expect(seen).toEqual(
      new Set([
        `${origin}/chunks/lazy.js`,
        `${origin}/chunks/dependency.js`,
        `${origin}/chunks/worker.js`,
        `${origin}/chunks/worker-dependency.js`,
      ])
    );
    expect(result.html).toContain('type="importmap"');
    expect(result.html).toContain(encodeURIComponent('postMessage(message)'));
    expect(result.html).not.toContain('chunkRoot + "/lazy.js"');
    expect(result.html).not.toContain('chunkRoot + "/worker.js"');
  });

  it('localizes classic workers and resolves recursive importScripts from each worker URL', async () => {
    const origin = 'https://workers.example';
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/app/`,
      html: `<!doctype html><html><head><script>
        const workerPath = "./workers/main.js";
        globalThis.worker = new Worker(workerPath);
      </script></head><body></body></html>`,
      load: loader(
        [
          resource(
            `${origin}/app/workers/main.js`,
            `importScripts("./dependencies/first.js"); postMessage("main");`,
            'text/javascript'
          ),
          resource(
            `${origin}/app/workers/dependencies/first.js`,
            `importScripts("../shared.js"); postMessage("first");`,
            'text/javascript'
          ),
          resource(`${origin}/app/shared.js`, `postMessage("shared");`, 'text/javascript'),
        ],
        seen
      ),
    });

    expect(seen).toEqual(
      new Set([
        `${origin}/app/workers/main.js`,
        `${origin}/app/workers/dependencies/first.js`,
        `${origin}/app/shared.js`,
      ])
    );
    const graph = materializedWorkerGraph(result.html);
    expect(graph.rootIds).toHaveLength(1);
    const rootUrl = graph.materialize(graph.rootIds[0]!);
    const rootCode = graph.sources.get(rootUrl);
    expect(rootCode).toContain('importScripts("blob:localized-worker-');
    expect([...graph.sources.values()]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('postMessage("first")'),
        expect.stringContaining('postMessage("shared")'),
      ])
    );
    expect(result.html).not.toContain('./dependencies/first.js');
    expect(result.html).not.toContain('../shared.js');
  });

  it('recognizes unshadowed global Worker constructors and importScripts receivers', async () => {
    const origin = 'https://worker-global-receivers.example';
    const urls = {
      globalDependency: `${origin}/workers/global-dependency.js`,
      globalWorker: `${origin}/workers/global.js`,
      windowDependency: `${origin}/workers/window-dependency.js`,
      windowWorker: `${origin}/workers/window.js`,
    };
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><script>
        new window.Worker("/workers/window.js");
        new globalThis.Worker("/workers/global.js");
        function ignored(window, globalThis) {
          new window.Worker("/workers/shadowed-window.js");
          new globalThis.Worker("/workers/shadowed-global.js");
        }
      </script>`,
      load: loader(
        [
          resource(
            urls.windowWorker,
            'self.importScripts("./window-dependency.js"); postMessage("window");',
            'text/javascript'
          ),
          resource(
            urls.windowDependency,
            'globalThis.windowDependencyLoaded = true;',
            'text/javascript'
          ),
          resource(
            urls.globalWorker,
            'globalThis.importScripts("./global-dependency.js"); postMessage("global");',
            'text/javascript'
          ),
          resource(
            urls.globalDependency,
            'globalThis.globalDependencyLoaded = true;',
            'text/javascript'
          ),
        ],
        seen
      ),
    });

    expect(seen).toEqual(new Set(Object.values(urls)));
    expect(result.html).toContain('new window.Worker(');
    expect(result.html).toContain('new globalThis.Worker(');
    expect(result.html).toContain('new window.Worker("/workers/shadowed-window.js")');
    expect(result.html).toContain('new globalThis.Worker("/workers/shadowed-global.js")');
    const graph = materializedWorkerGraph(result.html);
    expect(graph.rootIds).toHaveLength(2);
    for (const rootId of graph.rootIds) graph.materialize(rootId);
    expect([...graph.sources.values()]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('globalThis.windowDependencyLoaded = true'),
        expect.stringContaining('globalThis.globalDependencyLoaded = true'),
      ])
    );
  });

  it('serializes and materializes a shared classic Worker dependency only once', async () => {
    const origin = 'https://classic-worker-diamond.example';
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head></head><body><script>
        new Worker("/workers/root.js");
      </script></body></html>`,
      load: loader([
        resource(
          `${origin}/workers/root.js`,
          'importScripts("./left.js", "./right.js");',
          'text/javascript'
        ),
        resource(
          `${origin}/workers/left.js`,
          'importScripts("./shared.js"); globalThis.left = true;',
          'text/javascript'
        ),
        resource(
          `${origin}/workers/right.js`,
          'importScripts("./shared.js"); globalThis.right = true;',
          'text/javascript'
        ),
        resource(
          `${origin}/workers/shared.js`,
          'globalThis.uniqueClassicWorkerMarker = true;',
          'text/javascript'
        ),
      ]),
    });

    expect(result.html.match(/uniqueClassicWorkerMarker/g)).toHaveLength(1);
    const graph = materializedWorkerGraph(result.html);
    graph.materialize(graph.rootIds[0]!);
    expect(
      [...graph.sources.values()].filter((source) => source.includes('uniqueClassicWorkerMarker'))
    ).toHaveLength(2);
    expect(graph.sources.size).toBeLessThanOrEqual(5);
  });

  it('uses the script URL for module imports and the document URL for window fetch', async () => {
    const origin = 'https://bases.example';
    const entryUrl = `${origin}/app/index.html`;
    const moduleUrl = `${origin}/assets/main.js`;
    const dependencyUrl = `${origin}/assets/dependency.js`;
    const runtimeUrl = `${origin}/app/runtime.data`;
    const configUrl = `${origin}/assets/config.json`;
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl,
      html: `<!doctype html><html><head>
        <script type="module" src="/assets/main.js"></script>
      </head><body></body></html>`,
      load: loader(
        [
          resource(
            moduleUrl,
            `import "./dependency.js";
             fetch("./runtime.data");
             window.fetch(new globalThis.URL("./config.json", import.meta.url));
             globalThis.moduleUrl = import.meta.url;
             globalThis.explicitBase = new URL("./untouched.png", location.href);`,
            'text/javascript'
          ),
          resource(dependencyUrl, 'export const dependency = true;', 'text/javascript'),
          resource(runtimeUrl, new Uint8Array([1, 2, 3]), 'application/octet-stream'),
          resource(configUrl, '{"ready":true}', 'application/json'),
        ],
        seen
      ),
    });

    expect(seen).toEqual(new Set([moduleUrl, dependencyUrl, runtimeUrl, configUrl]));
    const moduleCode = decodeTextDataUrl(importMapFromHtml(result.html).imports[moduleUrl]!);
    expect(moduleCode).toContain(`import "${dependencyUrl}"`);
    expect(moduleCode).toContain(`fetch("${runtimeUrl}")`);
    expect(moduleCode).toContain(
      `window.fetch(new globalThis.URL("${configUrl}", "${moduleUrl}"))`
    );
    expect(result.assets.find((asset) => asset.url === configUrl)?.delivery).toBe('bridge');
    expect(moduleCode).toContain(`globalThis.moduleUrl = "${moduleUrl}"`);
    expect(moduleCode).toContain('new URL("./untouched.png", location.href)');
  });

  it.each([false, true])(
    'keeps mixed inline and fetch delivery local when fetch is first=$s',
    async (fetchFirst) => {
      const origin = 'https://mixed-delivery.example';
      const moduleUrl = `${origin}/main.js`;
      const textureUrl = `${origin}/texture.png`;
      const statements = [
        'const texture = new URL("./texture.png", import.meta.url);',
        'globalThis.textureResponse = fetch("./texture.png");',
      ];
      if (fetchFirst) statements.reverse();
      statements.push('globalThis.image.src = texture;');
      const result = await localizeWebDocument({
        entryUrl: `${origin}/index.html`,
        html: '<!doctype html><script type="module" src="/main.js"></script>',
        load: loader([
          resource(moduleUrl, statements.join('\n'), 'text/javascript'),
          resource(textureUrl, new Uint8Array([1, 2, 3]), 'image/png'),
        ]),
      });

      const moduleCode = decodeTextDataUrl(importMapFromHtml(result.html).imports[moduleUrl]!);
      expect(moduleCode).toContain('new URL("data:image/png;base64,AQID"');
      expect(moduleCode).toContain(`fetch("${textureUrl}")`);
      expect(result.assets.filter((asset) => asset.url === textureUrl)).toHaveLength(1);
      expect(result.assets.find((asset) => asset.url === textureUrl)?.delivery).toBe('bridge');
    }
  );

  it('keeps worker runtime fallbacks relative to the original worker URL', async () => {
    const origin = 'https://worker-base.example';
    const workerUrl = `${origin}/app/workers/fallback.js`;
    const result = await localizeWebDocument({
      entryUrl: `${origin}/app/index.html`,
      html: `<!doctype html><html><head></head><body><script>
        globalThis.worker = new Worker("./workers/fallback.js");
      </script></body></html>`,
      load: loader([
        resource(
          workerUrl,
          `fetch(self.paths.fetch);
           const xhr = new XMLHttpRequest();
           xhr.open("GET", self.paths.xhr);
           import(self.paths.module);`,
          'text/javascript'
        ),
      ]),
    });

    const parentCode = executableInlineScripts(result.html).find((code) =>
      code.includes('globalThis.worker')
    );
    expect(parentCode).toBeDefined();
    expect(parentCode).toContain('globalThis["__reactNativeLocalWebViewMaterializeWorker__"]');
    expect(parentCode).not.toContain('new Worker("data:text/javascript');
    const graph = materializedWorkerGraph(result.html);
    const workerCode = graph.sources.get(graph.materialize(graph.rootIds[0]!));
    expect(workerCode).toBeDefined();
    expect(workerCode).toContain(`const baseUrl = "${workerUrl}"`);
    expect(workerCode).toContain('nativeFetch(');
    expect(workerCode).toContain(
      'this.native.open(method, resolve(input), async, username, password)'
    );
    expect(workerCode).toContain(`new globalThis.URL(specifier, "${workerUrl}").href`);
  });

  it('keeps fetch(new URL()) on the Worker bridge instead of inlining its response', async () => {
    const origin = 'https://worker-fetch-url.example';
    const workerUrl = `${origin}/workers/main.js`;
    const configUrl = `${origin}/workers/config.json`;
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><script>new Worker("/workers/main.js");</script>`,
      load: loader([
        resource(
          workerUrl,
          'globalThis.configuration = self.fetch(new globalThis.URL("./config.json", self.location.href));',
          'text/javascript'
        ),
        resource(configUrl, '{"worker":true}', 'application/json'),
      ]),
    });

    const graph = materializedWorkerGraph(result.html);
    const workerCode = graph.sources.get(graph.materialize(graph.rootIds[0]!));
    expect(workerCode).toContain(`new globalThis.URL("${configUrl}", "${workerUrl}")`);
    expect(result.assets.find((asset) => asset.url === configUrl)?.delivery).toBe('bridge');
  });

  it('collects immutable Worker XMLHttpRequest GET assets without matching shadowed receivers', async () => {
    const origin = 'https://worker-xhr.example';
    const workerUrl = `${origin}/workers/loader.js`;
    const wasmUrl = `${origin}/Build/game.wasm`;
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: '<!doctype html><script>new Worker("/workers/loader.js");</script>',
      load: loader(
        [
          resource(
            workerUrl,
            `const request = new self.XMLHttpRequest();
             const alias = request;
             alias.open("GET", "../Build/game.wasm");
             function ignored(self) {
               const shadowed = new self.XMLHttpRequest();
               shadowed.open("GET", "../Build/shadowed.wasm");
             }`,
            'text/javascript'
          ),
          resource(wasmUrl, new Uint8Array([0, 97, 115, 109]), 'application/wasm'),
        ],
        seen
      ),
    });

    expect(seen).toEqual(new Set([workerUrl, wasmUrl]));
    expect(result.assets.find((asset) => asset.url === wasmUrl)?.delivery).toBe('bridge');
    const graph = materializedWorkerGraph(result.html);
    const workerCode = graph.sources.get(graph.materialize(graph.rootIds[0]!));
    expect(workerCode).toContain(`alias.open("GET", "${wasmUrl}")`);
    expect(workerCode).toContain('shadowed.open("GET", "../Build/shadowed.wasm")');
  });

  it.each([
    ['classic Worker', 'new Worker("/workers/root.js")'],
    ['module Worker', 'new Worker("/workers/root.js", { type: "module" })'],
    ['classic SharedWorker', 'new SharedWorker("/workers/root.js")'],
    ['module SharedWorker', 'new SharedWorker("/workers/root.js", { type: "module" })'],
  ])('requires an explicit bypass for a $0 root response CSP', async (_name, constructor) => {
    const origin = 'https://worker-csp.example';
    const workerUrl = `${origin}/workers/root.js`;
    const worker = {
      ...resource(workerUrl, 'postMessage("ready");', 'text/javascript'),
      contentSecurityPolicy: "connect-src 'none'",
    };
    const options = {
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><script>${constructor};</script>`,
      load: loader([worker]),
    };

    await expect(localizeWebDocument(options)).rejects.toThrow(
      `Worker response ${workerUrl} has a Content-Security-Policy`
    );
    await expect(
      localizeWebDocument({
        ...options,
        allowContentSecurityPolicyBypass: true,
      })
    ).resolves.toEqual(expect.objectContaining({ html: expect.stringContaining('Blob') }));
  });

  it('treats a nested Worker response as its own CSP root', async () => {
    const origin = 'https://nested-worker-csp.example';
    const outerUrl = `${origin}/workers/outer.js`;
    const nestedUrl = `${origin}/workers/nested.js`;

    await expect(
      localizeWebDocument({
        entryUrl: `${origin}/index.html`,
        html: '<!doctype html><script>new Worker("/workers/outer.js");</script>',
        load: loader([
          resource(outerUrl, 'new Worker("./nested.js");', 'text/javascript'),
          {
            ...resource(nestedUrl, 'postMessage("nested");', 'text/javascript'),
            contentSecurityPolicy: "connect-src 'none'",
          },
        ]),
      })
    ).rejects.toThrow(`Worker response ${nestedUrl} has a Content-Security-Policy`);
  });

  it('requires an explicit bypass for a Worker root report-only CSP', async () => {
    const origin = 'https://worker-report-only-csp.example';
    const workerUrl = `${origin}/worker.js`;
    const worker = {
      ...resource(workerUrl, 'postMessage("ready");', 'text/javascript'),
      contentSecurityPolicyReportOnly: "connect-src 'none'; report-to endpoint",
    };

    await expect(
      localizeWebDocument({
        entryUrl: `${origin}/index.html`,
        html: '<!doctype html><script>new Worker("/worker.js");</script>',
        load: loader([worker]),
      })
    ).rejects.toThrow(`Worker response ${workerUrl} has a Content-Security-Policy`);
    await expect(
      localizeWebDocument({
        allowContentSecurityPolicyBypass: true,
        entryUrl: `${origin}/index.html`,
        html: '<!doctype html><script>new Worker("/worker.js");</script>',
        load: loader([worker]),
      })
    ).resolves.toEqual(expect.objectContaining({ html: expect.stringContaining('Blob') }));
  });

  it('follows an immutable new URL binding used by a module Worker', async () => {
    const origin = 'https://indirect-worker.example';
    const workerUrl = `${origin}/app/workers/main.js`;
    const dependencyUrl = `${origin}/app/workers/dependency.js`;
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/app/index.html`,
      html: `<!doctype html><html><head><script type="module">
        const workerUrl = new URL("./workers/main.js", import.meta.url);
        const workerOptions = { type: "module" };
        globalThis.worker = new Worker(workerUrl, workerOptions);
      </script></head><body></body></html>`,
      load: loader(
        [
          resource(
            workerUrl,
            'import { ready } from "./dependency.js"; postMessage(ready);',
            'text/javascript'
          ),
          resource(dependencyUrl, 'export const ready = true;', 'text/javascript'),
        ],
        seen
      ),
    });

    expect(seen).toEqual(new Set([workerUrl, dependencyUrl]));
    const script = executableInlineScripts(result.html).find((code) =>
      code.includes('const workerUrl')
    );
    expect(script).toBeDefined();
    expect(script).toContain(
      'new Worker(globalThis["__reactNativeLocalWebViewMaterializeWorker__"]'
    );
    const graph = materializedWorkerGraph(result.html);
    graph.materialize(graph.rootIds[0]!);
    expect([...graph.sources.values()]).toEqual(
      expect.arrayContaining([expect.stringContaining('postMessage(ready)')])
    );
  });

  it('bundles cyclic module Worker graphs while preserving live bindings', async () => {
    const origin = 'https://cyclic-worker.example';
    const rootUrl = `${origin}/workers/a.js`;
    const dependencyUrl = `${origin}/workers/b.js`;
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head></head><body><script type="module">
        globalThis.worker = new Worker("/workers/a.js", { type: "module" });
      </script></body></html>`,
      load: loader([
        resource(
          rootUrl,
          `import { valueB } from "./b.js";
           export let valueA = "before";
           await Promise.resolve();
           postMessage(valueB());
           valueA = "after";
           postMessage(valueB());`,
          'text/javascript'
        ),
        resource(
          dependencyUrl,
          `import { valueA } from "./a.js";
           export const valueB = () => valueA;`,
          'text/javascript'
        ),
      ]),
    });

    const graph = materializedWorkerGraph(result.html);
    const rootSource = graph.sources.get(graph.materialize(graph.rootIds[0]!));
    expect(rootSource).toBeDefined();
    expect(rootSource).toContain('const valueB = () => valueA;');
    expect(rootSource).toContain('let valueA = "before";');
    expect(rootSource).toContain('await Promise.resolve();');
    expect(rootSource).toContain('valueA = "after";');
    expect(rootSource).not.toContain('__RN_LOCAL_WEBVIEW_WORKER_LINK_');
    await expect(executeBundledWorkerSource(rootSource!)).resolves.toEqual(['before', 'after']);
  });

  it('bundles a static Worker dependency with a dynamic back-edge to its root', async () => {
    const origin = 'https://dynamic-cycle-worker.example';
    const rootUrl = `${origin}/workers/a.js`;
    const dependencyUrl = `${origin}/workers/b.js`;

    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><script type="module">
        globalThis.worker = new Worker("/workers/a.js", { type: "module" });
      </script>`,
      load: loader([
        resource(rootUrl, 'import "./b.js"; postMessage("a");', 'text/javascript'),
        resource(
          dependencyUrl,
          'void import("./a.js").then(() => postMessage("b"));',
          'text/javascript'
        ),
      ]),
    });

    const graph = materializedWorkerGraph(result.html);
    const rootSource = graph.sources.get(graph.materialize(graph.rootIds[0]!));
    expect(rootSource).toBeDefined();
    expect(rootSource).toContain('Promise.resolve().then');
    expect(rootSource).toContain('postMessage("a")');
    expect(rootSource).toContain('postMessage("b")');
    expect(rootSource).not.toContain('__RN_LOCAL_WEBVIEW_WORKER_LINK_');
    await expect(executeBundledWorkerSource(rootSource!)).resolves.toEqual(['a', 'b']);
  });

  it('bundles a self-importing module Worker without recursively materializing it', async () => {
    const origin = 'https://self-cycle-worker.example';
    const rootUrl = `${origin}/workers/self.js`;
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><script>
        globalThis.worker = new Worker("/workers/self.js", { type: "module" });
      </script>`,
      load: loader([
        resource(
          rootUrl,
          `export let value = 1;
           import { value as selfValue } from "./self.js";
           value += 1;
           postMessage(selfValue);`,
          'text/javascript'
        ),
      ]),
    });

    const graph = materializedWorkerGraph(result.html);
    const rootSource = graph.sources.get(graph.materialize(graph.rootIds[0]!));
    expect(rootSource).toBeDefined();
    expect(rootSource).toContain('let value = 1;');
    expect(rootSource).toContain('value += 1;');
    expect(rootSource).toContain('postMessage(value);');
    expect(rootSource).not.toContain('__RN_LOCAL_WEBVIEW_WORKER_LINK_');
    await expect(executeBundledWorkerSource(rootSource!)).resolves.toEqual([2]);
  });

  it('serializes shared module Worker dependencies once and reuses materialized Blob URLs', async () => {
    const origin = 'https://worker-diamond.example';
    const resources: LoadedResource[] = [];
    const levels = 12;
    for (let level = 0; level < levels; level += 1) {
      for (const side of ['left', 'right']) {
        const imports =
          level + 1 < levels
            ? `import "./left-${level + 1}.js"; import "./right-${level + 1}.js";`
            : '';
        resources.push(
          resource(
            `${origin}/workers/${side}-${level}.js`,
            `${imports} globalThis.workerMarker${level}${side} = true;`,
            'text/javascript'
          )
        );
      }
    }
    resources.push(
      resource(
        `${origin}/workers/root.js`,
        'import "./left-0.js"; import "./right-0.js";',
        'text/javascript'
      )
    );
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head></head><body><script>
        new Worker("/workers/root.js", { type: "module" });
      </script></body></html>`,
      load: loader(resources),
    });

    expect(result.html.match(/workerMarker11left/g)).toHaveLength(1);
    expect(result.html.length).toBeLessThan(150_000);
    const graph = materializedWorkerGraph(result.html);
    const first = graph.materialize(graph.rootIds[0]!);
    const sourceCount = graph.sources.size;
    const second = graph.materialize(graph.rootIds[0]!);
    expect(second).toBe(first);
    expect(graph.sources.size).toBe(sourceCount);
    expect(sourceCount).toBeLessThanOrEqual(resources.length + 2);
  });

  it('analyzes and materializes a deep acyclic module Worker graph without recursion', async () => {
    const origin = 'https://deep-worker.example';
    const depth = 15_000;
    const resources = Array.from({ length: depth }, (_, index) =>
      resource(
        `${origin}/workers/module-${index}.js`,
        index + 1 < depth ? `import "./module-${index + 1}.js";` : 'postMessage("deep-ready");',
        'text/javascript'
      )
    );
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: '<!doctype html><script>new Worker("/workers/module-0.js", { type: "module" });</script>',
      load: loader(resources),
    });

    const graph = materializedWorkerGraph(result.html);
    const rootUrl = graph.materialize(graph.rootIds[0]!);

    expect(rootUrl).toMatch(/^blob:localized-worker-/);
    expect(graph.sources.size).toBeGreaterThanOrEqual(depth);
  }, 30_000);

  it('preserves original Worker location URLs and discovers location-based assets', async () => {
    const origin = 'https://worker-location.example';
    const workerUrl = `${origin}/app/workers/main.js`;
    const wasmUrl = `${origin}/app/Build/game.wasm`;
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/app/index.html`,
      html: `<!doctype html><html><head></head><body><script>
        new Worker("./workers/main.js");
      </script></body></html>`,
      load: loader(
        [
          resource(
            workerUrl,
            `globalThis.locations = [
               self.location.href,
               location.href,
               globalThis.location.href
             ];
             globalThis.wasm = new URL("../Build/game.wasm", location.href);
             globalThis.shadowed = (location) => location.href;`,
            'text/javascript'
          ),
          resource(wasmUrl, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), 'application/wasm'),
        ],
        seen
      ),
    });

    expect(seen).toEqual(new Set([workerUrl, wasmUrl]));
    const graph = materializedWorkerGraph(result.html);
    const code = graph.sources.get(graph.materialize(graph.rootIds[0]!));
    expect(code).toContain(`"${workerUrl}"`);
    expect(code).toContain(`new URL("${wasmUrl}", "${workerUrl}")`);
    expect(code).toContain('(location) => location.href');
  });

  it('keeps Worker source containing raw-text end tags inside the generated script', async () => {
    const origin = 'https://worker-script-escape.example';
    const marker = '</ScRiPt><div id="escaped-worker-marker"></div>';
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head></head><body><main id="app"></main><script>
        new Worker("/worker.js");
      </script></body></html>`,
      load: loader([
        resource(
          `${origin}/worker.js`,
          `postMessage(${JSON.stringify(marker)});`,
          'text/javascript'
        ),
      ]),
    });

    expect(result.html).not.toContain(marker);
    expect(result.html).toContain('<main id="app"></main>');
    const graph = materializedWorkerGraph(result.html);
    const workerCode = graph.sources.get(graph.materialize(graph.rootIds[0]!));
    expect(workerCode).toContain('</ScRiPt>');
    expect(workerCode).toContain('escaped-worker-marker');
  });

  it('preserves shorthand URL properties as valid JavaScript', async () => {
    const origin = 'https://shorthand.example';
    const wasmUrl = `${origin}/Build/game.wasm`;
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/`,
      html: `<!doctype html><html><head></head><body><script>
        const codeUrl = "./Build/game.wasm";
        const config = { codeUrl };
        globalThis.config = config;
      </script></body></html>`,
      load: loader(
        [resource(wasmUrl, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), 'application/wasm')],
        seen
      ),
    });

    expect(seen).toEqual(new Set([wasmUrl]));
    const script = executableInlineScripts(result.html).find((code) =>
      code.includes('const codeUrl')
    );
    expect(script).toBeDefined();
    expect(script).toContain('const codeUrl = "./Build/game.wasm"');
    expect(script).toContain(`const config = { "codeUrl": "${wasmUrl}" };`);
    expect(() =>
      parseJavaScript(script!, { ecmaVersion: 'latest', sourceType: 'script' })
    ).not.toThrow();
  });

  it('recursively collects modules reached through dynamically assigned scripts', async () => {
    const origin = 'https://dynamic-script.example';
    const loaderUrl = `${origin}/scripts/loader.js`;
    const childUrl = `${origin}/play/child.js`;
    const chunkUrl = `${origin}/play/chunk.js`;
    const leafUrl = `${origin}/play/leaf.js`;
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/play/index.html`,
      html: `<!doctype html><html><head></head><body><script>
        const loaderUrl = "/scripts/loader.js";
        const script = document.createElement("script");
        script.src = loaderUrl;
        document.body.appendChild(script);
      </script></body></html>`,
      load: loader(
        [
          resource(
            loaderUrl,
            `const child = document.createElement("script");
             child.src = "./child.js";
             document.body.appendChild(child);`,
            'text/javascript'
          ),
          resource(childUrl, 'globalThis.lazy = import("./chunk.js");', 'text/javascript'),
          resource(chunkUrl, 'import "./leaf.js"; export const chunk = true;', 'text/javascript'),
          resource(leafUrl, 'export const leaf = true;', 'text/javascript'),
        ],
        seen
      ),
    });

    expect(seen).toEqual(new Set([loaderUrl, childUrl, chunkUrl, leafUrl]));
    const imports = importMapFromHtml(result.html).imports;
    expect(imports[chunkUrl]).toMatch(/^data:text\/javascript/);
    expect(imports[leafUrl]).toMatch(/^data:text\/javascript/);
    expect(decodeTextDataUrl(imports[chunkUrl]!)).toContain(`import "${leafUrl}"`);
  });

  it.each(['integrity-before-src', 'src-before-integrity'] as const)(
    'verifies original SRI at insertion time for $s',
    async (order) => {
      const origin = 'https://dynamic-script-sri.example';
      const loaderUrl = `${origin}/scripts/loader.js`;
      const loaderSource = 'globalThis.loaderSource = document.currentScript.src;';
      const integrity = sri(loaderSource, 'sha256');
      const assignments =
        order === 'integrity-before-src'
          ? `script.integrity = ${JSON.stringify(integrity)};
           script.src = "/scripts/loader.js";`
          : `script.src = "/scripts/loader.js";
           script.integrity = ${JSON.stringify(integrity)};`;
      const result = await localizeWebDocument({
        entryUrl: `${origin}/index.html`,
        html: `<!doctype html><html><head></head><body><script>
        const script = document.createElement("script");
        ${assignments}
        document.head.appendChild(script);
      </script></body></html>`,
        load: loader([resource(loaderUrl, loaderSource, 'text/javascript')]),
      });

      const parentSource = executableInlineScripts(result.html).find((source) =>
        source.includes('const script = document.createElement')
      );
      expect(parentSource).toContain(`script.src = "${loaderUrl}"`);
      expect(parentSource).toContain(
        `document.head.appendChild(globalThis["__reactNativeLocalWebViewPrepareDynamicScript__"]("${loaderUrl}", script))`
      );

      const graph = materializedDynamicScripts(result.html);
      const wrongIntegrity = `sha256-${integrityDigestForBytes(new Uint8Array([1, 2, 3]), 'sha256')}`;
      const wrongElement = {
        integrity: wrongIntegrity,
        src: loaderUrl,
        removeAttribute(name: string) {
          if (name === 'integrity') this.integrity = '';
        },
      };
      let wrongAppended: typeof wrongElement | undefined;
      const wrongHead = {
        appendChild(element: typeof wrongElement) {
          wrongAppended = element;
        },
      };
      expect(() => {
        wrongHead.appendChild(graph.prepare(loaderUrl, wrongElement));
      }).not.toThrow();
      expect(wrongAppended).toBe(wrongElement);
      expect(wrongElement.integrity).toBe(wrongIntegrity);
      expect(wrongElement.src).toBe(loaderUrl);
      expect(graph.sources.size).toBe(0);

      const correctElement = {
        integrity: '',
        src: '',
        removeAttribute(name: string) {
          if (name === 'integrity') this.integrity = '';
        },
      };
      let appended: typeof correctElement | undefined;
      runInNewContext(parentSource!, {
        __reactNativeLocalWebViewPrepareDynamicScript__: graph.prepare,
        document: {
          createElement: () => correctElement,
          head: {
            appendChild(element: typeof correctElement) {
              appended = element;
            },
          },
        },
      });
      const blobUrl = correctElement.src;
      expect(appended).toBe(correctElement);
      expect(correctElement.integrity).toBe('');
      expect(graph.sources.get(blobUrl)).toContain('data-react-native-local-webview-original-src');
    }
  );

  it('materializes cyclic dynamically assigned classic scripts with stable Blob URLs', async () => {
    const origin = 'https://dynamic-script-cycle.example';
    const firstUrl = `${origin}/scripts/a.js`;
    const secondUrl = `${origin}/scripts/b.js`;
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head></head><body><script>
        const first = document.createElement("script");
        first.src = "/scripts/a.js";
        document.head.appendChild(first);
      </script></body></html>`,
      load: loader([
        resource(
          firstUrl,
          `globalThis.aRuns = (globalThis.aRuns || 0) + 1;
           const second = document.createElement("script");
           second.src = "/scripts/b.js";
           document.head.appendChild(second);`,
          'text/javascript'
        ),
        resource(
          secondUrl,
          `globalThis.bRuns = (globalThis.bRuns || 0) + 1;
           const first = document.createElement("script");
           first.src = "/scripts/a.js";
           document.head.appendChild(first);`,
          'text/javascript'
        ),
      ]),
    });

    const graph = materializedDynamicScripts(result.html);
    expect(graph.rootIds).toContain(firstUrl);
    const firstBlobUrl = graph.materialize(firstUrl);
    const firstSource = graph.sources.get(firstBlobUrl);
    expect(firstSource).toContain('globalThis.aRuns');
    expect(firstSource).toContain(JSON.stringify(secondUrl));
    expect(firstSource).not.toContain('data:text/javascript');

    const secondBlobUrl = graph.materialize(secondUrl);
    const secondSource = graph.sources.get(secondBlobUrl);
    expect(secondSource).toContain('globalThis.bRuns');
    expect(secondSource).toContain(JSON.stringify(firstUrl));
    expect(secondSource).not.toContain('data:text/javascript');
    expect(graph.materialize(firstUrl)).toBe(firstBlobUrl);
    expect(graph.materialize(secondUrl)).toBe(secondBlobUrl);
    expect(graph.sources.size).toBe(2);
  });

  it('resolves bare imports through existing import-map imports and scopes', async () => {
    const origin = 'https://import-map.example';
    const mainUrl = `${origin}/feature/main.js`;
    const scopedUrl = `${origin}/feature/scoped.js`;
    const prefixedUrl = `${origin}/vendor/prefix/tool.js`;
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head>
        <script type="importmap">{
          "imports": {
            "pkg": "/vendor/default.js",
            "prefix/": "/vendor/prefix/"
          },
          "scopes": {
            "/feature/": {
              "pkg": "/feature/scoped.js"
            }
          }
        }</script>
        <script type="module" src="/feature/main.js"></script>
      </head><body></body></html>`,
      load: loader(
        [
          resource(
            mainUrl,
            'import value from "pkg"; import { tool } from "prefix/tool.js"; export { value, tool };',
            'text/javascript'
          ),
          resource(scopedUrl, 'export default "scoped";', 'text/javascript'),
          resource(prefixedUrl, 'export const tool = true;', 'text/javascript'),
        ],
        seen
      ),
    });

    expect(seen).toEqual(new Set([mainUrl, scopedUrl, prefixedUrl]));
    expect(result.html.match(/type="importmap"/g)).toHaveLength(1);
    const importMap = importMapFromHtml(result.html);
    expect(importMap.imports.pkg).toBe(`${origin}/vendor/default.js`);
    expect(importMap.imports['prefix/']).toBe(`${origin}/vendor/prefix/`);
    expect(importMap.scopes?.[`${origin}/feature/`]?.pkg).toBe(scopedUrl);
    const mainCode = decodeTextDataUrl(importMap.imports[mainUrl]!);
    expect(mainCode).toContain(`from "${scopedUrl}"`);
    expect(mainCode).toContain(`from "${prefixedUrl}"`);
  });

  it('rejects a static import blocked by a scoped null import-map entry', async () => {
    const origin = 'https://blocked-import-map.example';
    const mainUrl = `${origin}/feature/main.js`;

    await expect(
      localizeWebDocument({
        entryUrl: `${origin}/index.html`,
        html: `<!doctype html><html><head>
          <script type="importmap">{
            "imports": { "pkg": "/vendor/default.js" },
            "scopes": { "/feature/": { "pkg": null } }
          }</script>
          <script type="module" src="/feature/main.js"></script>
        </head><body></body></html>`,
        load: loader([
          resource(mainUrl, 'import value from "pkg"; export default value;', 'text/javascript'),
        ]),
      })
    ).rejects.toThrow(`Import map blocked "pkg" from ${mainUrl}`);
  });

  it('falls back through less-specific import-map scopes', async () => {
    const origin = 'https://scope-fallback.example';
    const mainUrl = `${origin}/feature/main.js`;
    const packageUrl = `${origin}/vendor/package.js`;
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head>
        <script type="importmap">{
          "scopes": {
            "/": { "pkg": "/vendor/package.js" },
            "/feature/": { "other": "/vendor/other.js" }
          }
        }</script>
        <script type="module" src="/feature/main.js"></script>
      </head><body></body></html>`,
      load: loader(
        [
          resource(mainUrl, 'import value from "pkg"; export default value;', 'text/javascript'),
          resource(packageUrl, 'export default "root scope";', 'text/javascript'),
        ],
        seen
      ),
    });

    expect(seen).toEqual(new Set([mainUrl, packageUrl]));
    const mainCode = decodeTextDataUrl(importMapFromHtml(result.html).imports[mainUrl]!);
    expect(mainCode).toContain(`from "${packageUrl}"`);
  });

  it('rejects import-map prefix backtracking outside the mapped target', async () => {
    const origin = 'https://prefix-backtracking.example';
    const mainUrl = `${origin}/main.js`;

    await expect(
      localizeWebDocument({
        entryUrl: `${origin}/index.html`,
        html: `<!doctype html><html><head>
          <script type="importmap">{
            "imports": { "pkg/": "/safe/" }
          }</script>
          <script type="module" src="/main.js"></script>
        </head><body></body></html>`,
        load: loader([
          resource(
            mainUrl,
            'import value from "pkg/../admin.js"; export default value;',
            'text/javascript'
          ),
        ]),
      })
    ).rejects.toThrow(`Import map blocked "pkg/../admin.js" from ${mainUrl}`);
  });

  it('keeps scoped import-map resolution for non-literal dynamic imports', async () => {
    const origin = 'https://dynamic-import-map.example';
    const mainUrl = `${origin}/feature/main.js`;
    const scopedUrl = `${origin}/feature/scoped.js`;
    const defaultUrl = `${origin}/vendor/default.js`;
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head>
        <script type="importmap">{
          "imports": { "pkg": "/vendor/default.js" },
          "scopes": { "/feature/": { "pkg": "/feature/scoped.js" } }
        }</script>
        <script type="module" src="/feature/main.js"></script>
      </head><body></body></html>`,
      load: loader([
        resource(
          mainUrl,
          'export const load = (specifier) => import(specifier);',
          'text/javascript'
        ),
      ]),
    });

    const mainCode = decodeTextDataUrl(importMapFromHtml(result.html).imports[mainUrl]!);
    expect(mainCode).toContain(scopedUrl);
    expect(mainCode).toContain(defaultUrl);
    expect(mainCode.indexOf(scopedUrl)).toBeLessThan(mainCode.indexOf(defaultUrl));
    expect(() =>
      parseJavaScript(mainCode, { ecmaVersion: 'latest', sourceType: 'module' })
    ).not.toThrow();
  });

  it('resolves punctuation-prefixed bare dynamic imports through import maps', async () => {
    const origin = 'https://prefixed-dynamic-import.example';
    const mainUrl = `${origin}/main.js`;
    const hashUrl = `${origin}/feature.js`;
    const queryUrl = `${origin}/query-feature.js`;
    const dotUrl = `${origin}/dot-feature.js`;
    const doubleDotUrl = `${origin}/double-dot-feature.js`;
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head>
        <script type="importmap">{
          "imports": {
            "#feature": "/feature.js",
            "?feature": "/query-feature.js",
            ".feature": "/dot-feature.js",
            "..feature": "/double-dot-feature.js"
          }
        }</script>
        <script type="module" src="/main.js"></script>
      </head><body></body></html>`,
      load: loader([
        resource(
          mainUrl,
          'export const load = (specifier) => import(specifier);',
          'text/javascript'
        ),
      ]),
    });

    const mainCode = decodeTextDataUrl(importMapFromHtml(result.html).imports[mainUrl]!);
    const runnable = mainCode
      .replace('export const load', 'globalThis.load')
      .replace('import(', 'globalThis.captureImport(');
    const context: Record<string, unknown> = {
      captureImport: async (specifier: string) => specifier,
      Promise: undefined,
      String,
      URL,
    };
    runInNewContext(runnable, context);
    const load = context.load as (specifier: string) => Promise<string>;
    await expect(load('#feature')).resolves.toBe(hashUrl);
    await expect(load('?feature')).resolves.toBe(queryUrl);
    await expect(load('.feature')).resolves.toBe(dotUrl);
    await expect(load('..feature')).resolves.toBe(doubleDotUrl);
  });

  it('evaluates a non-literal import source synchronously before returning its Promise', async () => {
    const origin = 'https://dynamic-import-order.example';
    const targetUrl = `${origin}/feature.js`;
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head>
        <script type="importmap">{
          "imports": { "feature": "/feature.js" }
        }</script>
        <script type="module">
          globalThis.events = [];
          const key = {
            toString() {
              events.push("toString");
              return "feature";
            }
          };
          globalThis.loaded = import((events.push("specifier"), key));
          events.push("after");
        </script>
      </head><body></body></html>`,
      load: loader([]),
    });
    const moduleCode = executableInlineScripts(result.html).find((code) =>
      code.includes('events.push("specifier")')
    );
    expect(moduleCode).toBeDefined();
    const runnable = moduleCode!.replace('import(', 'globalThis.captureImport(');
    const context: Record<string, unknown> = {
      captureImport: async (specifier: string) => specifier,
      Promise: undefined,
      String,
      URL,
    };

    runInNewContext(runnable, context);

    expect(context.events).toEqual(['specifier', 'toString', 'after']);
    await expect(context.loaded).resolves.toBe(targetUrl);
  });

  it('preserves dynamic import options and their evaluation order', async () => {
    const origin = 'https://dynamic-import-options.example';
    const targetUrl = `${origin}/feature.json`;
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head>
        <script type="importmap">{
          "imports": { "feature": "/feature.json" }
        }</script>
        <script type="module">
          globalThis.events = [];
          const key = {
            toString() {
              events.push("toString");
              return "feature";
            }
          };
          globalThis.loaded = import(
            (events.push("specifier"), key),
            (events.push("options"), { with: { type: "json" } })
          );
          events.push("after");
        </script>
      </head><body></body></html>`,
      load: loader([]),
    });
    const moduleCode = executableInlineScripts(result.html).find((code) =>
      code.includes('events.push("specifier")')
    );
    expect(moduleCode).toBeDefined();
    const runnable = moduleCode!.replace('import(', 'globalThis.captureImport(');
    const context: Record<string, unknown> = {
      captureImport: async (specifier: string, options: unknown) => ({ options, specifier }),
      Promise: undefined,
      String,
      URL,
    };

    runInNewContext(runnable, context);

    expect(context.events).toEqual(['specifier', 'options', 'toString', 'after']);
    await expect(context.loaded).resolves.toEqual({
      options: { with: { type: 'json' } },
      specifier: targetUrl,
    });
  });

  it('turns a synchronous non-literal import conversion error into a rejected Promise', async () => {
    const origin = 'https://dynamic-import-conversion.example';
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><script type="module">
        globalThis.events = [];
        globalThis.load = (specifier) => import(specifier);
      </script>`,
      load: loader([]),
    });
    const moduleCode = executableInlineScripts(result.html).find((code) =>
      code.includes('globalThis.load')
    );
    const context: Record<string, unknown> = {
      Promise: undefined,
      String,
      TypeError,
      URL,
    };
    runInNewContext(moduleCode!, context);
    const specifier = {
      toString() {
        (context.events as string[]).push('toString');
        throw new Error('conversion failed');
      },
    };
    let promise: Promise<unknown> | undefined;

    expect(() => {
      promise = (context.load as (value: unknown) => Promise<unknown>)(specifier);
      (context.events as string[]).push('after');
    }).not.toThrow();
    expect(context.events).toEqual(['toString', 'after']);
    await expect(promise).rejects.toThrow('conversion failed');
    await expect(
      (context.load as (value: unknown) => Promise<unknown>)(Symbol('invalid import'))
    ).rejects.toThrow('Cannot convert a Symbol value to a string');
  });

  it('turns a non-literal import-map resolution error into a rejected Promise', async () => {
    const origin = 'https://dynamic-import-rejection.example';
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head>
        <script type="importmap">{
          "imports": { "blocked": null }
        }</script>
        <script type="module">
          globalThis.loadUnknownSpecifier = (specifier) => import(specifier);
        </script>
      </head><body></body></html>`,
      load: loader([]),
    });
    const moduleCode = executableInlineScripts(result.html).find((code) =>
      code.includes('loadUnknownSpecifier')
    );
    expect(moduleCode).toBeDefined();
    const context: Record<string, unknown> = {
      Promise: undefined,
      String,
      TypeError,
      URL,
    };
    runInNewContext(moduleCode!, context);
    const loadUnknownSpecifier = context.loadUnknownSpecifier as (
      specifier: string
    ) => Promise<unknown>;
    let resultPromise: Promise<unknown> | undefined;

    expect(() => {
      resultPromise = loadUnknownSpecifier('blocked');
    }).not.toThrow();
    await expect(resultPromise).rejects.toThrow('Import map blocked blocked');
  });

  it('rebases document.currentScript.src in initial and dynamically assigned classic scripts', async () => {
    const origin = 'https://current-script.example';
    const loaderUrl = `${origin}/assets/loader.js`;
    const childUrl = `${origin}/child.js`;
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head>
        <script src="/assets/loader.js"></script>
      </head><body></body></html>`,
      load: loader([
        resource(
          loaderUrl,
          `globalThis.loaderSource = document.currentScript.src;
           globalThis.readLoaderSource = () => document.currentScript.src;
           globalThis.readOptionalLoaderSource = () => document.currentScript?.src;
           const child = document.createElement("script");
           child.src = "./child.js";
           document.head.appendChild(child);`,
          'text/javascript'
        ),
        resource(
          childUrl,
          'globalThis.childSource = document.currentScript?.src;',
          'text/javascript'
        ),
      ]),
    });

    const initialSource = result.html.match(
      /<script\b[^>]*\bsrc="(data:text\/javascript[^"]+)"[^>]*><\/script>/
    )?.[1];
    expect(initialSource).toBeDefined();
    const loaderCode = decodeTextDataUrl(initialSource!);
    expect(result.html).toContain(`data-react-native-local-webview-original-src="${loaderUrl}"`);
    expect(loaderCode).toContain('getAttribute("data-react-native-local-webview-original-src")');
    expect(loaderCode).not.toContain(`globalThis.loaderSource = "${loaderUrl}"`);
    expect(loaderCode).toContain('__reactNativeLocalWebViewPrepareDynamicScript__');
    expect(loaderCode).toContain(JSON.stringify(childUrl));
    const dynamicScripts = materializedDynamicScripts(result.html);
    const childSource = dynamicScripts.materialize(childUrl);
    const childCode = dynamicScripts.sources.get(childSource);
    expect(childCode).toBeDefined();
    expect(childCode).toContain(
      `setAttribute("data-react-native-local-webview-original-src", "${childUrl}")`
    );
    expect(childCode).toContain('getAttribute("data-react-native-local-webview-original-src")');
    expect(childCode).not.toContain(`globalThis.childSource = "${childUrl}"`);

    const originalSourceAttribute = 'data-react-native-local-webview-original-src';
    const currentScript = {
      getAttribute: (name: string) => (name === originalSourceAttribute ? loaderUrl : null),
      src: initialSource,
    };
    const document = {
      createElement: () => ({
        integrity: '',
        removeAttribute: () => undefined,
        src: '',
      }),
      currentScript: currentScript as typeof currentScript | null,
      head: { appendChild: () => undefined },
    };
    const context: Record<string, unknown> = {
      __reactNativeLocalWebViewMaterializeDynamicScript__: dynamicScripts.materialize,
      __reactNativeLocalWebViewPrepareDynamicScript__: dynamicScripts.prepare,
      document,
    };
    runInNewContext(loaderCode, context);
    expect(context.loaderSource).toBe(loaderUrl);
    document.currentScript = null;
    expect(() => (context.readLoaderSource as () => string)()).toThrow(
      'Cannot read properties of null'
    );
    expect((context.readOptionalLoaderSource as () => string | undefined)()).toBeUndefined();
  });

  it('retains SVG fragments across HTML, srcset, and CSS data-URL localization', async () => {
    const origin = 'https://svg-fragment.example';
    const spriteUrl = `${origin}/sprite.svg`;
    const sprite = resource(
      spriteUrl,
      '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="icon"/></svg>',
      'image/svg+xml'
    );
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head>
        <style>.icon{background-image:url("/sprite.svg#paint")}</style>
      </head><body>
        <svg><use href="/sprite.svg#icon"></use></svg>
        <img src="/sprite.svg#image" srcset="/sprite.svg#small 1x">
      </body></html>`,
      load: async (url, options) => {
        seen.add(url);
        return { ...sprite, delivery: options?.delivery ?? 'inline' };
      },
    });

    expect(seen).toEqual(
      new Set([
        `${spriteUrl}#paint`,
        `${spriteUrl}#icon`,
        `${spriteUrl}#image`,
        `${spriteUrl}#small`,
      ])
    );
    for (const fragment of ['paint', 'icon', 'image', 'small']) {
      expect(result.html).toContain(`#${fragment}`);
    }
    expect(result.html.match(/data:image\/svg\+xml;base64,/g)).toHaveLength(4);
  });

  it('keeps external CSS raw text inside an encoded data URL', async () => {
    const origin = 'https://style-raw-text.example';
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head>
        <link rel="stylesheet" href="/app.css">
      </head><body></body></html>`,
      load: loader([
        resource(
          `${origin}/app.css`,
          'body::before{content:"</StYlE><script>globalThis.injected=true</script>"}',
          'text/css'
        ),
      ]),
    });

    const stylesheetUrl = result.html.match(/<link\b[^>]*\bhref="(data:text\/css[^"]+)"/)?.[1];
    expect(stylesheetUrl).toBeDefined();
    expect(decodeTextDataUrl(stylesheetUrl!)).toContain(
      '</StYlE><script>globalThis.injected=true</script>'
    );
    expect(result.html).not.toContain('</StYlE>');
    const parsed = parse(result.html);
    let scriptCount = 0;
    const visit = (node: HtmlNode): void => {
      if ('tagName' in node && node.tagName === 'script') scriptCount += 1;
      if ('childNodes' in node) {
        for (const child of node.childNodes) visit(child);
      }
    };
    visit(parsed);
    expect(scriptCount).toBe(0);
  });

  it('replaces only a cyclic CSS import with an empty sheet and retains both rule sets', async () => {
    const origin = 'https://css-cycle.example';
    const firstUrl = `${origin}/a.css`;
    const secondUrl = `${origin}/b.css`;
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: '<!doctype html><html><head><link rel="stylesheet" href="/a.css"></head></html>',
      load: loader(
        [
          resource(firstUrl, '@import "./b.css";.from-a{color:red}', 'text/css'),
          resource(secondUrl, '@import "./a.css";.from-b{color:blue}', 'text/css'),
        ],
        seen
      ),
    });

    expect(seen).toEqual(new Set([firstUrl, secondUrl]));
    const firstDataUrl = result.html.match(/<link\b[^>]*\bhref="(data:text\/css[^"]+)"/)?.[1];
    expect(firstDataUrl).toBeDefined();
    const firstCss = decodeTextDataUrl(firstDataUrl!);
    expect(firstCss).toContain('.from-a{color:red}');
    const secondDataUrl = firstCss.match(/@import\s+["'](data:text\/css[^"']*)["']/)?.[1];
    expect(secondDataUrl).toBeDefined();
    const secondCss = decodeTextDataUrl(secondDataUrl!);
    expect(secondCss).toContain('.from-b{color:blue}');
    expect(secondCss).toContain('@import "data:text/css;charset=utf-8,"');
  });

  it('preserves stylesheet link identity, state, and presentation attributes', async () => {
    const origin = 'https://stylesheet-media.example';
    const result = await localizeWebDocument({
      entryUrl: `${origin}/`,
      html: `<!doctype html><html><head>
        <link id="print-css" class="theme" data-owner="shell" rel="stylesheet"
          href="/print.css" media="print" title="print theme" disabled>
      </head><body></body></html>`,
      load: loader([resource(`${origin}/print.css`, 'body{color:black}', 'text/css')]),
    });

    expect(result.html).toMatch(
      /<link id="print-css" class="theme" data-owner="shell" rel="stylesheet" href="data:text\/css;charset=utf-8,body%7Bcolor%3Ablack%7D" media="print" title="print theme" disabled="">/
    );
    expect(result.html).not.toContain('<style');
  });

  it('uses the first active-tree base and ignores base elements inside templates', async () => {
    const origin = 'https://document-base.example';
    const expectedUrl = `${origin}/first/hero.png`;
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/entry/index.html`,
      html: `<!doctype html><html><head>
        <template><base href="/template/"></template>
        <base href="/first/">
        <base href="/second/">
      </head><body><img src="hero.png"></body></html>`,
      load: loader([resource(expectedUrl, new Uint8Array([1, 2, 3]), 'image/png')], seen),
    });

    expect(seen).toEqual(new Set([expectedUrl]));
    expect(result.html).toContain('src="data:image/png;base64,AQID"');
  });

  it('keeps localized classic scripts external so defer and async retain their timing', async () => {
    const origin = 'https://classic.example';
    const result = await localizeWebDocument({
      entryUrl: `${origin}/`,
      html: `<!doctype html><html><head>
        <script defer src="/deferred.js"></script>
        <script async src="/async.js"></script>
      </head><body><main id="app"></main></body></html>`,
      load: loader([
        resource(`${origin}/deferred.js`, 'globalThis.deferredReady = true;', 'text/javascript'),
        resource(`${origin}/async.js`, 'globalThis.asyncReady = true;', 'text/javascript'),
      ]),
    });

    expect(result.html).toMatch(
      /<script defer="" src="data:text\/javascript;charset=utf-8,[^"]*"><\/script>/
    );
    expect(result.html).toMatch(
      /<script async="" src="data:text\/javascript;charset=utf-8,[^"]*"><\/script>/
    );
    expect(result.html).not.toContain('<script defer="">');
    expect(result.html).not.toContain('<script async="">');
  });

  it('preserves and enforces import-map integrity metadata for imported modules', async () => {
    const origin = 'https://import-map-integrity.example';
    const mainUrl = `${origin}/main.js`;
    const packageUrl = `${origin}/package.js`;
    const packageCode = 'export default "verified";';
    const packageIntegrity = sri(packageCode, 'sha384');
    const resources = new Map([
      [
        mainUrl,
        resource(mainUrl, 'import value from "pkg"; export default value;', 'text/javascript'),
      ],
      [packageUrl, resource(packageUrl, packageCode, 'text/javascript')],
    ]);
    const requestedIntegrity = new Map<string, string | undefined>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/index.html`,
      html: `<!doctype html><html><head>
        <script type="importmap">{
          "imports": { "pkg": "/package.js" },
          "integrity": { "/package.js": "${packageIntegrity}" }
        }</script>
        <script type="module" src="/main.js"></script>
      </head><body></body></html>`,
      load: async (url, options) => {
        requestedIntegrity.set(url, options?.integrity);
        const asset = resources.get(url);
        if (!asset) throw new Error(`Missing fixture resource: ${url}`);
        return { ...asset, delivery: options?.delivery ?? 'inline' };
      },
    });

    expect(requestedIntegrity.get(packageUrl)).toBe(packageIntegrity);
    expect(importMapFromHtml(result.html).integrity?.[packageUrl]).toBe(packageIntegrity);
  });

  it('rejects imported module bytes that violate import-map integrity metadata', async () => {
    const origin = 'https://import-map-integrity.example';
    const mainUrl = `${origin}/main.js`;
    const packageUrl = `${origin}/package.js`;

    await expect(
      localizeWebDocument({
        entryUrl: `${origin}/index.html`,
        html: `<!doctype html><html><head>
          <script type="importmap">{
            "imports": { "pkg": "/package.js" },
            "integrity": { "/package.js": "${sri('different bytes', 'sha512')}" }
          }</script>
          <script type="module" src="/main.js"></script>
        </head><body></body></html>`,
        load: loader([
          resource(mainUrl, 'import value from "pkg"; export default value;', 'text/javascript'),
          resource(packageUrl, 'export default "tampered";', 'text/javascript'),
        ]),
      })
    ).rejects.toThrow(`Subresource Integrity verification failed for ${packageUrl}`);
  });

  it('verifies SHA-256/384/512 metadata with strongest-algorithm semantics', async () => {
    const origin = 'https://sri.example';
    const classic = 'globalThis.classic = true;';
    const module = 'export const ready = true;';
    const css = 'body { color: rebeccapurple; }';
    const result = await localizeWebDocument({
      entryUrl: `${origin}/`,
      html: `<!doctype html><html><head>
        <script src="/classic.js" integrity="${sri(classic, 'sha256')}"></script>
        <script type="module" src="/module.js"
          integrity="sha256-invalid ${sri(module, 'sha384')}"></script>
        <link rel="modulepreload" href="/module.js"
          integrity="${sri(module, 'sha512')}">
        <link rel="stylesheet" href="/app.css"
          integrity="sha256-invalid ${sri(css, 'sha512')}">
      </head><body></body></html>`,
      load: loader([
        resource(`${origin}/classic.js`, classic, 'text/javascript'),
        resource(`${origin}/module.js`, module, 'application/javascript'),
        resource(`${origin}/app.css`, css, 'text/css'),
      ]),
    });

    expect(result.html).not.toContain('integrity=');
    expect(result.html).toContain('type="importmap"');
    expect(result.html).toContain('<link');
    expect(result.html).toContain('href="data:text/css;charset=utf-8,');
  });

  it('rejects a wrong stronger digest even when a weaker digest matches', async () => {
    const origin = 'https://sri.example';
    const module = 'export const ready = true;';

    await expect(
      localizeWebDocument({
        entryUrl: `${origin}/`,
        html: `<!doctype html><html><head>
          <script type="module" src="/module.js"
            integrity="${sri(module, 'sha256')} sha512-invalid"></script>
        </head><body></body></html>`,
        load: loader([resource(`${origin}/module.js`, module, 'text/javascript')]),
      })
    ).rejects.toThrow('Subresource Integrity verification failed');
  });

  it.each([
    {
      html: '<script src="/asset"></script>',
      mediaType: 'text/plain',
      name: 'classic script',
    },
    {
      html: '<script type="module" src="/asset"></script>',
      mediaType: 'application/octet-stream',
      name: 'module script',
    },
    {
      html: '<link rel="stylesheet" href="/asset">',
      mediaType: 'text/plain',
      name: 'stylesheet',
    },
  ])('rejects a non-executable MIME type for $name', async ({ html, mediaType }) => {
    const origin = 'https://mime.example';

    await expect(
      localizeWebDocument({
        entryUrl: `${origin}/`,
        html: `<!doctype html><html><head>${html}</head><body></body></html>`,
        load: loader([resource(`${origin}/asset`, 'export default true;', mediaType)]),
      })
    ).rejects.toThrow('invalid MIME type');
  });

  it('keeps untrusted cross-origin references on the browser network path', async () => {
    const origin = 'https://origin.example';
    const cdn = 'https://cdn.example/app.js';
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      entryUrl: `${origin}/`,
      html: `<!doctype html><html><head><script type="module" src="${cdn}"></script></head><body></body></html>`,
      load: loader([], seen),
    });

    expect(seen).toEqual(new Set());
    expect(result.html).toContain(`src="${cdn}"`);
  });

  it('localizes a cross-origin resource only when its origin is trusted', async () => {
    const origin = 'https://origin.example';
    const cdn = 'https://cdn.example/app.js';
    const seen = new Set<string>();
    const result = await localizeWebDocument({
      canLoad: (url) => new URL(url).origin === new URL(cdn).origin,
      entryUrl: `${origin}/`,
      html: `<!doctype html><html><head><script type="module" src="${cdn}"></script></head><body></body></html>`,
      load: loader([resource(cdn, 'export const ready = true;', 'text/javascript')], seen),
    });

    expect(seen).toEqual(new Set([cdn]));
    expect(result.html).toContain(`import "${cdn}"`);
    expect(result.html).not.toContain(`src="${cdn}"`);
  });

  it('rejects CSP meta removal by default and requires an explicit bypass', async () => {
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self'"></head><body></body></html>`;

    await expect(
      localizeWebDocument({
        entryUrl: 'https://csp.example/',
        html,
        load: loader([]),
      })
    ).rejects.toThrow('allowContentSecurityPolicyBypass');
    expect(prepareWebDocumentHtml(html, true)).not.toContain('Content-Security-Policy');
  });

  it('preserves inert CSP meta elements inside template contents', async () => {
    const html = `<!doctype html><html><head><template><meta http-equiv="Content-Security-Policy" content="script-src 'none'"></template></head><body></body></html>`;

    await expect(
      localizeWebDocument({
        entryUrl: 'https://template-csp.example/',
        html,
        load: loader([]),
      })
    ).resolves.toMatchObject({
      html: expect.stringContaining('Content-Security-Policy'),
    });
    expect(prepareWebDocumentHtml(html)).toContain('Content-Security-Policy');
    expect(prepareWebDocumentHtml(html, true)).toContain('Content-Security-Policy');
  });

  it('preserves CSP meta elements that browsers do not apply', async () => {
    const html = `<!doctype html><html><head>
      <meta data-case="missing" http-equiv="Content-Security-Policy">
      <meta data-case="empty" http-equiv="Content-Security-Policy" content="">
    </head><body>
      <meta data-case="body" http-equiv="Content-Security-Policy" content="script-src 'none'">
    </body></html>`;

    await expect(
      localizeWebDocument({
        entryUrl: 'https://inert-csp.example/',
        html,
        load: loader([]),
      })
    ).resolves.toMatchObject({
      html: expect.stringContaining('data-case="body"'),
    });
    const prepared = prepareWebDocumentHtml(html, true);
    expect(prepared).toContain('data-case="missing"');
    expect(prepared).toContain('data-case="empty"');
    expect(prepared).toContain('data-case="body"');
  });
});
