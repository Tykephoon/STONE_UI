/**
 * Hashing and comparison primitives.
 *
 * Two different hashes are used deliberately:
 *
 *   - Argon2id for user passwords, which are low-entropy and human-chosen, so
 *     the cost parameters are the only thing standing between a database leak
 *     and a dictionary attack.
 *   - SHA-256 for session tokens and device keys, which are 256-bit CSPRNG
 *     output. There is no dictionary to search, so a slow KDF would add
 *     latency to every authenticated request and buy nothing.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';

/**
 * OWASP's second recommended Argon2id configuration (19 MiB, t=2, p=1).
 * Comfortable on a shared 256 MB Fly machine while still costly to attack.
 */
const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A precomputed hash of a value nobody knows, verified against on the
 * unknown-email login path so that "no such account" and "wrong password" take
 * the same amount of work. Without this, response timing enumerates accounts.
 */
let dummyHashPromise: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argonHash('password-that-does-not-exist', ARGON_OPTIONS);
  return dummyHashPromise;
}

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON_OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(storedHash, password);
  } catch {
    // A malformed hash in the database is a corruption problem, not a login
    // success. Fail closed.
    return false;
  }
}

/** Burn equivalent CPU on the account-does-not-exist path. */
export async function fakeVerifyPassword(password: string): Promise<false> {
  await argonVerify(await getDummyHash(), password).catch(() => false);
  return false;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Length-safe constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // timingSafeEqual throws on length mismatch. Comparing the digests instead
    // keeps the comparison constant-time with respect to content.
    return timingSafeEqual(
      createHash('sha256').update(bufferA).digest(),
      createHash('sha256').update(bufferB).digest(),
    );
  }
  return timingSafeEqual(bufferA, bufferB);
}
