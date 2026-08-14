import { describe, it, expect, vi, afterEach } from "vitest";
import { performLogin } from "../../src/background/login";
import { TwoFactorRequiredError, InvalidCredentialsError } from "../../src/api/identity";
import { stretchMasterKey, deriveMasterKey } from "../../src/crypto/kdf";
import { toBase64, concat, type Bytes } from "../../src/crypto/bytes";
import type { SymKey } from "../../src/crypto/encstring";

async function wrap(data: Bytes, key: SymKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ck = await crypto.subtle.importKey("raw", key.encKey, "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, data));
  const mk = await crypto.subtle.importKey(
    "raw",
    key.macKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", mk, concat(iv, ct)));
  return `2.${toBase64(iv)}|${toBase64(ct)}|${toBase64(mac)}`;
}

function allZero(b: Uint8Array): boolean {
  return b.every((byte) => byte === 0);
}

/**
 * A raw key import, recorded as both the LIVE buffer reference the caller
 * handed to WebCrypto and a snapshot of its contents at that moment.
 * `crypto.subtle.importKey` copies the material into its own internal
 * representation but keeps no hold on the caller's array, so the live
 * reference is exactly the buffer the code under test is responsible for
 * zeroing — and the snapshot is how a test identifies WHICH buffer it is
 * after the zeroing has already happened.
 */
type RawImport = { live: Uint8Array; snapshot: string };

type ImportKeyLoose = (
  format: string,
  keyData: BufferSource,
  algorithm: AlgorithmIdentifier | HmacImportParams | RsaHashedImportParams,
  extractable: boolean,
  keyUsages: KeyUsage[],
) => Promise<CryptoKey>;

const realImportKey: ImportKeyLoose = crypto.subtle.importKey.bind(
  crypto.subtle,
) as unknown as ImportKeyLoose;

function setImportKey(fn: ImportKeyLoose): void {
  Object.defineProperty(crypto.subtle, "importKey", {
    configurable: true,
    writable: true,
    value: fn,
  });
}

function captureRawImports(): RawImport[] {
  const seen: RawImport[] = [];
  setImportKey((format, keyData, algorithm, extractable, keyUsages) => {
    if (format === "raw" && keyData instanceof Uint8Array) {
      seen.push({ live: keyData, snapshot: toBase64(keyData) });
    }
    return realImportKey(format, keyData, algorithm, extractable, keyUsages);
  });
  return seen;
}

const KDF_CFG = { kdf: 0 as const, iterations: 100, memory: null, parallelism: null, salt: null };
const PRELOGIN_BODY = {
  kdf: 0,
  kdfIterations: 100,
  kdfMemory: null,
  kdfParallelism: null,
  salt: null,
};

/** Everything a real server would hand back for one account. */
async function fixture(password = "pw"): Promise<{
  protectedKey: string;
  protectedPrivate: string;
  userKeyRaw: Uint8Array;
  orgKeyRaw: Uint8Array;
  orgEncString: string;
}> {
  const masterKey = await deriveMasterKey(password, "a@b.com", KDF_CFG);
  const stretched = await stretchMasterKey(masterKey);
  const userKeyRaw = crypto.getRandomValues(new Uint8Array(64));
  const protectedKey = await wrap(userKeyRaw, stretched);

  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-1",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const userKey: SymKey = { encKey: userKeyRaw.slice(0, 32), macKey: userKeyRaw.slice(32) };
  const protectedPrivate = await wrap(pkcs8, userKey);

  const orgKeyRaw = crypto.getRandomValues(new Uint8Array(64));
  const orgCt = new Uint8Array(
    await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, orgKeyRaw),
  );

  return {
    protectedKey,
    protectedPrivate,
    userKeyRaw,
    orgKeyRaw,
    orgEncString: `4.${toBase64(orgCt)}`,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setImportKey(realImportKey);
});

describe("performLogin", () => {
  it("derives keys and returns a decrypted vault payload", async () => {
    const f = await fixture();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("prelogin")) {
          return { ok: true, status: 200, json: async () => PRELOGIN_BODY };
        }
        if (url.includes("connect/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "at",
              refresh_token: "rt",
              expires_in: 3600,
              Key: f.protectedKey,
              PrivateKey: f.protectedPrivate,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: { organizations: [{ id: "org1", name: "Org", key: f.orgEncString }] },
            folders: [],
            ciphers: [],
          }),
        };
      }),
    );

    const r = await performLogin({
      serverUrl: "https://v.example.net",
      email: "a@b.com",
      password: "pw",
      deviceId: "dev",
    });

    expect(toBase64(concat(r.userKey.encKey, r.userKey.macKey))).toBe(toBase64(f.userKeyRaw));
    expect(r.orgKeys.get("org1")).toBeDefined();
    expect(toBase64(concat(r.orgKeys.get("org1")!.encKey, r.orgKeys.get("org1")!.macKey))).toBe(
      toBase64(f.orgKeyRaw),
    );
    expect(r.kdf.iterations).toBe(100);
  }, 20000);

  it("sends the derived hash, never the master password itself", async () => {
    const f = await fixture("correct-horse-battery-staple");
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: unknown }) => {
        calls.push({ url, body: init?.body });
        if (url.includes("prelogin")) {
          return { ok: true, status: 200, json: async () => PRELOGIN_BODY };
        }
        if (url.includes("connect/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "at",
              refresh_token: "rt",
              expires_in: 3600,
              Key: f.protectedKey,
              PrivateKey: f.protectedPrivate,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: { organizations: null }, folders: [], ciphers: [] }),
        };
      }),
    );

    await performLogin({
      serverUrl: "https://v.example.net",
      email: "a@b.com",
      password: "correct-horse-battery-staple",
      deviceId: "dev",
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(JSON.stringify(c.body ?? null)).not.toContain("correct-horse-battery-staple");
    }
  }, 20000);

  it("propagates a wrong-password failure without naming the field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("prelogin")) {
          return { ok: true, status: 200, json: async () => PRELOGIN_BODY };
        }
        return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) };
      }),
    );

    const err = await performLogin({
      serverUrl: "https://v.example.net",
      email: "a@b.com",
      password: "wrong",
      deviceId: "dev",
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(InvalidCredentialsError);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toMatch(/email or password/i);
    // The server deliberately withholds which field was wrong — prelogin
    // even answers with plausible KDF parameters for accounts that do not
    // exist. Naming one field (i.e. confirming the other was right) would
    // turn this into an account-enumeration oracle.
    //
    // Strip the one permitted both-fields phrase; whatever is left must not
    // mention either field. That catches "Email or password incorrect. The
    // password was wrong." as well as a plain "Wrong password".
    const rest = message.replace(/email or password/i, "");
    expect(rest).not.toMatch(/email/i);
    expect(rest).not.toMatch(/password/i);
    expect(message).not.toMatch(/\bemail address\b/i);
  }, 20000);

  it("lets TwoFactorRequiredError through unchanged, with its provider list", async () => {
    // The 2FA screen catches this BY TYPE. Collapsing it into a generic
    // login failure would leave a user with correct credentials told their
    // password is wrong, and would lose the provider list entirely.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("prelogin")) {
          return { ok: true, status: 200, json: async () => PRELOGIN_BODY };
        }
        return {
          ok: false,
          status: 400,
          json: async () => ({ TwoFactorProviders: ["0", 1] }),
        };
      }),
    );

    const err = await performLogin({
      serverUrl: "https://v.example.net",
      email: "a@b.com",
      password: "pw",
      deviceId: "dev",
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TwoFactorRequiredError);
    expect(err).not.toBeInstanceOf(InvalidCredentialsError);
    expect(err instanceof TwoFactorRequiredError ? err.providers : null).toEqual([0, 1]);
  }, 20000);

  it("forwards a supplied second factor to the token endpoint", async () => {
    const f = await fixture();
    let tokenBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: unknown }) => {
        if (url.includes("prelogin")) {
          return { ok: true, status: 200, json: async () => PRELOGIN_BODY };
        }
        if (url.includes("connect/token")) {
          tokenBody = String(init?.body ?? "");
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "at",
              refresh_token: "rt",
              expires_in: 3600,
              Key: f.protectedKey,
              PrivateKey: f.protectedPrivate,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: { organizations: null }, folders: [], ciphers: [] }),
        };
      }),
    );

    await performLogin({
      serverUrl: "https://v.example.net",
      email: "a@b.com",
      password: "pw",
      deviceId: "dev",
      twoFactor: { token: "654321", provider: 0 },
    });

    expect(tokenBody).toContain("twoFactorToken=654321");
    expect(tokenBody).toContain("twoFactorProvider=0");
  }, 20000);

  it("zeroes the master key even when the login fails", async () => {
    // A failed login must not leave password-equivalent material resident.
    // The master key is never handed to a caller, so nothing downstream can
    // clean it up. It IS observable: hkdfExpand/pbkdf2 import it as a raw
    // key, and importKey keeps the caller's buffer reference.
    // deriveMasterKey is deterministic, so the expected bytes are known and
    // the right buffer can be picked out of the recorded imports.
    const expectedMaster = toBase64(await deriveMasterKey("pw", "a@b.com", KDF_CFG));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("prelogin")) {
          return { ok: true, status: 200, json: async () => PRELOGIN_BODY };
        }
        return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) };
      }),
    );

    const raws = captureRawImports();

    await expect(
      performLogin({
        serverUrl: "https://v.example.net",
        email: "a@b.com",
        password: "pw",
        deviceId: "dev",
      }),
    ).rejects.toThrow(InvalidCredentialsError);

    const master = raws.find((r) => r.snapshot === expectedMaster);
    expect(master, "the master key should have been imported for PBKDF2").toBeDefined();
    expect(allZero(master!.live)).toBe(true);
  }, 20000);

  it("zeroes the derived user key when a later step of the login fails", async () => {
    // The user key exists by the time the private key is unwrapped. If that
    // step throws, the key never reaches a caller — so performLogin itself
    // has to wipe it rather than orphaning a buffer full of live vault-key
    // bytes.
    const f = await fixture();
    // A well-formed type-2 EncString wrapped under the WRONG key: it gets
    // as far as the HMAC check inside unwrapPrivateKey (which imports the
    // user key's macKey, letting the probe below see the buffer) and then
    // fails.
    const wrongKey: SymKey = {
      encKey: new Uint8Array(32).fill(9),
      macKey: new Uint8Array(32).fill(9),
    };
    const bogusPrivate = await wrap(new Uint8Array(64).fill(3), wrongKey);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("prelogin")) {
          return { ok: true, status: 200, json: async () => PRELOGIN_BODY };
        }
        if (url.includes("connect/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "at",
              refresh_token: "rt",
              expires_in: 3600,
              Key: f.protectedKey,
              PrivateKey: bogusPrivate,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: { organizations: [{ id: "org1", name: "Org", key: f.orgEncString }] },
            folders: [],
            ciphers: [],
          }),
        };
      }),
    );

    const expectedMac = f.userKeyRaw.slice(32);
    const raws = captureRawImports();

    await expect(
      performLogin({
        serverUrl: "https://v.example.net",
        email: "a@b.com",
        password: "pw",
        deviceId: "dev",
      }),
    ).rejects.toThrow();

    // Find the buffer that WAS the user key's macKey, by identity of its
    // contents at import time (recorded as a snapshot alongside the live
    // reference), then assert the live reference is now all zeroes.
    const userMac = raws.find((r) => r.snapshot === toBase64(expectedMac));
    expect(userMac, "the user key's macKey should have been imported").toBeDefined();
    expect(allZero(userMac!.live)).toBe(true);
  }, 20000);

  it("tolerates an organization whose key cannot be unwrapped", async () => {
    const f = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("prelogin")) {
          return { ok: true, status: 200, json: async () => PRELOGIN_BODY };
        }
        if (url.includes("connect/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "at",
              refresh_token: "rt",
              expires_in: 3600,
              Key: f.protectedKey,
              PrivateKey: f.protectedPrivate,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: {
              organizations: [
                { id: "bad", name: "Bad", key: "4.bm90LWEta2V5" },
                { id: "org1", name: "Org", key: f.orgEncString },
              ],
            },
            folders: [],
            ciphers: [],
          }),
        };
      }),
    );

    const r = await performLogin({
      serverUrl: "https://v.example.net",
      email: "a@b.com",
      password: "pw",
      deviceId: "dev",
    });

    expect(r.orgKeys.has("bad")).toBe(false);
    expect(r.orgKeys.has("org1")).toBe(true);
  }, 20000);
});
