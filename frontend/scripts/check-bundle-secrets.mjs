#!/usr/bin/env node
/**
 * Pre-publish bundle audit.
 *
 * Runs after `vite build` and fails the build if anything that looks like a
 * credential reached the output. The deploy workflow runs the same command, so
 * a bundle carrying a secret never reaches Pages.
 *
 * This is a backstop, not the control. The control is that the backend holds
 * every credential and the frontend has no code path that would use one. A
 * scanner catches the accident — a pasted token, a `.env` copied into `public/`,
 * a dependency that inlines something — not a deliberate design mistake.
 *
 * Exit codes:  0 clean   1 findings   2 could not run
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const DIST = process.argv[2] ?? 'dist';

/**
 * Patterns are written to catch the shapes credentials actually take. Each has
 * a `name` used in the report and an optional `allow` predicate for known-safe
 * matches, so the check stays useful instead of being disabled after the first
 * false positive.
 */
const PATTERNS = [
  {
    name: 'AWS access key id',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'Google API key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    name: 'Slack token',
    regex: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g,
  },
  {
    name: 'GitHub token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[0-9A-Za-z_]{20,}\b/g,
  },
  {
    name: 'Stripe secret key',
    regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  },
  {
    name: 'Mapbox / MapTiler secret token',
    regex: /\bsk\.[0-9A-Za-z_-]{20,}\b/g,
  },
  {
    name: 'Stone device key',
    regex: /\bstk_[0-9A-Za-z_-]{40,}\b/g,
  },
  {
    name: 'Private key block',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    name: 'JSON Web Token',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    name: 'Database connection string',
    regex: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'`<>]*:[^\s"'`<>@]+@/gi,
  },
  {
    name: 'Service-account private key field',
    regex: /"private_key_id"\s*:/g,
  },
  {
    name: 'Assigned secret-looking variable',
    // A long opaque literal assigned to something named like a credential.
    regex:
      /\b(?:api[_-]?key|apikey|secret|password|passwd|token|client[_-]?secret|access[_-]?key|private[_-]?key|auth[_-]?token)\b\s*[:=]\s*["'`][A-Za-z0-9_\-./+=]{20,}["'`]/gi,
    allow: (match) =>
      // Our own non-secret identifiers and obvious placeholders.
      /csrf|x-csrf-token|placeholder|example|changeme|your[_-]?key|undefined|null/i.test(match),
  },
];

/** Extensions worth scanning. Images and fonts are skipped. */
const TEXTUAL = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.json',
  '.map',
  '.txt',
  '.svg',
  '.webmanifest',
  '',
]);

/** Files that must never appear in a published bundle at all. */
const FORBIDDEN_NAMES = [
  /^\.env(\..*)?$/i,
  /^.*\.pem$/i,
  /^.*\.p12$/i,
  /^.*\.pfx$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^service-account.*\.json$/i,
  /^credentials\.json$/i,
];

function walk(directory) {
  const entries = [];
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      entries.push(...walk(full));
    } else {
      entries.push(full);
    }
  }
  return entries;
}

function redact(value) {
  const text = String(value);
  if (text.length <= 12) return `${text.slice(0, 3)}…`;
  return `${text.slice(0, 6)}…${text.slice(-4)} (${text.length} chars)`;
}

function lineNumberOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

let files;
try {
  files = walk(DIST);
} catch (cause) {
  console.error(`\n  Cannot scan "${DIST}": ${cause.message}`);
  console.error('  Run the build first.\n');
  process.exit(2);
}

const findings = [];

for (const file of files) {
  const name = file.split(/[\\/]/).pop() ?? '';
  const relativePath = relative(process.cwd(), file);

  if (FORBIDDEN_NAMES.some((pattern) => pattern.test(name))) {
    findings.push({
      file: relativePath,
      rule: 'forbidden file in bundle',
      line: 0,
      sample: name,
    });
    continue;
  }

  if (!TEXTUAL.has(extname(name).toLowerCase())) continue;

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(content)) !== null) {
      if (pattern.allow?.(match[0])) continue;
      findings.push({
        file: relativePath,
        rule: pattern.name,
        line: lineNumberOf(content, match.index),
        sample: redact(match[0]),
      });
      // One finding per rule per file is enough to fail and to investigate.
      break;
    }
  }
}

const scanned = files.length;

if (findings.length > 0) {
  console.error('\n  Secret scan FAILED — the bundle must not be published.\n');
  for (const finding of findings) {
    console.error(`    ${finding.rule}`);
    console.error(`      ${finding.file}${finding.line ? `:${finding.line}` : ''}`);
    console.error(`      match: ${finding.sample}\n`);
  }
  console.error('  Everything in this bundle is public once deployed.');
  console.error('  Move the credential behind a backend proxy route and rotate it.\n');
  process.exit(1);
}

console.log(`  Secret scan clean — ${scanned} file(s) checked in ${DIST}.`);
