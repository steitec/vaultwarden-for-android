/**
 * Seeding helpers for the live-container integration suite.
 *
 * Everything in here talks to a throwaway Vaultwarden started by
 * `tests/integration/docker-compose.yml` on loopback. The credentials below
 * are published in this repository on purpose: they must never be reused for
 * a real account, and no test may ever be pointed at a real server.
 */
import {
  deriveMasterKey,
  deriveMasterPasswordHash,
  stretchMasterKey,
  type KdfConfig,
} from "../../src/crypto/kdf";
import { toBase64, concat, utf8, type Bytes } from "../../src/crypto/bytes";
import type { SymKey } from "../../src/crypto/encstring";
import { isLoginTokenResponse } from "../../src/api/types";
import { InvalidResponseError } from "../../src/api/identity";

export const SERVER = "http://127.0.0.1:18080";
export const EMAIL = "test@example.invalid";
export const PASSWORD = "integration-test-password";

const KDF: KdfConfig = { kdf: 0, iterations: 600000, memory: null, parallelism: null, salt: null };

async function encrypt(data: Bytes, key: SymKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ck = await crypto.subtle.importKey("raw", key.encKey, "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, data));
  const mk = await crypto.subtle.importKey("raw", key.macKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", mk, concat(iv, ct)));
  return `2.${toBase64(iv)}|${toBase64(ct)}|${toBase64(mac)}`;
}

export async function waitForServer(timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${SERVER}/api/config`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Vaultwarden did not become ready within ${timeoutMs}ms`);
}

export type SeededAccount = {
  userKey: SymKey;
  accessToken: string;
  /** The account's RSA public key, for wrapping an organization key to it. */
  publicKey: CryptoKey;
};

/** Registers the test account and returns the user key, for creating ciphers. */
export async function seedAccount(): Promise<SeededAccount> {
  const masterKey = await deriveMasterKey(PASSWORD, EMAIL, KDF);
  const hash = await deriveMasterPasswordHash(masterKey, PASSWORD);
  const stretched = await stretchMasterKey(masterKey);

  const userKeyRaw = crypto.getRandomValues(new Uint8Array(64));
  const userKey: SymKey = { encKey: userKeyRaw.slice(0, 32), macKey: userKeyRaw.slice(32) };
  const protectedKey = await encrypt(userKeyRaw, stretched);

  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true,
    ["encrypt", "decrypt"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));

  // Verified against vaultwarden/server:1.37.1: this is the registration
  // endpoint. `/identity/register` and `/api/accounts/register` both 404.
  const register = await fetch(`${SERVER}/identity/accounts/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: EMAIL,
      name: "Integration Test",
      masterPasswordHash: hash,
      key: protectedKey,
      kdf: KDF.kdf,
      kdfIterations: KDF.iterations,
      keys: { publicKey: toBase64(spki), encryptedPrivateKey: await encrypt(pkcs8, userKey) },
    }),
  });
  if (!register.ok && register.status !== 400) {
    throw new Error(`Registration failed: ${register.status} ${await register.text()}`);
  }

  const tokenRes = await fetch(`${SERVER}/identity/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      username: EMAIL,
      password: hash,
      scope: "api offline_access",
      client_id: "browser",
      deviceType: "3",
      deviceIdentifier: "integration-test",
      deviceName: "vitest",
    }).toString(),
  });
  // The same guard the client itself uses at this boundary, so a seeding run
  // doubles as evidence that `isTokenResponse` accepts what the real server
  // sends.
  const tokens: unknown = await tokenRes.json();
  if (!isLoginTokenResponse(tokens)) {
    throw new InvalidResponseError(`seed: token response rejected (status ${tokenRes.status})`);
  }

  return { userKey, accessToken: tokens.access_token, publicKey: pair.publicKey };
}

/**
 * Creates an organization owned by the seeded account and returns its id
 * plus the (unwrapped) organization key.
 *
 * Worth the extra API calls: an organization is the only way to get a
 * non-empty `profile.organizations` out of the server, which is what
 * exercises `unwrapPrivateKey` + `unwrapOrgKey` in `performLogin` and the
 * `isOrganization` branch of `isSyncResponse`. Both are otherwise
 * completely untested against real data.
 */
