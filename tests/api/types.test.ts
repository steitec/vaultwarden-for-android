import { describe, it, expect } from "vitest";
import {
  isSyncResponse,
  isRawCipher,
  isPreloginResponse,
  isTokenResponse,
  isLoginTokenResponse,
  isTwoFactorChallenge,
} from "../../src/api/types";
import syncFixture from "../fixtures/sync-1.37.1.json";
import preloginFixture from "../fixtures/prelogin-1.37.1.json";

/**
 * These fixtures are verbatim captures from `vaultwarden/server:1.37.1`,
 * produced by the throwaway container the integration suite starts (see
 * `tests/integration/seed.ts`, `seedVault`). They exist because the
 * integration suite needs Docker and will therefore rarely run, while THIS
 * is the regression that silently empties every user's vault: an
 * `isSyncResponse` that rejects real server output makes
 * `Controller.loadFromCache` return zero items with no error anywhere.
 *
 * Regenerate them by seeding a fresh container with `seedVault` and dumping
 * `/api/sync?excludeDomains=true` — never by hand-editing, which would
 * defeat the whole point.
 */
describe("isSyncResponse against a captured 1.37.1 response", () => {
  it("accepts the real payload", () => {
    expect(isSyncResponse(syncFixture)).toBe(true);
  });

  it("accepts every cipher in it individually", () => {
    // Per-cipher, so a failure names the item instead of just saying
    // "false" about a 20 KB document.
    const rejected: string[] = [];
    for (const c of syncFixture.ciphers) {
      const id = c.id;
      if (!isRawCipher(c)) rejected.push(id);
    }
    expect(rejected).toEqual([]);
  });

  it("covers the shapes the guard is permissive about", () => {
    const logins = syncFixture.ciphers.map((c) => c.login);
    // Vaultwarden OMITS login sub-fields it has no value for. If this
    // stops being true the fixture was regenerated wrongly, and the
    // acceptance test above stops proving anything.
    expect(logins.some((l) => l !== null && !("totp" in l))).toBe(true);
    expect(logins.some((l) => l !== null && !("username" in l))).toBe(true);
    expect(logins.some((l) => l !== null && l.uris === null)).toBe(true);
    expect(logins.some((l) => l === null)).toBe(true);
    expect(syncFixture.ciphers.some((c) => c.key !== null)).toBe(true);
    expect(syncFixture.ciphers.some((c) => c.organizationId !== null)).toBe(true);
    expect(syncFixture.profile.organizations.length).toBeGreaterThan(0);
    expect(syncFixture.folders.length).toBeGreaterThan(0);
  });

  it("accepts a one-cipher slice of it", () => {
    for (const c of syncFixture.ciphers) {
      expect(isSyncResponse({ ...syncFixture, ciphers: [c] })).toBe(true);
    }
  });
});

describe("isSyncResponse rejections", () => {
  /** A real cipher from the fixture, as a plain record to mutate. */
  function cipher(): Record<string, unknown> {
    const c = syncFixture.ciphers[0];
    if (c === undefined) throw new Error("fixture has no ciphers");
    return { ...c };
  }
  function without(o: Record<string, unknown>, field: string): Record<string, unknown> {
    const copy = { ...o };
    delete copy[field];
    return copy;
  }
  const base = () => ({ profile: { organizations: [] }, ciphers: [], folders: [] });

  it.each([
    ["null", null],
    ["a string", "{}"],
    ["an array", []],
    ["an empty object", {}],
    ["a missing profile", { ciphers: [], folders: [] }],
    ["a missing ciphers array", { profile: { organizations: [] }, folders: [] }],
    ["a missing folders array", { profile: { organizations: [] }, ciphers: [] }],
    ["ciphers that are not an array", { ...base(), ciphers: {} }],
    ["a bare {} cipher", { ...base(), ciphers: [{}] }],
    ["a folder without a name", { ...base(), folders: [{ id: "f" }] }],
    ["an organization without a key", { ...base(), profile: { organizations: [{ id: "o", name: "n" }] } }],
  ])("rejects %s", (_label, value) => {
    expect(isSyncResponse(value)).toBe(false);
  });

  it("rejects a cipher whose id is not a string", () => {
    const c = cipher();
    expect(isSyncResponse({ ...syncFixture, ciphers: [{ ...c, id: 42 }] })).toBe(false);
  });

  it("rejects a cipher with no name", () => {
    expect(isSyncResponse({ ...syncFixture, ciphers: [without(cipher(), "name")] })).toBe(false);
  });

  it("rejects a cipher whose favorite is not a boolean", () => {
    expect(isSyncResponse({ ...syncFixture, ciphers: [{ ...cipher(), favorite: "yes" }] })).toBe(false);
  });

  it("rejects a cipher whose type is not a finite number", () => {
    expect(isSyncResponse({ ...syncFixture, ciphers: [{ ...cipher(), type: "1" }] })).toBe(false);
    expect(isSyncResponse({ ...syncFixture, ciphers: [{ ...cipher(), type: Number.NaN }] })).toBe(false);
  });

  it("rejects a login whose password is a number", () => {
    const c = { ...cipher(), login: { username: null, password: 7, uris: null } };
    expect(isSyncResponse({ ...syncFixture, ciphers: [c] })).toBe(false);
  });

  it("rejects a uri entry that is not an object", () => {
    const c = { ...cipher(), login: { uris: ["https://example.test"] } };
    expect(isSyncResponse({ ...syncFixture, ciphers: [c] })).toBe(false);
  });

  it("rejects an organizationId that is absent rather than null", () => {
    // decryptVault compares `=== null` to choose the parent key, so an
    // absent organizationId would silently route an item to the wrong key.
    const stripped = without(cipher(), "organizationId");
    expect(isSyncResponse({ ...syncFixture, ciphers: [stripped] })).toBe(false);
  });
});

