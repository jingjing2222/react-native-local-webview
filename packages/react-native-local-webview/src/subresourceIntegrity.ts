import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { fromByteArray, toByteArray } from 'base64-js';

export type SubresourceIntegrityAlgorithm = 'sha256' | 'sha384' | 'sha512';

export type SubresourceIntegrityDigests = Partial<Record<SubresourceIntegrityAlgorithm, string>>;

type IntegrityCandidate = {
  algorithm: SubresourceIntegrityAlgorithm;
  digest: string;
};

const ALGORITHM_STRENGTH: Record<SubresourceIntegrityAlgorithm, number> = {
  sha256: 1,
  sha384: 2,
  sha512: 3,
};

function candidates(metadata: string | undefined): IntegrityCandidate[] {
  if (!metadata) return [];
  return metadata
    .trim()
    .split(/[\t\n\f\r ]+/)
    .flatMap((token): IntegrityCandidate[] => {
      const match = token.match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})(?:\?[^\s]*)?$/);
      if (!match) return [];
      return [
        {
          algorithm: match[1] as SubresourceIntegrityAlgorithm,
          digest: match[2]!,
        },
      ];
    });
}

function canonicalBase64(value: string): string | undefined {
  const unpadded = value.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return undefined;
  const padded = unpadded.padEnd(unpadded.length + ((4 - (unpadded.length % 4)) % 4), '=');
  try {
    return fromByteArray(toByteArray(padded));
  } catch {
    return undefined;
  }
}

export function strongestIntegrityAlgorithm(
  metadata: string | undefined
): SubresourceIntegrityAlgorithm | undefined {
  return candidates(metadata).reduce<SubresourceIntegrityAlgorithm | undefined>(
    (strongest, candidate) =>
      !strongest || ALGORITHM_STRENGTH[candidate.algorithm] > ALGORITHM_STRENGTH[strongest]
        ? candidate.algorithm
        : strongest,
    undefined
  );
}

export function integrityDigestForBytes(
  bytes: Uint8Array,
  algorithm: SubresourceIntegrityAlgorithm
): string {
  if (algorithm === 'sha256') return fromByteArray(sha256(bytes));
  if (algorithm === 'sha384') return fromByteArray(sha384(bytes));
  return fromByteArray(sha512(bytes));
}

export function hexDigestToBase64(value: string): string {
  if (!/^(?:[a-fA-F0-9]{2})+$/.test(value)) {
    throw new Error('Digest must be an even-length hexadecimal string');
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return fromByteArray(bytes);
}

export function verifySubresourceIntegrity({
  bytes,
  digests = {},
  metadata,
  url,
}: {
  bytes?: Uint8Array;
  digests?: SubresourceIntegrityDigests;
  metadata?: string;
  url: string;
}): void {
  const parsed = candidates(metadata);
  const strongest = strongestIntegrityAlgorithm(metadata);
  if (!strongest) return;
  const actual =
    digests[strongest] ?? (bytes ? integrityDigestForBytes(bytes, strongest) : undefined);
  if (!actual) {
    throw new Error(`Cannot verify ${strongest} Subresource Integrity for ${url}`);
  }
  const canonicalActual = canonicalBase64(actual);
  const matches = parsed
    .filter((candidate) => candidate.algorithm === strongest)
    .some((candidate) => canonicalBase64(candidate.digest) === canonicalActual);
  if (!matches) {
    throw new Error(`Subresource Integrity verification failed for ${url}`);
  }
}
