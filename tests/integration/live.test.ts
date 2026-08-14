import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync } from "node:fs";
import {
  waitForServer,
  seedAccount,
  seedVault,
  SEEDED,
  SERVER,
  EMAIL,
  PASSWORD,
} from "./seed";
import {
  prelogin,
  requestToken,
  refreshToken,
  InvalidCredentialsError,
} from "../../src/api/identity";
import { sync, UnauthorizedError, SyncFailedError } from "../../src/api/sync";
import { isSyncResponse, isRawCipher, isPreloginResponse } from "../../src/api/types";
import { performLogin } from "../../src/background/login";
import { decryptVault } from "../../src/vault/index";
import { generateTotp } from "../../src/totp";
import syncFixture from "../fixtures/sync-1.37.1.json";

const DEVICE = "integration-test";

/**
 * A structural fingerprint: which keys the server actually sends, ignoring
 * ids and ciphertext. Comparing this against the committed fixture is what
 * makes the fast suite's fixture trustworthy — if the server ever starts
 * sending a different shape, this fails here rather than silently making
 * `tests/fixtures/sync-1.37.1.json` a museum piece.
 */
function shapeSignature(payload: unknown): string {
  const keysOf = (v: unknown): string =>
    typeof v === "object" && v !== null ? Object.keys(v).sort().join(",") : `<${typeof v}>`;

  if (typeof payload !== "object" || payload === null) return "<not an object>";
  const p: Record<string, unknown> = { ...payload };
  const ciphers = Array.isArray(p.ciphers) ? p.ciphers : [];
  const folders = Array.isArray(p.folders) ? p.folders : [];
  const cipherShapes = ciphers
    .map((c) => {
      const login = typeof c === "object" && c !== null && "login" in c ? c.login : undefined;
      return `${keysOf(c)}|login=${login === null ? "null" : keysOf(login)}`;
    })
    .sort();
  return [
    `top=${keysOf(payload)}`,
    `profile=${keysOf(p.profile)}`,
    `folder=${folders.map(keysOf).sort().join(";")}`,
    ...cipherShapes,
  ].join("\n");
}

