#!/usr/bin/env node
// For relay (TURN) operators, not end users.
//
// Creates a short-lived PrivateCall "relay code" from a coturn server that uses
// the standard time-limited credential scheme ("TURN REST API"):
//   coturn:  use-auth-secret
//            static-auth-secret=<long random secret>
//            realm=<your realm>
// The secret never leaves your machine. The code contains only a username that
// embeds an expiry time and an HMAC derived from it, so it stops working when
// it expires and cannot be used to mint new credentials.
//
// Usage:
//   PRIVATECALL_TURN_SECRET=... node tools/make-relay-code.mjs \
//     --url "turn:relay.example.org:3478?transport=udp" \
//     --url "turns:relay.example.org:443?transport=tcp" \
//     --hours 24 --label "family"
//   (or --secret-file path/to/secret instead of the environment variable;
//    never pass the secret itself on the command line, where other users of the
//    machine can see it in the process list)

import crypto from 'node:crypto';
import fs from 'node:fs';

function arg(name, multi = false) {
  const out = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--' + name && i + 1 < argv.length) out.push(argv[++i]);
  return multi ? out : out[0];
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const urls = arg('url', true);
const hours = Number(arg('hours') || '24');
const label = (arg('label') || '').slice(0, 40);
const secretFile = arg('secret-file');
const secret = secretFile ? fs.readFileSync(secretFile, 'utf8').trim() : process.env.PRIVATECALL_TURN_SECRET;

if (!secret) fail('Provide the coturn static-auth-secret via PRIVATECALL_TURN_SECRET or --secret-file.');
if (urls.length === 0) fail('Provide at least one --url turn:host:port?transport=udp');
if (urls.length > 4) fail('At most 4 URLs.');
for (const u of urls) if (!/^turns?:[A-Za-z0-9.\-[\]:]+(\?transport=(udp|tcp))?$/.test(u)) fail('Invalid TURN URL: ' + u);
if (!(hours > 0 && hours <= 24 * 7)) fail('--hours must be between 0 and 168.');

const expires = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
const username = `${expires}:${label.replace(/[^A-Za-z0-9_-]/g, '') || 'privatecall'}`;
const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');

const payload = { u: urls, n: username, c: credential, e: expires };
if (label) payload.l = label;
const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64').replace(/=+$/, '');
console.log('PCRELAY1:' + b64);
console.error(`Valid until ${new Date(expires * 1000).toISOString()}. Share it only with people you want to let use your relay.`);
