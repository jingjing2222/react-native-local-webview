import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { fromByteArray, toByteArray } from 'base64-js';

function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function sha256Text(value: string): string {
  return sha256Bytes(utf8ToBytes(value));
}

export function utf8ByteLength(value: string): number {
  return utf8ToBytes(value).byteLength;
}

export function bytesToUtf8(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    if (first === undefined) break;
    if (first < 0x80) {
      result += String.fromCharCode(first);
      continue;
    }

    if (first >= 0xc2 && first <= 0xdf) {
      const second = bytes[index];
      if (second === undefined) {
        result += '\ufffd';
        continue;
      }
      if (second < 0x80 || second > 0xbf) {
        result += '\ufffd';
        continue;
      }
      index += 1;
      result += String.fromCharCode(((first & 0x1f) << 6) | (second & 0x3f));
      continue;
    }

    if (first >= 0xe0 && first <= 0xef) {
      const second = bytes[index];
      const secondMinimum = first === 0xe0 ? 0xa0 : 0x80;
      const secondMaximum = first === 0xed ? 0x9f : 0xbf;
      if (second === undefined || second < secondMinimum || second > secondMaximum) {
        result += '\ufffd';
        continue;
      }
      const third = bytes[index + 1];
      if (third === undefined) {
        result += '\ufffd';
        index += 1;
        continue;
      }
      if (third < 0x80 || third > 0xbf) {
        result += '\ufffd';
        index += 1;
        continue;
      }
      index += 2;
      result += String.fromCharCode(
        ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f)
      );
      continue;
    }

    if (first >= 0xf0 && first <= 0xf4) {
      const second = bytes[index];
      const secondMinimum = first === 0xf0 ? 0x90 : 0x80;
      const secondMaximum = first === 0xf4 ? 0x8f : 0xbf;
      if (second === undefined || second < secondMinimum || second > secondMaximum) {
        result += '\ufffd';
        continue;
      }
      const third = bytes[index + 1];
      if (third === undefined) {
        result += '\ufffd';
        index += 1;
        continue;
      }
      if (third < 0x80 || third > 0xbf) {
        result += '\ufffd';
        index += 1;
        continue;
      }
      const fourth = bytes[index + 2];
      if (fourth === undefined) {
        result += '\ufffd';
        index += 2;
        continue;
      }
      if (fourth < 0x80 || fourth > 0xbf) {
        result += '\ufffd';
        index += 2;
        continue;
      }
      index += 3;
      const codePoint =
        ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      const offset = codePoint - 0x10000;
      result += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
      continue;
    }

    result += '\ufffd';
  }
  return result.charCodeAt(0) === 0xfeff ? result.slice(1) : result;
}

export function bytesToBase64(bytes: Uint8Array): string {
  return fromByteArray(bytes);
}

export function base64ToBytes(value: string): Uint8Array {
  return toByteArray(value);
}
