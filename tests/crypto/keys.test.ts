import { describe, it, expect } from "vitest";
import { splitSymKey, unwrapUserKey, unwrapPrivateKey, unwrapOrgKey, unwrapCipherKey } from "../../src/crypto/keys";
import { type SymKey } from "../../src/crypto/encstring";
import { stretchMasterKey } from "../../src/crypto/kdf";
import { toBase64, concat, utf8, type Bytes } from "../../src/crypto/bytes";

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
  it("unwraps an org key through the RSA private key", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
      true,
      ["encrypt", "decrypt"],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));

    const userKey: SymKey = {
      encKey: new Uint8Array(32).fill(1),
      macKey: new Uint8Array(32).fill(2),
    };
    const wrappedPrivate = await wrapType2(pkcs8, userKey);
    const privateKey = await unwrapPrivateKey(wrappedPrivate, userKey);

    const orgKeyRaw = crypto.getRandomValues(new Uint8Array(64));
    const orgCt = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, orgKeyRaw));
    const orgKey = await unwrapOrgKey(`4.${toBase64(orgCt)}`, privateKey);

    expect(toBase64(concat(orgKey.encKey, orgKey.macKey))).toBe(toBase64(orgKeyRaw));
  });
});

describe("unwrapCipherKey", () => {
  const parent: SymKey = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) };

  it("returns the parent key when the cipher has no key of its own", async () => {
    const k = await unwrapCipherKey(null, parent);
    expect(toBase64(k.encKey)).toBe(toBase64(parent.encKey));
  });

  it("unwraps a per-cipher key when present", async () => {
    const cipherKeyRaw = crypto.getRandomValues(new Uint8Array(64));
    const wrapped = await wrapType2(cipherKeyRaw, parent);
    const k = await unwrapCipherKey(wrapped, parent);
    expect(toBase64(concat(k.encKey, k.macKey))).toBe(toBase64(cipherKeyRaw));
    expect(toBase64(k.encKey)).not.toBe(toBase64(parent.encKey));
  });
});
