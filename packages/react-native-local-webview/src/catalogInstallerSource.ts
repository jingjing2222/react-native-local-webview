export const DYNAMIC_SCRIPT_CATALOG_INSTALLER_SOURCE = String.raw`
function installDynamicScriptCatalog(catalog) {
  const materializerName = '__reactNativeLocalWebViewMaterializeDynamicScript__';
  const preparerName = '__reactNativeLocalWebViewPrepareDynamicScript__';
  const stateName = '__reactNativeLocalWebViewDynamicScriptMaterializerState__';
  const scope = globalThis;
  const existing = scope[stateName];
  if (existing?.catalogId === catalog.id && scope[materializerName] && scope[preparerName]) return;

  const urls = new Map();
  const canonicalBase64 = (value) => {
    const unpadded = String(value).replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '');
    if (unpadded.length % 4 === 1) return null;
    const padded = unpadded.padEnd(unpadded.length + ((4 - (unpadded.length % 4)) % 4), '=');
    try {
      return globalThis.btoa(globalThis.atob(padded));
    } catch {
      return null;
    }
  };
  const verifyElementIntegrity = (node, element) => {
    const metadata =
      typeof element.integrity === 'string'
        ? element.integrity
        : (element.getAttribute?.('integrity') ?? '');
    const candidates = String(metadata)
      .trim()
      .split(/[\t\n\f\r ]+/)
      .flatMap((token) => {
        const match = token.match(
          /^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})(?:\?[^\s]*)?$/
        );
        return match ? [{ algorithm: match[1], digest: match[2] }] : [];
      });
    const strength = { sha256: 1, sha384: 2, sha512: 3 };
    const strongest = candidates.reduce(
      (current, candidate) =>
        !current || strength[candidate.algorithm] > strength[current]
          ? candidate.algorithm
          : current,
      null
    );
    if (String(metadata).trim() && !strongest) return false;
    if (strongest) {
      const actual = canonicalBase64(node.integrity[strongest]);
      const matches =
        actual !== null &&
        candidates
          .filter((candidate) => candidate.algorithm === strongest)
          .some((candidate) => canonicalBase64(candidate.digest) === actual);
      if (!matches) return false;
    }
    element.removeAttribute?.('integrity');
    if (typeof element.integrity === 'string') element.integrity = '';
    return true;
  };
  const materialize = (id, element) => {
    const node = catalog.nodes[id];
    if (node === undefined) throw new Error('Unknown localized dynamic script: ' + id);
    if (element && !verifyElementIntegrity(node, element)) return id;
    const cached = urls.get(id);
    if (cached) return cached;
    const url = globalThis.URL.createObjectURL(
      new globalThis.Blob([node.code], { lastModified: 0, type: 'text/javascript' })
    );
    urls.set(id, url);
    return url;
  };
  scope[stateName] = { catalogId: catalog.id, urls };
  scope[materializerName] = materialize;
  scope[preparerName] = (id, element) => {
    element.src = materialize(id, element);
    return element;
  };
}
`;

export const WORKER_CATALOG_INSTALLER_SOURCE = String.raw`
function installWorkerCatalog(catalog, installerDefinition) {
  const materializerName = '__reactNativeLocalWebViewMaterializeWorker__';
  const registerModuleName = '__reactNativeLocalWebViewRegisterWorkerModule__';
  const stateName = '__reactNativeLocalWebViewWorkerMaterializerState__';
  const scope = globalThis;
  const existing = scope[stateName];
  if (existing?.catalogId === catalog.id && scope[materializerName] && scope[registerModuleName]) {
    return;
  }

  const urls = new Map();
  const bootstrapUrls = new Map();
  const installerSource =
    '(' +
    installerDefinition +
    ')(' +
    JSON.stringify(catalog) +
    ',' +
    JSON.stringify(installerDefinition) +
    ')';
  const helperUrl = globalThis.URL.createObjectURL(
    new globalThis.Blob([installerSource], { lastModified: 0, type: 'text/javascript' })
  );
  const materialize = (id) => {
    const existingUrl = urls.get(id);
    if (existingUrl) return existingUrl;
    const visiting = new Set();
    const stack = [{ expanded: false, id }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (urls.has(frame.id)) {
        visiting.delete(frame.id);
        stack.pop();
        continue;
      }
      const node = catalog.nodes[frame.id];
      if (!node) throw new Error('Unknown localized Worker module: ' + frame.id);
      if (!frame.expanded) {
        if (visiting.has(frame.id)) {
          throw new Error('Localized Worker graph still contains a cycle at: ' + frame.id);
        }
        visiting.add(frame.id);
        frame.expanded = true;
        const dependencies = [...new Set(Object.values(node.links))];
        for (let index = dependencies.length - 1; index >= 0; index -= 1) {
          const dependencyId = dependencies[index];
          if (visiting.has(dependencyId)) {
            throw new Error('Localized Worker graph still contains a cycle at: ' + dependencyId);
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
          throw new Error('Localized Worker dependency was not materialized: ' + dependencyId);
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
        code =
          imports.map((url) => 'import ' + JSON.stringify(url) + ';').join('\n') +
          '\nglobalThis[' +
          JSON.stringify(registerModuleName) +
          '](' +
          JSON.stringify(frame.id) +
          ', import.meta.url);\n' +
          code;
      } else {
        code =
          'importScripts(' +
          JSON.stringify(helperUrl) +
          ');\n' +
          (node.bootstrap ?? '') +
          '\n' +
          code;
      }
      const url = globalThis.URL.createObjectURL(
        new globalThis.Blob([code], { lastModified: 0, type: 'text/javascript' })
      );
      urls.set(frame.id, url);
      visiting.delete(frame.id);
      stack.pop();
    }
    return urls.get(id);
  };
  scope[stateName] = { catalogId: catalog.id, helperUrl, urls };
  scope[materializerName] = materialize;
  scope[registerModuleName] = (id, url) => {
    urls.set(id, url);
  };
}
`;
