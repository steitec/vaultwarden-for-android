const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
/**
 * No quotes, backslash, backtick, space or angle brackets.
 *
 * Not for safety — nothing here interpolates a password into anything — but
 * because those are the characters that break when the password has to be
 * retyped into a terminal, a config file, or a form that mangles them. A
 * password manager that generates something its user cannot re-enter by hand
 * has solved the wrong problem.
 */
const SYMBOLS = "!#$%&()*+,-./:;=?@[]^_{|}~";

const ALPHABET = LOWER + UPPER + DIGITS + SYMBOLS;

/** One of each, so a site demanding all four accepts the first password. */
const CLASSES = [LOWER, UPPER, DIGITS, SYMBOLS];

export const DEFAULT_LENGTH = 20;
export const MIN_LENGTH = CLASSES.length * 2;

/** Injectable, so the sampling can be tested against a known byte stream. */
export type RandomBytes = (n: number) => Uint8Array;

const fromCrypto: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/**
 * The largest multiple of the alphabet size that fits in a byte. Every byte at
 * or above it is DISCARDED, never folded in with `%`.
 *
 * Modulo over an alphabet that does not divide 256 makes the first
 * `256 % ALPHABET.length` characters likelier than the rest. A small bias, and
 * a free one to avoid — and exactly the kind of thing that is embarrassing to
 * find in a password manager two years later.
 */
const LIMIT = 256 - (256 % ALPHABET.length);

/**
 * Draws until every class is present.
 *
 * A whole re-draw rather than placing one character per class at a chosen
 * position: placing would need a second unbiased draw for the positions, and
 * this is simpler to read and to test. At twenty characters the chance of a
 * draw missing a class is under one in a thousand, so the loop effectively
 * never runs twice.
 */
export function generatePassword(
  length: number = DEFAULT_LENGTH,
  random: RandomBytes = fromCrypto,
): string {
  if (!Number.isInteger(length) || length < MIN_LENGTH) {
    throw new Error(`A generated password needs at least ${MIN_LENGTH} characters.`);
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = draw(length, random);
    if (CLASSES.every((cls) => [...candidate].some((c) => cls.includes(c)))) return candidate;
  }
  throw new Error("Could not generate a password. Try again.");
}

function draw(length: number, random: RandomBytes): string {
  let out = "";
  // Bounded rather than `while (true)`: a random source that only ever yields
  // rejected bytes has to fail loudly instead of hanging the popup. The real
  // rejection rate is 80/256, so 64 bytes per accepted character is generous
  // past the point of ever triggering by chance.
  let budget = length * 64;
  while (out.length < length) {
    for (const b of random(length)) {
      if (out.length === length) break;
      if (b < LIMIT) out += ALPHABET[b % ALPHABET.length];
      if (--budget <= 0) throw new Error("The random source produced nothing usable.");
    }
  }
  return out;
}
