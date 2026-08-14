import { describe, it, expect } from "vitest";
import { utf8, fromBase64, toBase64, concat, constantTimeEqual, zero } from "../../src/crypto/bytes";

describe("bytes", () => {
  it("round-trips base64", () => {
    const b = utf8("hello world");
    expect(toBase64(b)).toBe("aGVsbG8gd29ybGQ=");
    expect(Array.from(fromBase64("aGVsbG8gd29ybGQ="))).toEqual(Array.from(b));
  });

  it("encodes non-ascii as utf-8", () => {
    expect(Array.from(utf8("ü"))).toEqual([0xc3, 0xbc]);
  });

  it("concatenates", () => {
    const r = concat(new Uint8Array([1, 2]), new Uint8Array([3]));
    expect(Array.from(r)).toEqual([1, 2, 3]);
  });

  it("compares equal arrays as equal", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("rejects differing arrays and differing lengths", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("zeroes in place", () => {
    const b = new Uint8Array([9, 9, 9]);
    zero(b);
    expect(Array.from(b)).toEqual([0, 0, 0]);
  });
});