export async function seedOrganization(
  account: SeededAccount,
  name = "Integration Org",
): Promise<{ id: string; orgKey: SymKey }> {
  const orgKeyRaw = crypto.getRandomValues(new Uint8Array(64));
  const orgKey: SymKey = { encKey: orgKeyRaw.slice(0, 32), macKey: orgKeyRaw.slice(32) };

  // Type-4 EncString: the organization key wrapped to the account's RSA
  // public key, exactly as `unwrapOrgKey` expects to find it in
  // `profile.organizations[].key`.
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt({ name: "RSA-OAEP" }, account.publicKey, orgKeyRaw),
  );

  const orgPair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true,
    ["encrypt", "decrypt"],
  );
  const orgPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", orgPair.privateKey));
  const orgSpki = new Uint8Array(await crypto.subtle.exportKey("spki", orgPair.publicKey));

  const res = await fetch(`${SERVER}/api/organizations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.accessToken}` },
    body: JSON.stringify({
      name,
      billingEmail: EMAIL,
      collectionName: await encrypt(utf8("Default Collection"), orgKey),
      key: `4.${toBase64(wrapped)}`,
      keys: { publicKey: toBase64(orgSpki), encryptedPrivateKey: await encrypt(orgPkcs8, orgKey) },
      planType: 0,
    }),
  });
  if (!res.ok) throw new Error(`Organization creation failed: ${res.status} ${await res.text()}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
    throw new Error("Organization creation returned no id");
  }
  return { id: body.id, orgKey };
}

/** Creates a folder and returns its server id. */
export async function seedFolder(accessToken: string, userKey: SymKey, name: string): Promise<string> {
  const res = await fetch(`${SERVER}/api/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name: await encrypt(utf8(name), userKey) }),
  });
  if (!res.ok) throw new Error(`Folder creation failed: ${res.status} ${await res.text()}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
    throw new Error("Folder creation returned no id");
  }
  return body.id;
}

/**
 * For every login sub-field: OMITTING the option omits the key from the
 * request, and passing `null` sends an explicit null. Vaultwarden stores the
 * login object roughly as it receives it, so this is the difference between
 * a synced cipher that has no `totp` key at all and one whose `totp` is
 * null — and both exist in real vaults, depending on which client created
 * the item. `isSyncResponse` has to accept both, so the fixture contains
 * both.
 */
export type SeedCipherOpts = {
  name: string;
  /** Bitwarden CipherType: 1 = login, 2 = secure note. Defaults to login. */
  type?: 1 | 2;
  username?: string | null;
  password?: string | null;
  totp?: string | null;
  uris?: string[] | null;
  withItemKey?: boolean;
  folderId?: string | null;
  /** Set to create the cipher inside an organization instead of the vault. */
  organization?: { id: string; orgKey: SymKey; collectionIds: string[] };
};

/** The collection ids of an organization, needed to file a cipher into it. */
export async function orgCollectionIds(accessToken: string, orgId: string): Promise<string[]> {
  const res = await fetch(`${SERVER}/api/organizations/${orgId}/collections`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Collection listing failed: ${res.status} ${await res.text()}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
    throw new Error("Collection listing had no data array");
  }
  const ids: string[] = [];
  for (const c of body.data) {
    if (typeof c === "object" && c !== null && "id" in c && typeof c.id === "string") ids.push(c.id);
  }
  return ids;
}

/**
 * Creates a cipher. `withItemKey` exercises the per-cipher key path; the
 * remaining options exist so the captured sync response covers the shape
 * variety `isSyncResponse` claims to accept (no username, no uris, a totp
 * secret, a non-login type).
 */
export async function seedCipher(
  accessToken: string,
  userKey: SymKey,
  opts: SeedCipherOpts,
): Promise<string> {
  // An organization cipher is encrypted under the ORGANIZATION key, not the
  // user key — that is the whole point of the org path in decryptVault.
  const parentKey = opts.organization?.orgKey ?? userKey;
  let key = parentKey;
  let itemKey: string | null = null;

  if (opts.withItemKey === true) {
    const raw = crypto.getRandomValues(new Uint8Array(64));
    itemKey = await encrypt(raw, parentKey);
    key = { encKey: raw.slice(0, 32), macKey: raw.slice(32) };
  }

  const type = opts.type ?? 1;
  const body: Record<string, unknown> = {
    type,
    name: await encrypt(utf8(opts.name), key),
    key: itemKey,
    folderId: opts.folderId ?? null,
    organizationId: opts.organization?.id ?? null,
  };

  if (type === 1) {
    const login: Record<string, unknown> = {};
    for (const field of ["username", "password", "totp"] as const) {
      if (!(field in opts)) continue;
      const value = opts[field];
      login[field] = value === null || value === undefined ? null : await encrypt(utf8(value), key);
    }
    if ("uris" in opts) {
      login.uris =
        opts.uris == null
          ? null
          : await Promise.all(
              opts.uris.map(async (u) => ({ uri: await encrypt(utf8(u), key), match: null })),
            );
    }
    body.login = login;
  } else {
    body.secureNote = { type: 0 };
  }

  // Organization ciphers go through /api/ciphers/create, which takes the
  // collections the item is filed into alongside it.
  const org = opts.organization;
  const res =
    org === undefined
      ? await fetch(`${SERVER}/api/ciphers`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(body),
        })
      : await fetch(`${SERVER}/api/ciphers/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ cipher: body, collectionIds: org.collectionIds }),
        });
  if (!res.ok) throw new Error(`Cipher creation failed: ${res.status} ${await res.text()}`);

  // The server id, so a test can address the cipher it just made. Checked
  // rather than cast: this is a network response like any other.
  const created: unknown = await res.json();
  if (
    typeof created !== "object" ||
    created === null ||
    !("id" in created) ||
    typeof created.id !== "string"
  ) {
    throw new Error("Cipher creation returned no id");
  }
  return created.id;
}

