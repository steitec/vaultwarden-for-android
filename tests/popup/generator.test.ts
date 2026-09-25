import { describe, it, expect } from "vitest";
import {
  generatePassword,
  DEFAULT_LENGTH,
  MIN_LENGTH,
  type RandomBytes,
} from "../../src/popup/generator";

/**
 * A deterministic byte source with a real spread.
 *
 * Deliberately not a 0,1,2,... counter: twenty consecutive indices into an
 * 88-character alphabet can never span lowercase and symbols at once, so a
 * counter can never satisfy the one-of-each-class rule and would test nothing
 * but the failure path.
 */
function prng(seed: number): RandomBytes {
  let state = seed >>> 0;
  return (n) =>
    Uint8Array.from({ length: n }, () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return (state >>> 24) & 0xff;
    });
}

/** A source that yields one byte value forever. */
function constant(byte: number): RandomBytes {
  return (n) => new Uint8Array(n).fill(byte);
}

describe("generatePassword", () => {
  it("returns the requested length", () => {
    expect(generatePassword(24, prng(1))).toHaveLength(24);
    expect(generatePassword(MIN_LENGTH, prng(2))).toHaveLength(MIN_LENGTH);
  });

  it("defaults to a length worth having", () => {
    expect(DEFAULT_LENGTH).toBeGreaterThanOrEqual(16);
    expect(generatePassword(undefined, prng(3))).toHaveLength(DEFAULT_LENGTH);
  });

  it("always contains a lower, an upper, a digit and a symbol", () => {
    // Against the real random source, which is what the button uses: a site
    // demanding all four classes should accept the first password offered.
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^a-zA-Z0-9]/);
    }
  });

  it("uses only characters that survive being retyped", () => {
    // No quotes, backslash, backtick, space or angle brackets.
    for (let i = 0; i < 50; i++) {
      expect(generatePassword()).not.toMatch(/['"`\\ <>]/);
    }
  });

  it("refuses a length too short to hold one of each class", () => {
    expect(() => generatePassword(MIN_LENGTH - 1, prng(4))).toThrow(/at least/i);
  });

  it("refuses a non-integer length rather than producing a short password", () => {
    expect(() => generatePassword(20.5, prng(5))).toThrow(/at least/i);
  });

  it("discards the bytes that would bias the alphabet rather than folding them in", () => {
    // 88 characters, so 256 % 88 = 80 byte values (176..255) MUST be
    // discarded. A modulo implementation would fold 176 back to index 0 and
    // make the first 80 characters likelier — and would also quietly accept
    // this source, producing "aaaa..." and failing later for another reason.
    // The message is the discriminator: only the rejection path reports the
    // source itself as unusable.
    expect(() => generatePassword(DEFAULT_LENGTH, constant(176))).toThrow(/random source/i);
    expect(() => generatePassword(DEFAULT_LENGTH, constant(255))).toThrow(/random source/i);
  });

  it("accepts the byte just below the rejection limit", () => {
    // 175 is the last usable value. An off-by-one in the limit would reject
    // it and shrink the alphabet.
    expect(() => generatePassword(DEFAULT_LENGTH, constant(175))).not.toThrow(/random source/i);
  });

  it("draws different passwords from different random streams", () => {
    expect(generatePassword(DEFAULT_LENGTH, prng(11))).not.toBe(
      generatePassword(DEFAULT_LENGTH, prng(22)),
    );
  });

  it("is not a source of repeats: two real draws differ", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});
