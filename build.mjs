#!/usr/bin/env node
// Zero-dependency, deterministic build: src/ -> dist/PrivateCall.html
//
// The source is a handful of ES modules. Instead of a general bundler (another
// dependency to audit and pin), this script joins them in a fixed order inside a
// single function scope, which works because the modules follow strict rules
// that the script checks and enforces:
//   * imports are only `import { a, b } from './x.js';` of earlier modules;
//   * exports are only `export function|async function|const|let|class name`;
//   * no two modules declare the same top-level name; no dynamic import/require.
// It then inlines CSS and JS into the HTML, computes the Content-Security-Policy
// hashes, and writes a SHA-256 checksum file. The output is not minified, so
// anyone can read exactly what they are running ("View source").
//
// Usage: node build.mjs [--check]   (--check: verify dist/ is up to date)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const ORDER = ['util', 'codec', 'sdp', 'protocol', 'sas', 'ice', 'gather', 'media', 'session', 'i18n', 'main'];

function die(msg) {
  console.error('build error: ' + msg);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) die('bad version in package.json');

const exportsOf = new Map();
const topLevel = new Map();
const chunks = [];

for (const [index, name] of ORDER.entries()) {
  const file = path.join(SRC, 'app', name + '.js');
  let code = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

  if (/\bimport\s*\(/.test(code) || /\brequire\s*\(/.test(code)) die(`${name}.js: dynamic import/require is not allowed`);
  if (/<\/script/i.test(code)) die(`${name}.js: contains "</script"`);

  // Imports
  const importRe = /^import\s*\{([^}]*)\}\s*from\s*'\.\/([\w-]+)\.js';[ \t]*$/gm;
  for (const m of code.matchAll(importRe)) {
    const from = m[2];
    const fromIndex = ORDER.indexOf(from);
    if (fromIndex < 0) die(`${name}.js imports unknown module ${from}`);
    if (fromIndex >= index) die(`${name}.js imports ${from}, which must come earlier in ORDER`);
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      if (!/^\w+$/.test(n)) die(`${name}.js: unsupported import form "${n}"`);
      if (!exportsOf.get(from).has(n)) die(`${name}.js imports ${n}, not exported by ${from}.js`);
    }
  }
  code = code.replace(importRe, '');
  if (/^import\b/m.test(code)) die(`${name}.js: unsupported import statement`);

  // Exports
  const exported = new Set();
  code = code.replace(/^export (async function|function|const|let|class) (\w+)/gm, (all, kind, id) => {
    exported.add(id);
    return `${kind} ${id}`;
  });
  if (/^export\b/m.test(code)) die(`${name}.js: unsupported export statement`);
  exportsOf.set(name, exported);

  // Top-level names must be unique across modules.
  for (const m of code.matchAll(/^(?:async\s+function|function|const|let|var|class)\s+(\w+)/gm)) {
    const id = m[1];
    if (topLevel.has(id)) die(`top-level name "${id}" declared in both ${topLevel.get(id)}.js and ${name}.js`);
    topLevel.set(id, name);
  }

  chunks.push(`// ---- ${name}.js ----\n${code.trim()}\n`);
}

const script = `\n(() => {\n'use strict';\n${chunks.join('\n')}\n})();\n`;
const style = '\n' + fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
if (/<\/style/i.test(style)) die('styles.css contains "</style"');

const hash = (s) => "'sha256-" + crypto.createHash('sha256').update(s, 'utf8').digest('base64') + "'";
const csp = [
  "default-src 'none'",
  `script-src ${hash(script)}`,
  `style-src ${hash(style)}`,
  'img-src data:',
  "media-src 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const fill = (key, value) => {
  const token = `{{${key}}}`;
  if (!html.includes(token)) die(`template is missing ${token}`);
  html = html.split(token).join(value); // no regex: "$" in content must stay literal
};
fill('SCRIPT', script);
fill('STYLE', style);
fill('CSP', csp);
fill('VERSION', VERSION);
if (/\{\{\w+\}\}/.test(html)) die('unfilled template token');

const outFile = path.join(DIST, 'PrivateCall.html');
const digest = crypto.createHash('sha256').update(html, 'utf8').digest('hex');
const sums = `${digest}  PrivateCall.html\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  if (current !== html) die('dist/PrivateCall.html is out of date; run node build.mjs');
  console.log('dist is up to date: ' + digest);
} else {
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(outFile, html);
  fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), sums);
  console.log(`PrivateCall ${VERSION}: ${outFile} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
  console.log(`SHA-256 ${digest}`);
}