/** The plaintext of every seeded login, so tests can assert on decryption. */
export const SEEDED = {
  plain: { name: "Plain Item", username: "plain-user", password: "plain-pass", uri: "https://plain.example" },
  keyed: { name: "Keyed Item", username: "keyed-user", password: "keyed-pass", uri: "https://keyed.example" },
  noUsername: { name: "No Username", password: "nouser-pass", uri: "https://nouser.example" },
  noUris: { name: "No Uris", username: "nouri-user", password: "nouri-pass" },
  totp: { name: "Totp Item", username: "totp-user", password: "totp-pass", secret: "JBSWY3DPEHPK3PXP", uri: "https://totp.example" },
  explicitNulls: { name: "Explicit Nulls" },
  note: { name: "Secure Note" },
  org: { name: "Org Item", username: "org-user", password: "org-pass", uri: "https://org.example" },
} as const;

/**
 * Fills a freshly seeded account with the shape variety the guards claim to
 * accept, and returns the organization it created.
 *
 * This is the single definition of the test vault: `tests/fixtures/
 * sync-1.37.1.json` is a capture of exactly what this produces, so the fast
 * suite and the live suite can never drift apart.
 */
export async function seedVault(account: SeededAccount): Promise<{ orgId: string }> {
  const { accessToken, userKey } = account;
  const folderId = await seedFolder(accessToken, userKey, "Work");
  const org = await seedOrganization(account);
  const collectionIds = await orgCollectionIds(accessToken, org.id);

  // No `totp` key at all.
  await seedCipher(accessToken, userKey, {
    name: SEEDED.plain.name,
    username: SEEDED.plain.username,
    password: SEEDED.plain.password,
    uris: [SEEDED.plain.uri],
  });
  // Per-cipher key.
  await seedCipher(accessToken, userKey, {
    name: SEEDED.keyed.name,
    username: SEEDED.keyed.username,
    password: SEEDED.keyed.password,
    uris: [SEEDED.keyed.uri],
    withItemKey: true,
  });
  // No `username` key at all, and filed in a folder.
  await seedCipher(accessToken, userKey, {
    name: SEEDED.noUsername.name,
    password: SEEDED.noUsername.password,
    uris: [SEEDED.noUsername.uri],
    folderId,
  });
  // No `uris` key at all.
  await seedCipher(accessToken, userKey, {
    name: SEEDED.noUris.name,
    username: SEEDED.noUris.username,
    password: SEEDED.noUris.password,
  });
  // A TOTP secret.
  await seedCipher(accessToken, userKey, {
    name: SEEDED.totp.name,
    username: SEEDED.totp.username,
    password: SEEDED.totp.password,
    totp: SEEDED.totp.secret,
    uris: [SEEDED.totp.uri],
  });
  // Every login sub-field present but explicitly null — the other half of
  // the absent-versus-null pair.
  await seedCipher(accessToken, userKey, {
    name: SEEDED.explicitNulls.name,
    username: null,
    password: null,
    totp: null,
    uris: null,
  });
  // A non-login cipher, which is where `login: null` actually comes from.
  await seedCipher(accessToken, userKey, { name: SEEDED.note.name, type: 2 });
  // Owned by the organization, encrypted under the organization key.
  await seedCipher(accessToken, userKey, {
    name: SEEDED.org.name,
    username: SEEDED.org.username,
    password: SEEDED.org.password,
    uris: [SEEDED.org.uri],
    organization: { id: org.id, orgKey: org.orgKey, collectionIds },
  });

  return { orgId: org.id };
}
