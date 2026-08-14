import { describe, it, expect, beforeAll } from "vitest";
import { splitSymKey, unwrapUserKey, unwrapPrivateKey, unwrapOrgKey, unwrapCipherKey, KeyUnwrapError } from "../../src/crypto/keys";
import { type SymKey, EncStringParseError } from "../../src/crypto/encstring";
import { stretchMasterKey } from "../../src/crypto/kdf";
import { toBase64, concat, type Bytes } from "../../src/crypto/bytes";

async function generateRsaKeyPair() {
  return crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true,
    ["encrypt", "decrypt"],
  );
}

async function wrapType2(plaintext: Bytes, key: SymKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ck = await crypto.subtle.importKey("raw", key.encKey, "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, plaintext));
  const mk = await crypto.subtle.importKey("raw", key.macKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", mk, concat(iv, ct)));
  return `2.${toBase64(iv)}|${toBase64(ct)}|${toBase64(mac)}`;
}

describe("splitSymKey", () => {
  it("splits 64 bytes into enc and mac halves", () => {
    const raw = new Uint8Array(64);
    raw.fill(1, 0, 32);
    raw.fill(2, 32, 64);
    const k = splitSymKey(raw);
    expect(k.encKey.every((b) => b === 1)).toBe(true);
    expect(k.macKey.every((b) => b === 2)).toBe(true);
  });

  it("rejects a wrong-sized key", () => {
    expect(() => splitSymKey(new Uint8Array(32))).toThrow(/64/);
  });
});

describe("unwrapUserKey", () => {
  it("unwraps a user key wrapped under the stretched master key", async () => {
    const masterKey = new Uint8Array(32).fill(5);
    const stretched = await stretchMasterKey(masterKey);
    const userKeyRaw = crypto.getRandomValues(new Uint8Array(64));
    const wrapped = await wrapType2(userKeyRaw, stretched);

    const userKey = await unwrapUserKey(wrapped, masterKey);
    expect(toBase64(concat(userKey.encKey, userKey.macKey))).toBe(toBase64(userKeyRaw));
  });

  it("fails on the wrong master password", async () => {
    const stretched = await stretchMasterKey(new Uint8Array(32).fill(5));
    const wrapped = await wrapType2(crypto.getRandomValues(new Uint8Array(64)), stretched);
    await expect(unwrapUserKey(wrapped, new Uint8Array(32).fill(6))).rejects.toThrow();
  });
});

describe("RSA org key path", () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let otherPrivateKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateRsaKeyPair();
    const otherPair = await generateRsaKeyPair();
    publicKey = pair.publicKey;
    otherPrivateKey = otherPair.privateKey;

    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const userKey: SymKey = {
      encKey: new Uint8Array(32).fill(1),
      macKey: new Uint8Array(32).fill(2),
    };
    const wrappedPrivate = await wrapType2(pkcs8, userKey);
    privateKey = await unwrapPrivateKey(wrappedPrivate, userKey);
  });

  it("unwraps an org key through the RSA private key", async () => {
    const orgKeyRaw = crypto.getRandomValues(new Uint8Array(64));
    const orgCt = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, orgKeyRaw));
    const orgKey = await unwrapOrgKey(`4.${toBase64(orgCt)}`, privateKey);

    expect(toBase64(concat(orgKey.encKey, orgKey.macKey))).toBe(toBase64(orgKeyRaw));
  });

  it("rejects a type-2 string routed through unwrapOrgKey", async () => {
    const parent: SymKey = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) };
    const type2 = await wrapType2(new Uint8Array(64), parent);
    await expect(unwrapOrgKey(type2, privateKey)).rejects.toThrow(EncStringParseError);
  });

  it("rejects the wrong RSA private key with KeyUnwrapError, not a raw platform error", async () => {
    const orgKeyRaw = crypto.getRandomValues(new Uint8Array(64));
    const orgCt = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, orgKeyRaw));
    await expect(unwrapOrgKey(`4.${toBase64(orgCt)}`, otherPrivateKey)).rejects.toBeInstanceOf(KeyUnwrapError);
  });

  it("rejects a decrypted plaintext of the wrong length", async () => {
    // 10 bytes, not 64: RSA-OAEP happily decrypts it, but it can't be a
    // valid enc+mac key pair. splitSymKey must reject it, not silently
    // truncate or pad.
    const shortRaw = crypto.getRandomValues(new Uint8Array(10));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, shortRaw));
    await expect(unwrapOrgKey(`4.${toBase64(ct)}`, privateKey)).rejects.toThrow(/64/);
  });

  it("rejects a type-4 string with extra |-separated parts instead of silently discarding them", async () => {
    const orgKeyRaw = crypto.getRandomValues(new Uint8Array(64));
    const orgCt = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, orgKeyRaw));
    await expect(unwrapOrgKey(`4.${toBase64(orgCt)}|AAAA|BBBB`, privateKey)).rejects.toThrow(EncStringParseError);
  });

  it("wraps invalid base64 ciphertext as EncStringParseError instead of a raw DOMException", async () => {
    await expect(unwrapOrgKey("4.!!!!", privateKey)).rejects.toThrow(EncStringParseError);
    await expect(unwrapOrgKey("4.A", privateKey)).rejects.toThrow(EncStringParseError);
  });

  it("rejects a string with no type prefix", async () => {
    await expect(unwrapOrgKey("not-an-encstring", privateKey)).rejects.toThrow(EncStringParseError);
  });

  it.each([
    " 4.aaa",
    "04.aaa",
    "+4.aaa",
    "4e0.aaa",
    "0x4.aaa",
    "４.aaa", // fullwidth digit 4
    "٤.aaa", // Arabic-Indic digit 4
    "2.aaa|bbb|ccc",
  ])("rejects a loosely-numeric or wrong type prefix that Number() would accept: %s", async (s) => {
    await expect(unwrapOrgKey(s, privateKey)).rejects.toThrow(EncStringParseError);
  });
});

describe("unwrapCipherKey", () => {
  const parent: SymKey = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) };

  it("returns the parent key when the cipher has no key of its own", async () => {
    const k = await unwrapCipherKey(null, parent);
    expect(toBase64(k.encKey)).toBe(toBase64(parent.encKey));
    // Deliberate aliasing, not a copy: see the doc comment on
    // unwrapCipherKey. A future zeroing of a "per-cipher" key here would
    // otherwise silently destroy the parent key.
    expect(k).toBe(parent);
  });

  it("returns the parent key when the cipher key field is undefined (an omitted field in server JSON)", async () => {
    const k = await unwrapCipherKey(undefined, parent);
    expect(k).toBe(parent);
  });

  it("unwraps a per-cipher key when present", async () => {
    const cipherKeyRaw = crypto.getRandomValues(new Uint8Array(64));
    const wrapped = await wrapType2(cipherKeyRaw, parent);
    const k = await unwrapCipherKey(wrapped, parent);
    expect(toBase64(concat(k.encKey, k.macKey))).toBe(toBase64(cipherKeyRaw));
    expect(toBase64(k.encKey)).not.toBe(toBase64(parent.encKey));
  });

  it("rejects a type-4 string routed through unwrapCipherKey", async () => {
    await expect(unwrapCipherKey("4.AAAA", parent)).rejects.toThrow(EncStringParseError);
  });
});
