import { describe, it, expect, beforeAll } from "vitest";
import { parseEncString, decryptToBytes, decryptToString, encryptToString, MacMismatchError, EncStringParseError, type SymKey } from "../../src/crypto/encstring";
import { toBase64, utf8, concat } from "../../src/crypto/bytes";

const key: SymKey = {
  encKey: new Uint8Array(32).fill(1),
  macKey: new Uint8Array(32).fill(2),
};

/** Builds a valid type-2 EncString so tests do not depend on captured fixtures. */
async function makeType2(plaintext: string): Promise<string> {
  const iv = new Uint8Array(16).fill(3);
  const ck = await crypto.subtle.importKey("raw", key.encKey, "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, utf8(plaintext)));
  const mk = await crypto.subtle.importKey("raw", key.macKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", mk, concat(iv, ct)));
  return `2.${toBase64(iv)}|${toBase64(ct)}|${toBase64(mac)}`;
}

describe("parseEncString", () => {
  it("parses a type-2 string into its three parts", async () => {
    const parsed = parseEncString(await makeType2("hello"));
    expect(parsed.type).toBe(2);
    expect(parsed.iv.length).toBe(16);
    expect(parsed.mac!.length).toBe(32);
  });

  it("rejects an unsupported type", () => {
    expect(() => parseEncString("6.aaa|bbb|ccc")).toThrow(/unsupported/i);
  });

  it("rejects a type-2 string missing its mac", () => {
    expect(() => parseEncString("2.aaa|bbb")).toThrow(/mac/i);
  });

  it("rejects a malformed string with no type prefix", () => {
    expect(() => parseEncString("not-an-encstring")).toThrow();
  });

  it("rejects type 0 (MAC-less) outright, same as any other unsupported type", () => {
    expect(() => parseEncString("0.YWFhYWFhYWFhYWFhYWFh|YmJiYmJiYmJiYmJiYmJi")).toThrow(EncStringParseError);
  });

  it("rejects a MAC-stripping downgrade from a genuine type-2 string to type 0", async () => {
    // The exact attack fixed in round 1: take a real type-2 string, rewrite
    // its prefix to 0 and drop the mac segment. This must be rejected at
    // parse time, not silently accepted as a MAC-less string and decrypted.
    const valid = await makeType2("correct horse battery staple");
    const [ivPart, ctPart] = valid.slice(2).split("|"); // strip "2." prefix; drop the trailing mac part entirely
    const downgraded = `0.${ivPart}|${ctPart}`;
    expect(() => parseEncString(downgraded)).toThrow(EncStringParseError);
  });

  it.each([
    " 2.aaa|bbb|ccc",
    "0x2.aaa|bbb|ccc",
    "+2.aaa|bbb|ccc",
    "2e0.aaa|bbb|ccc",
    ".aaa|bbb",
  ])("rejects a loosely-numeric type prefix that Number() would accept: %s", (s) => {
    expect(() => parseEncString(s)).toThrow(EncStringParseError);
  });

  it("rejects an iv of the wrong length", () => {
    const s = `2.${toBase64(new Uint8Array(8))}|${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(32))}`;
    expect(() => parseEncString(s)).toThrow(EncStringParseError);
  });

  it("rejects a mac of the wrong length", () => {
    const s = `2.${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(16))}`;
    expect(() => parseEncString(s)).toThrow(EncStringParseError);
  });

  it("rejects a ciphertext that is not a non-empty multiple of 16 bytes", () => {
    const s = `2.${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(10))}|${toBase64(new Uint8Array(32))}`;
    expect(() => parseEncString(s)).toThrow(EncStringParseError);
  });

  it("rejects an empty ciphertext", () => {
    const s = `2.${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(0))}|${toBase64(new Uint8Array(32))}`;
    expect(() => parseEncString(s)).toThrow(EncStringParseError);
  });

  it("wraps a non-base64 payload as EncStringParseError instead of leaking a raw DOMException", () => {
    expect(() => parseEncString("2.not-base64!!|bbb|ccc")).toThrow(EncStringParseError);
  });
});

describe("decrypt", () => {
  let valid: string;
  beforeAll(async () => { valid = await makeType2("correct horse battery staple"); });

  it("decrypts a valid type-2 string", async () => {
    expect(await decryptToString(parseEncString(valid), key)).toBe("correct horse battery staple");
  });

  it("returns bytes for binary payloads", async () => {
    expect((await decryptToBytes(parseEncString(valid), key)).length).toBe(28);
  });

  it("rejects a tampered ciphertext before attempting AES decryption", async () => {
    const p = parseEncString(valid);
    p.ct[0]! ^= 0xff;
    await expect(decryptToBytes(p, key)).rejects.toBeInstanceOf(MacMismatchError);
  });

  it("rejects a tampered iv", async () => {
    const p = parseEncString(valid);
    p.iv[0]! ^= 0xff;
    await expect(decryptToBytes(p, key)).rejects.toBeInstanceOf(MacMismatchError);
  });

  it("rejects a tampered mac", async () => {
    const p = parseEncString(valid);
    p.mac![0]! ^= 0xff;
    await expect(decryptToBytes(p, key)).rejects.toBeInstanceOf(MacMismatchError);
  });

  it("rejects the wrong key", async () => {
    const wrong: SymKey = { encKey: new Uint8Array(32).fill(9), macKey: new Uint8Array(32).fill(9) };
    await expect(decryptToBytes(parseEncString(valid), wrong)).rejects.toBeInstanceOf(MacMismatchError);
  });

  it("rejects invalid UTF-8 plaintext instead of silently substituting replacement characters", async () => {
    // A MAC-valid decrypt can still yield non-UTF-8 bytes (e.g. under a wrong
    // encKey paired with the right macKey, or genuinely binary data). The
    // default non-fatal TextDecoder would return U+FFFD garbage instead of
    // erroring; decryptToString must fail loudly instead.
    const iv = new Uint8Array(16).fill(3);
    const ck = await crypto.subtle.importKey("raw", key.encKey, "AES-CBC", false, ["encrypt"]);
    const invalidUtf8 = new Uint8Array(16).fill(0x80); // lone continuation bytes: never valid UTF-8
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, invalidUtf8));
    const mk = await crypto.subtle.importKey("raw", key.macKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", mk, concat(iv, ct)));
    const s = `2.${toBase64(iv)}|${toBase64(ct)}|${toBase64(mac)}`;
    await expect(decryptToString(parseEncString(s), key)).rejects.toThrow();
  });
});

describe("encryptToString", () => {
  it("round-trips through decryptToString", async () => {
    const s = await encryptToString(utf8("refresh-token-value"), key);
    expect(await decryptToString(parseEncString(s), key)).toBe("refresh-token-value");
  });

  it("produces a type-2 string with a mac", async () => {
    const parsed = parseEncString(await encryptToString(utf8("x"), key));
    expect(parsed.type).toBe(2);
    expect(parsed.mac).not.toBeNull();
  });

  it("uses a fresh iv on every call", async () => {
    const a = await encryptToString(utf8("same"), key);
    const b = await encryptToString(utf8("same"), key);
    expect(a).not.toBe(b);
  });

  it("cannot be decrypted with a different key", async () => {
    const s = await encryptToString(utf8("secret"), key);
    const other: SymKey = { encKey: new Uint8Array(32).fill(8), macKey: new Uint8Array(32).fill(7) };
    await expect(decryptToString(parseEncString(s), other)).rejects.toBeInstanceOf(MacMismatchError);
  });
});
