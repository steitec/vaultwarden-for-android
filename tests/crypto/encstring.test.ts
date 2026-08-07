import { describe, it, expect, beforeAll } from "vitest";
import { parseEncString, decryptToBytes, decryptToString, encryptToString, MacMismatchError, type SymKey } from "../../src/crypto/encstring";
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
