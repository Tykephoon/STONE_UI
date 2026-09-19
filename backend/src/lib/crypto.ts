/**
 * Hashing primitives.
 *
 * SHA-256 is the only hash this service needs. Device keys and share tokens are
 * 256-bit CSPRNG output, so there is no dictionary to search and a slow KDF
 * would add latency to every ingest request while buying nothing.
 *
 * There is deliberately no password hashing here. This installation has no user
 * accounts — see SECURITY.md for what that does and does not protect.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Length-safe constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  if (bufferA.length !== bufferB.length) {
    // timingSafeEqual throws on a length mismatch. Comparing digests instead
    // keeps the comparison constant-time with respect to content.
    return timingSafeEqual(
      createHash('sha256').update(bufferA).digest(),
      createHash('sha256').update(bufferB).digest(),
    );
  }

  return timingSafeEqual(bufferA, bufferB);
}
