import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Prefixed, URL-safe identifiers. The prefix makes IDs self-describing in logs
 * and makes it obvious when the wrong kind of ID has been passed somewhere.
 */
export type IdPrefix = 'usr' | 'ses' | 'dev' | 'rdg' | 'dsn';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32: no i, l, o, u

/** Monotonic-ish: a millisecond timestamp prefix keeps IDs roughly sortable by creation. */
export function newId(prefix: IdPrefix): string {
  const time = Date.now();
  let timePart = '';
  let remaining = time;
  for (let i = 0; i < 8; i += 1) {
    timePart = ALPHABET[remaining % 32]! + timePart;
    remaining = Math.floor(remaining / 32);
  }

  const bytes = randomBytes(10);
  let randomPart = '';
  for (const byte of bytes) {
    randomPart += ALPHABET[byte % 32]!;
  }

  return `${prefix}_${timePart}${randomPart}`;
}

export function isId(value: unknown, prefix: IdPrefix): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-z]{18}$`).test(value);
}

/** 256 bits of CSPRNG output, base64url encoded. Used for every bearer-style secret. */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export { randomUUID };
