import { describe, expect, it } from 'vitest';

import { base64ToBytes, bytesToBase64, bytesToUtf8, sha256Text } from '../src/binary';

describe('binary utilities', () => {
  it('round-trips UTF-8 through base64', () => {
    const bytes = new TextEncoder().encode('안녕 🌍');

    expect(bytesToUtf8(base64ToBytes(bytesToBase64(bytes)))).toBe('안녕 🌍');
  });

  it('produces stable SHA-256 hashes', () => {
    expect(sha256Text('react-native-local-webview')).toBe(
      '1e0598d33f5189721a452a977f565f14205ea595c4558654e60003592b91a9f4'
    );
  });

  it.each([
    {
      bytes: [0xc0, 0xbc],
      expected: '\ufffd\ufffd',
      name: 'overlong encodings',
    },
    {
      bytes: [0xe2, 0x82],
      expected: '\ufffd',
      name: 'truncated sequences',
    },
    {
      bytes: [0xe2, 0x82, 0x28],
      expected: '\ufffd(',
      name: 'invalid trailing bytes',
    },
    {
      bytes: [0xed, 0xa0, 0x80],
      expected: '\ufffd\ufffd\ufffd',
      name: 'UTF-16 surrogates',
    },
    {
      bytes: [0xf4, 0x90, 0x80, 0x80],
      expected: '\ufffd\ufffd\ufffd\ufffd',
      name: 'code points above U+10FFFF',
    },
  ])('uses replacement decoding for $name', ({ bytes, expected }) => {
    expect(bytesToUtf8(Uint8Array.from(bytes))).toBe(expected);
  });

  it('does not turn overlong UTF-8 into executable HTML syntax', () => {
    const bytes = Uint8Array.from([
      0xc0,
      0xbc,
      ...new TextEncoder().encode('script>alert(1)'),
      0xc0,
      0xbc,
      ...new TextEncoder().encode('/script>'),
    ]);

    expect(bytesToUtf8(bytes)).toBe('\ufffd\ufffdscript>alert(1)\ufffd\ufffd/script>');
    expect(bytesToUtf8(bytes)).not.toContain('<script>');
  });
});