describe("isPreloginResponse", () => {
  it("accepts the captured 1.37.1 prelogin body", () => {
    expect(isPreloginResponse(preloginFixture)).toBe(true);
  });

  it("accepts an Argon2id configuration", () => {
    expect(
      isPreloginResponse({ kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4, salt: null }),
    ).toBe(true);
  });

  it("accepts a body without the optional fields at all", () => {
    // Upstream Bitwarden's prelogin has never sent `salt`.
    expect(isPreloginResponse({ kdf: 0, kdfIterations: 600000 })).toBe(true);
  });

  it.each([2, 3, -1, 0.5, "0", null, undefined])(
    "rejects kdf %p, keeping deriveMasterKey's unknown-KDF throw unreachable",
    (kdf) => {
      expect(isPreloginResponse({ kdf, kdfIterations: 600000 })).toBe(false);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "600000", null])(
    "rejects kdfIterations %p",
    (kdfIterations) => {
      expect(isPreloginResponse({ kdf: 0, kdfIterations })).toBe(false);
    },
  );

  it("rejects a non-numeric Argon2 memory", () => {
    expect(isPreloginResponse({ kdf: 1, kdfIterations: 3, kdfMemory: "64" })).toBe(false);
  });

  it("rejects a non-string salt", () => {
    expect(isPreloginResponse({ kdf: 0, kdfIterations: 1, salt: 5 })).toBe(false);
  });
});

describe("isTokenResponse / isLoginTokenResponse", () => {
  const login: Record<string, unknown> = {
    access_token: "at",
    refresh_token: "rt",
    expires_in: 7200,
    Key: "2.a|b|c",
    PrivateKey: "2.d|e|f",
  };

  it("accepts a password-grant response", () => {
    expect(isTokenResponse(login)).toBe(true);
    expect(isLoginTokenResponse(login)).toBe(true);
  });

  it("accepts a refresh-grant response, which carries no key material", () => {
    // Captured from 1.37.1: a refresh_token grant answers with exactly
    // these five fields. Requiring Key/PrivateKey here would turn every
    // token refresh into an InvalidResponseError.
    const refreshed = {
      refresh_token: "rt",
      access_token: "at",
      expires_in: 7200,
      token_type: "Bearer",
      scope: "api offline_access",
    };
    expect(isTokenResponse(refreshed)).toBe(true);
    expect(isLoginTokenResponse(refreshed)).toBe(false);
  });

  it.each(["access_token", "refresh_token", "Key", "PrivateKey"])(
    "rejects a login response with a missing %s",
    (field) => {
      const rest = { ...login };
      delete rest[field];
      expect(isLoginTokenResponse(rest)).toBe(false);
    },
  );

  it.each(["access_token", "refresh_token", "Key", "PrivateKey"])(
    "rejects a login response with an empty %s",
    (field) => {
      expect(isLoginTokenResponse({ ...login, [field]: "" })).toBe(false);
    },
  );

  it("rejects a non-numeric expires_in", () => {
    expect(isTokenResponse({ ...login, expires_in: "7200" })).toBe(false);
    expect(isLoginTokenResponse({ ...login, expires_in: Number.NaN })).toBe(false);
  });

  it.each([null, "token", 42, []])("rejects %p", (v) => {
    expect(isTokenResponse(v)).toBe(false);
    expect(isLoginTokenResponse(v)).toBe(false);
  });
});

describe("isTwoFactorChallenge", () => {
  it("accepts a provider list", () => {
    expect(isTwoFactorChallenge({ TwoFactorProviders: ["0", 1] })).toBe(true);
  });

  it.each([
    ["an absent list", { error: "invalid_grant" }],
    ["an empty list", { TwoFactorProviders: [] }],
    ["a non-array list", { TwoFactorProviders: "0" }],
    ["a list with an object in it", { TwoFactorProviders: [{}] }],
    ["null", null],
  ])("treats %s as not a challenge", (_label, value) => {
    expect(isTwoFactorChallenge(value)).toBe(false);
  });
});
