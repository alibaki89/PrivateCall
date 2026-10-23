// Small, dependency-free helpers shared by the core modules.
// Everything here works both in browsers and in Node >= 20 (used by unit tests).

const textEncoder = new TextEncoder();
const textDecoderStrict = new TextDecoder('utf-8', { fatal: true });

export function utf8Encode(str) {
  return textEncoder.encode(str);
}

export function utf8Decode(bytes) {
  return textDecoderStrict.decode(bytes);
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export function concatBytes(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Unambiguous encoding of a list of byte strings: 4-byte big-endian length + bytes.
// Used for every hash input so that field boundaries cannot be shifted.
export function lengthPrefixed(fields) {
  const parts = [];
  for (const f of fields) {
    const bytes = typeof f === 'string' ? utf8Encode(f) : f;
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length, false);
    parts.push(len, bytes);
  }
  return concatBytes(...parts);
}

export function bytesEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function makeReverse(alphabet) {
  const rev = new Int16Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) rev[alphabet.charCodeAt(i)] = i;
  return rev;
}
const B64_REV = makeReverse(B64);
const B64URL_REV = makeReverse(B64URL);

function encodeWith(bytes, alphabet) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63];
  }
  return out; // unpadded
}

// Strict decoder: rejects any character outside the alphabet, rejects impossible
// lengths and non-zero trailing bits (so each byte string has one encoding).
function decodeWith(str, rev) {
  if (str.length % 4 === 1) return null;
  const outLen = Math.floor((str.length * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const v = c < 128 ? rev[c] : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) return null; // non-canonical trailing bits
  return out;
}

export function base64Encode(bytes) {
  return encodeWith(bytes, B64);
}
export function base64Decode(str) {
  return decodeWith(str, B64_REV);
}
export function base64urlEncode(bytes) {
  return encodeWith(bytes, B64URL);
}
export function base64urlDecode(str) {
  return decodeWith(str, B64URL_REV);
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function wipe(bytes) {
  if (bytes instanceof Uint8Array) bytes.fill(0);
}

// Deflate (raw) with a hard cap on the decompressed size, so a crafted payload
// cannot expand into a large allocation ("zip bomb").
export async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflateRawLimited(bytes, maxOut) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  // Errors surface on the reader; swallow the writer-side duplicates.
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxOut) {
        reader.cancel().catch(() => {});
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  return { ok: true, bytes: concatBytes(...chunks) };
}