describe("live Vaultwarden", () => {
  let accessToken = "";

  beforeAll(async () => {
    await waitForServer();
    const account = await seedAccount();
    accessToken = account.accessToken;
    await seedVault(account);
  }, 120000);

  describe("identity", () => {
    it("returns real kdf parameters from prelogin", async () => {
      const r = await prelogin(SERVER, EMAIL);
      expect(r.kdf).toBe(0);
      expect(r.kdfIterations).toBeGreaterThan(0);
      // Normalized, not merely passed through: the wire body may omit these.
      expect(r.kdfMemory).toBeNull();
      expect(r.kdfParallelism).toBeNull();
    });

    it("accepts the raw prelogin body with the boundary guard", async () => {
      const res = await fetch(`${SERVER}/identity/accounts/prelogin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL }),
      });
      const raw: unknown = await res.json();
      expect(isPreloginResponse(raw)).toBe(true);
    });

    it("answers prelogin for an account that does not exist", async () => {
      // Username-enumeration protection. If this ever starts failing, the client's
      // "email or password incorrect" messaging needs revisiting.
      const r = await prelogin(SERVER, "definitely-not-registered@example.invalid");
      expect(r.kdfIterations).toBeGreaterThan(0);
    });

    it("rejects a wrong password", async () => {
      await expect(
        requestToken(SERVER, EMAIL, "obviously-wrong-hash", DEVICE),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });
  });

  describe("sync response shape", () => {
    it("is accepted by isSyncResponse", async () => {
      const res = await fetch(`${SERVER}/api/sync?excludeDomains=true`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const raw: unknown = await res.json();

      // Regenerate the committed fixture from this same seeded vault:
      //   VW_UPDATE_FIXTURE=1 npm run test:integration
      if (process.env.VW_UPDATE_FIXTURE === "1") {
        writeFileSync("tests/fixtures/sync-1.37.1.json", `${JSON.stringify(raw, null, 2)}\n`);
        const pre = await fetch(`${SERVER}/identity/accounts/prelogin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: EMAIL }),
        });
        writeFileSync(
          "tests/fixtures/prelogin-1.37.1.json",
          `${JSON.stringify(await pre.json(), null, 2)}\n`,
        );
      }

      // Per-cipher first: isSyncResponse can only answer false, which does
      // not tell you WHICH item the server sent differently.
      const ciphers =
        typeof raw === "object" && raw !== null && "ciphers" in raw && Array.isArray(raw.ciphers)
          ? raw.ciphers
          : [];
      expect(ciphers.length).toBe(8);
      const rejected: unknown[] = [];
      for (const c of ciphers) {
        if (!isRawCipher(c)) rejected.push(c);
      }
      expect(rejected).toEqual([]);

      expect(isSyncResponse(raw)).toBe(true);
    });

    it("still matches the committed fixture's shape", async () => {
      const res = await fetch(`${SERVER}/api/sync?excludeDomains=true`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(shapeSignature(await res.json())).toBe(shapeSignature(syncFixture));
    });

    it("returns a validated payload through sync()", async () => {
      // sync() now rejects anything isSyncResponse refuses, so this failing
      // means the guard and the real server disagree.
      const payload = await sync(SERVER, accessToken);
      expect(payload.ciphers.length).toBe(8);
      expect(payload.folders.length).toBe(1);
      expect(payload.profile.organizations?.length).toBe(1);
    });

    it("raises UnauthorizedError — not SyncFailedError — for a rejected bearer token", async () => {
      // Controller.syncAttempt's refresh-and-retry keys on exactly this
      // class. A wrong status mapping would silently break token refresh
      // for every user whose access token expires. Note the server answers
      // with an HTML error page, so this must be decided on the status.
      const err = await sync(SERVER, "garbage-token").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect(err).not.toBeInstanceOf(SyncFailedError);
    });
  });

  describe("login and decryption", () => {
    it("logs in, syncs, and decrypts every seeded shape", async () => {
      const r = await performLogin({
        serverUrl: SERVER,
        email: EMAIL,
        password: PASSWORD,
        deviceId: DEVICE,
      });

      // The organization key came out of profile.organizations via the RSA
      // private key — the path that only exists when an org is present.
      expect(r.orgKeys.size).toBe(1);

      const items = await decryptVault(r.payload, r.userKey, r.orgKeys);
      const byName = new Map(items.map((i) => [i.name, i]));

      // Secure notes are not logins, so decryptVault drops them.
      expect(items.length).toBe(7);
      expect(byName.has(SEEDED.note.name)).toBe(false);

      expect(byName.get(SEEDED.plain.name)?.username).toBe(SEEDED.plain.username);
      expect(byName.get(SEEDED.plain.name)?.password).toBe(SEEDED.plain.password);
      expect(byName.get(SEEDED.keyed.name)?.username).toBe(SEEDED.keyed.username);
      expect(byName.get(SEEDED.keyed.name)?.password).toBe(SEEDED.keyed.password);

      // The item whose login object has no `username` key at all.
      expect(byName.get(SEEDED.noUsername.name)?.username).toBeNull();
      expect(byName.get(SEEDED.noUsername.name)?.password).toBe(SEEDED.noUsername.password);

      // The item whose login object has no `uris` key at all.
      expect(byName.get(SEEDED.noUris.name)?.uris).toEqual([]);
      expect(byName.get(SEEDED.noUris.name)?.password).toBe(SEEDED.noUris.password);

      // Explicit nulls everywhere: a login with nothing in it is still a
      // valid, decryptable item.
      expect(byName.get(SEEDED.explicitNulls.name)?.password).toBeNull();
      expect(byName.get(SEEDED.explicitNulls.name)?.undecryptable).toBe(false);

      // Organization item, decrypted under the unwrapped org key.
      expect(byName.get(SEEDED.org.name)?.password).toBe(SEEDED.org.password);

      expect(items.some((i) => i.undecryptable)).toBe(false);
    }, 60000);

    it("round-trips a TOTP secret into a code", async () => {
      const r = await performLogin({
        serverUrl: SERVER,
        email: EMAIL,
        password: PASSWORD,
        deviceId: DEVICE,
      });
      const items = await decryptVault(r.payload, r.userKey, r.orgKeys);
      const item = items.find((i) => i.name === SEEDED.totp.name);
      expect(item?.totp).toBe(SEEDED.totp.secret);
      const totp = await generateTotp(item?.totp ?? "", Date.now());
      expect(totp.code).toMatch(/^\d{6}$/);
    }, 60000);
  });

  describe("token refresh", () => {
    it("refreshes an access token", async () => {
      const r = await performLogin({
        serverUrl: SERVER,
        email: EMAIL,
        password: PASSWORD,
        deviceId: DEVICE,
      });
      const refreshed = await refreshToken(SERVER, r.tokens.refresh_token);
      expect(refreshed.access_token).toBeTruthy();
      expect(refreshed.refresh_token).toBeTruthy();
      // The refresh grant carries NO key material: `Key`/`PrivateKey` are
      // absent from this body entirely, which is why refreshToken uses the
      // loose guard. Demanding them would reject every real refresh.
      expect(Object.keys(refreshed)).not.toContain("Key");
      expect(Object.keys(refreshed)).not.toContain("PrivateKey");
    }, 60000);

    it("does NOT rotate the refresh token: the old one keeps working", async () => {
      const r = await performLogin({
        serverUrl: SERVER,
        email: EMAIL,
        password: PASSWORD,
        deviceId: DEVICE,
      });
      const original = r.tokens.refresh_token;

      const first = await refreshToken(SERVER, original);
      // vaultwarden 1.37.1 hands back the SAME refresh token — it is a JWT
      // bound to the device, not a rotating one-shot credential.
      expect(first.refresh_token).toBe(original);

      // And the original still works afterwards. This contradicts the
      // comment in Controller.syncAttempt ("Vaultwarden invalidates the old
      // one"): persisting the rotated token immediately is harmless, but
      // the stated reason is not true of this server. If this assertion
      // ever starts failing, the server HAS started rotating and that
      // persistence really does become load-bearing — do not just flip the
      // expectation, re-read syncAttempt.
      const second = await refreshToken(SERVER, original);
      expect(second.access_token).toBeTruthy();
    }, 60000);
  });
});
