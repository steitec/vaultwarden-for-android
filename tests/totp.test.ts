import { describe, it, expect } from "vitest";
import { parseTotpSecret, generateTotp } from "../src/totp";

const B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("parseTotpSecret", () => {
  it("decodes a bare base32 secret with defaults", () => {
    const p = parseTotpSecret(B32);
    expect(new TextDecoder().decode(p.secret)).toBe("12345678901234567890");
    expect(p.digits).toBe(6);
    expect(p.period).toBe(30);
    expect(p.algorithm).toBe("SHA-1");
  });

  it("tolerates lowercase, spaces, and padding", () => {
    const p = parseTotpSecret("gezd gnbv gy3t qojq gezd gnbv gy3t qojq====");
    expect(new TextDecoder().decode(p.secret)).toBe("12345678901234567890");
  });

  it("parses an otpauth URI with custom parameters", () => {
    const p = parseTotpSecret(`otpauth://totp/Example:a@b.com?secret=${B32}&digits=8&period=60&algorithm=SHA256`);
    expect(p.digits).toBe(8);
    expect(p.period).toBe(60);
    expect(p.algorithm).toBe("SHA-256");
  });

  it("rejects an otpauth URI with no secret", () => {
    expect(() => parseTotpSecret("otpauth://totp/Example:a@b.com?digits=6")).toThrow(/secret/i);
  });

  it("rejects invalid base32", () => {
    expect(() => parseTotpSecret("not-base32!!")).toThrow();
  });
});

describe("generateTotp", () => {
  it("matches RFC 6238 SHA-1 vectors", async () => {
    expect((await generateTotp(B32, 59_000)).code).toBe("287082");
    expect((await generateTotp(B32, 1111111109_000)).code).toBe("081804");
    expect((await generateTotp(B32, 1234567890_000)).code).toBe("005924");
  });

  it("reports seconds remaining in the current window", async () => {
    expect((await generateTotp(B32, 0)).secondsRemaining).toBe(30);
    expect((await generateTotp(B32, 25_000)).secondsRemaining).toBe(5);
  });

  it("produces a code of the requested length", async () => {
    const uri = `otpauth://totp/x?secret=${B32}&digits=8`;
    expect((await generateTotp(uri, 59_000)).code).toHaveLength(8);
  });
});
