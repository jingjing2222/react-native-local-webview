import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'a51cd1340075d61d3d3b22d96ad6f2bc8bfabeaf';
const SOURCE = `https://raw.githubusercontent.com/rishavnathpati/W-O-R-D-L-Y/${COMMIT}/Build`;
const CACHE_DIRECTORY = fileURLToPath(new URL('../../.cache/unity-wordly/', import.meta.url));

const files = {
  'Builds.data': {
    sha256: '89fb6078255ae751cb254dca33413af8e5a3f5ef5c41501aa14452dcae57e171',
    size: 8_388_251,
  },
  'Builds.framework.js': {
    sha256: '49eb8ab27c59423eb1229599b7024e6f4f537bb3727e10294f876995b303dae4',
    size: 1_213_496,
  },
  'Builds.loader.js': {
    sha256: '23b0099bf4ddb672abd61b54ff2054e75837f4ef948611c67744be0e1b7a6055',
    size: 31_017,
  },
  'Builds.wasm': {
    sha256: 'f878213da94aff20530d69706aba55abb9786f4940fa9f14d6145311106c7afd',
    size: 21_498_869,
  },
};

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function isValid(path, expected) {
  try {
    const bytes = await readFile(path);
    return bytes.byteLength === expected.size && digest(bytes) === expected.sha256;
  } catch {
    return false;
  }
}

export async function prepareUnityFixture() {
  await mkdir(CACHE_DIRECTORY, { recursive: true });
  for (const [name, expected] of Object.entries(files)) {
    const destination = join(CACHE_DIRECTORY, name);
    if (await isValid(destination, expected)) continue;

    const response = await fetch(`${SOURCE}/${name}`, {
      headers: { 'Accept-Encoding': 'identity' },
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`Failed to download Unity fixture ${name}: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== expected.size || digest(bytes) !== expected.sha256) {
      throw new Error(`Unity fixture integrity mismatch: ${name}`);
    }
    const temporary = `${destination}.${process.pid}.next`;
    await mkdir(dirname(temporary), { recursive: true });
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
  }
  return CACHE_DIRECTORY;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = await prepareUnityFixture();
  process.stdout.write(`${directory}\n`);
}
