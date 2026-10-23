// Text "envelope" for invitations and replies.
//
// People move these through chat apps and email, which re-wrap lines, add
// quote markers, or apply formatting. The envelope is designed to survive that:
//   * standard base64 alphabet (A-Z a-z 0-9 + /): no "_", "*", "~", "`" that chat
//     apps interpret as formatting;
//   * whitespace, ">" quote markers and invisible characters are ignored;
//   * a checksum detects truncation and accidental corruption.
// The checksum is NOT a security mechanism (anyone can recompute it). Protection
// against deliberate tampering comes from the security-code check (see sas.js).

import {
  utf8Encode, utf8Decode, sha256, concatBytes, base64Encode, base64Decode,
  deflateRaw, inflateRawLimited, bytesEqual,
} from './util.js';

export const PROTOCOL_VERSION = 1;
export const LIMITS = {
  text: 40000, // characters accepted from paste / file
  binary: 24000, // decoded envelope bytes
  json: 32000, // decompressed JSON bytes
  file: 64 * 1024, // bytes accepted from a dropped / opened file
};

const MAGIC = [0x50, 0x43]; // "PC"
const KIND_CODES = { invite: 1, reply: 2 };
const KIND_NAMES = { 1: 'invite', 2: 'reply' };
const FLAG_DEFLATE = 1;
const CHECKSUM_LEN = 8;
const LINE = 64;

const MARKER_RE = /PrivateCall[.](invite|reply)[.]v(\d{1,3}):/gi;
const END_MARK = ':end';

export async function encodeEnvelope(kind, payloadObj, introText) {
  const code = KIND_CODES[kind];
  if (!code) throw new Error('bad kind');
  const json = utf8Encode(JSON.stringify(payloadObj));
  if (json.length > LIMITS.json) throw new Error('payload too large');
  let body = json;
  let flags = 0;
  if (typeof CompressionStream === 'function') {
    body = await deflateRaw(json);
    flags |= FLAG_DEFLATE;
  }
  const head = new Uint8Array([...MAGIC, PROTOCOL_VERSION, code, flags]);
  const unsummed = concatBytes(head, body);
  const sum = (await sha256(unsummed)).slice(0, CHECKSUM_LEN);
  const b64 = base64Encode(concatBytes(unsummed, sum));
  const lines = [];
  for (let i = 0; i < b64.length; i += LINE) lines.push(b64.slice(i, i + LINE));
  const block = `PrivateCall.${kind}.v${PROTOCOL_VERSION}:\n${lines.join('\n')}\n${END_MARK}`;
  return introText ? `${introText}\n\n${block}\n` : `${block}\n`;
}

// Returns { ok: true, kind, version, payload } or { ok: false, error }.
// Error codes are mapped to friendly messages by the UI.
export async function decodeEnvelope(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'empty' };
  if (text.length > LIMITS.text) return { ok: false, error: 'too-large' };

  MARKER_RE.lastIndex = 0;
  const matches = [...text.matchAll(MARKER_RE)];
  if (matches.length === 0) {
    if (/^\s*PCRELAY/i.test(text)) return { ok: false, error: 'is-relay-code' };
    return { ok: false, error: 'not-found' };
  }
  if (matches.length > 1) return { ok: false, error: 'multiple' };
  const m = matches[0];
  const kind = m[1].toLowerCase();
  const version = Number(m[2]);
  const start = m.index + m[0].length;
  const endIdx = text.toLowerCase().indexOf(END_MARK, start);
  if (endIdx < 0) return { ok: false, error: 'incomplete', kind };
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, error: version > PROTOCOL_VERSION ? 'version-newer' : 'version-older', kind };
  }

  // Ignore line breaks, spaces, quote markers and invisible formatting characters.
  const raw = text
    .slice(start, endIdx)
    .replace(/[\s>\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, '');
  if (!/^[A-Za-z0-9+/]*$/.test(raw)) return { ok: false, error: 'corrupt', kind };
  const bin = base64Decode(raw);
  if (!bin) return { ok: false, error: 'corrupt', kind };
  if (bin.length > LIMITS.binary) return { ok: false, error: 'too-large', kind };
  if (bin.length < 5 + CHECKSUM_LEN) return { ok: false, error: 'incomplete', kind };

  const unsummed = bin.subarray(0, bin.length - CHECKSUM_LEN);
  const sum = bin.subarray(bin.length - CHECKSUM_LEN);
  const expect = (await sha256(unsummed)).slice(0, CHECKSUM_LEN);
  if (!bytesEqual(sum, expect)) return { ok: false, error: 'corrupt', kind };

  if (bin[0] !== MAGIC[0] || bin[1] !== MAGIC[1]) return { ok: false, error: 'corrupt', kind };
  if (bin[2] !== PROTOCOL_VERSION) return { ok: false, error: 'corrupt', kind };
  if (KIND_NAMES[bin[3]] !== kind) return { ok: false, error: 'corrupt', kind };
  const flags = bin[4];
  if (flags & ~FLAG_DEFLATE) return { ok: false, error: 'corrupt', kind };

  let jsonBytes = unsummed.subarray(5);
  if (flags & FLAG_DEFLATE) {
    if (typeof DecompressionStream !== 'function') return { ok: false, error: 'browser-unsupported', kind };
    const r = await inflateRawLimited(jsonBytes, LIMITS.json);
    if (!r.ok) return { ok: false, error: r.reason === 'too-large' ? 'too-large' : 'corrupt', kind };
    jsonBytes = r.bytes;
  } else if (jsonBytes.length > LIMITS.json) {
    return { ok: false, error: 'too-large', kind };
  }

  let payload;
  try {
    payload = JSON.parse(utf8Decode(jsonBytes));
  } catch {
    return { ok: false, error: 'corrupt', kind };
  }
  return { ok: true, kind, version, payload };
}
