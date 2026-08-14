/**
 * A concretely `ArrayBuffer`-backed byte array — the type WebCrypto's
 * `BufferSource` parameters (and other strict DOM byte-buffer APIs) require.
 * Bare `Uint8Array` defaults to `Uint8Array<ArrayBufferLike>`, which also
 * admits `SharedArrayBuffer` and is therefore no longer assignable to
 * `BufferSource` under TypeScript 5.7+'s generic typed arrays.
 *
 * Every crypto-module function that produces or consumes a byte array
 * destined for `crypto.subtle.*` (or any similarly strict Web API) should be
 * typed with `Bytes`, not plain `Uint8Array`, so the concrete buffer type
 * flows through call sites without casts.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export function utf8(s: string): Bytes {
  return new TextEncoder().encode(s);
}

export function fromBase64(s: string): Bytes {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]!);
  return btoa(bin);
}

export function concat(...parts: Uint8Array[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Length-independent comparison. Returns false for differing lengths without
 * leaking where the difference is via early exit on content.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function zero(b: Uint8Array): void {
  b.fill(0);
}
