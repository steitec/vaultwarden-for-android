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

describe("parseTotpSecret parameter validation", () => {
  // Bare `Number()` on these two took anything: "" became 0, "abc" became
  // NaN, and both flowed into the generator. The assertions below are on the
  // PARSE throwing, deliberately — a `period` of 0 does eventually blow up in
  // `BigInt(Infinity)`, but a RangeError from deep inside the code generator
  // names neither the URI nor the parameter, and `digits=""` never blows up
  // at all: it quietly answers "0" for every account at every timestep.
  const uri = (params: string): string => `otpauth://totp/Example:a@b.com?secret=${B32}&${params}`;

  it("rejects a period of zero rather than dividing by it", () => {
    expect(() => parseTotpSecret(uri("period=0"))).toThrow(/period/i);
    expect(() => parseTotpSecret(uri("period=0"))).not.toThrow(RangeError);
  });

  it("rejects a period that is not a positive whole number of seconds", () => {
    for (const bad of ["-30", "30.5", "abc", "", "1e2", " 30", "Infinity", "NaN"]) {
      expect(() => parseTotpSecret(uri(`period=${bad}`))).toThrow(/period/i);
    }
  });

  it("rejects digits that would produce a code no server can accept", () => {
    for (const bad of ["", "0", "abc", "-6", "6.5", "1", "5", "11", "1e1"]) {
      expect(() => parseTotpSecret(uri(`digits=${bad}`))).toThrow(/digits/i);
    }
  });

  it("accepts the digit and period lengths issuers actually emit", () => {
    expect(parseTotpSecret(uri("digits=6")).digits).toBe(6);
    expect(parseTotpSecret(uri("digits=7")).digits).toBe(7);
    expect(parseTotpSecret(uri("digits=8")).digits).toBe(8);
    expect(parseTotpSecret(uri("period=30")).period).toBe(30);
    expect(parseTotpSecret(uri("period=60")).period).toBe(60);
    expect(parseTotpSecret(uri("period=15")).period).toBe(15);
  });

  it("keeps the defaults when the parameters are absent altogether", () => {
    // Absent is not malformed: an otpauth URI with no digits/period is the
    // common case and means 6 and 30.
    const p = parseTotpSecret(`otpauth://totp/Example:a@b.com?secret=${B32}`);
    expect(p.digits).toBe(6);
    expect(p.period).toBe(30);
  });

  it("does not quote the rejected secret or algorithm back in the message either", () => {
    // These two predate the digits/period work and are the same hazard. The
    // realistic route is a shared organization item: its fields are set by an
    // org admin, it decrypts under an org key rather than the user's own, and
    // whatever it says lands in a popup message. renderMessage uses
    // textContent so this is not XSS — it is the class src/popup/errors.ts
    // already refuses to render for `.cause.message`, and the answer is the
    // same one: say what is wrong, do not repeat the value.
    expect(() => parseTotpSecret("AB%CD")).toThrow(/base32/i);
    expect(() => parseTotpSecret("AB%CD")).not.toThrow(/%/);

    const payload = "<img src=x onerror=alert(1)>";
    const uri = `otpauth://totp/x?secret=${B32}&algorithm=${encodeURIComponent(payload)}`;
    expect(() => parseTotpSecret(uri)).toThrow(/algorithm/i);
    // The whole parameter, not one character of it: this was the worse of the
    // two.
    expect(() => parseTotpSecret(uri)).not.toThrow(/onerror|img/i);
  });

  it("does not quote the rejected value back in the message", () => {
    // The URI comes out of the vault, which means it came from the server as
    // ciphertext the popup will render the message for. Naming the parameter
    // is enough to fix the entry; echoing its contents would put
    // server-controlled text on screen for no diagnostic gain.
    const evil = "%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E";
    expect(() => parseTotpSecret(uri(`period=${evil}`))).toThrow(/period/i);
    expect(() => parseTotpSecret(uri(`period=${evil}`))).not.toThrow(/onerror/);
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

  it("refuses a malformed period instead of failing inside the counter", async () => {
    // `Math.floor(seconds / 0)` is Infinity and `BigInt(Infinity)` throws a
    // RangeError from the middle of the HMAC setup. The rejection has to name
    // the parameter, because that is the only thing the user can act on.
    await expect(generateTotp(`otpauth://totp/x?secret=${B32}&period=0`, 59_000)).rejects.toThrow(
      /period/i,
    );
  });

  it("refuses malformed digits instead of answering with a one-character code", async () => {
    // `Number("")` is 0, and `String(n % 10 ** 0).padStart(0, "0")` is the
    // literal "0" — a TOTP field that looks filled in and can never work.
    await expect(generateTotp(`otpauth://totp/x?secret=${B32}&digits=`, 59_000)).rejects.toThrow(
      /digits/i,
    );
  });
});
