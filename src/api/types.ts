/**
 * The normalized KDF parameters the rest of the client works with. Every
 * optional field on the wire is `null` here, so callers never have to
 * distinguish "absent" from "null".
 */
export type PreloginResponse = {
  kdf: 0 | 1;
  kdfIterations: number;
  kdfMemory: number | null;
  kdfParallelism: number | null;
  salt: string | null;
};

/**
 * The wire shape of `/identity/accounts/prelogin`, which is what the guard
 * can actually promise.
 *
 * `kdfMemory`, `kdfParallelism` and `salt` are optional rather than
 * `| null`: vaultwarden 1.37.1 sends all three (see
 * `tests/fixtures/prelogin-1.37.1.json`), but upstream Bitwarden's prelogin
 * has never had a `salt` field at all, and requiring a key that a
 * conforming server may omit would reject a perfectly good login. `kdf` and
 * `kdfIterations` are required and strictly checked, because those two are
 * the ones `deriveMasterKey` acts on.
 */
export type PreloginBody = {
  kdf: 0 | 1;
  kdfIterations: number;
  kdfMemory?: number | null;
  kdfParallelism?: number | null;
  salt?: string | null;
};

/**
 * The fields present on EVERY `/identity/connect/token` response, whichever
 * grant produced it.
 *
 * Deliberately does not include `Key`/`PrivateKey`: a `refresh_token` grant
 * against vaultwarden 1.37.1 answers with exactly
 * `refresh_token, access_token, expires_in, token_type, scope` and no key
 * material at all (captured, see the integration suite). A guard that
 * demanded them here would turn every access-token refresh into an
 * `InvalidResponseError` — i.e. would sign out every user whose token
 * expired.
 */
export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

/**
 * A password-grant token response, which additionally carries the wrapped
 * key material. `login.ts` feeds both strings straight into
 * `unwrapUserKey`/`unwrapPrivateKey`, so they are required and must be
 * non-empty: an empty string is not a wrapped key, and letting one through
 * only moves the failure somewhere less legible.
 */
export type LoginTokenResponse = TokenResponse & {
  /** EncString of the user key, wrapped under the stretched master key */
  Key: string;
  /** EncString of the PKCS#8 RSA private key, wrapped under the user key */
  PrivateKey: string;
};

/**
 * The 400 body that carries a two-factor challenge. Absent or empty
 * providers is NOT a challenge — it is an ordinary wrong-credentials 400.
 */
export type TwoFactorChallenge = { TwoFactorProviders: (string | number)[] };

export type RawCipherUri = { uri: string | null; match: number | null };

/**
 * A cipher as it comes off `/api/sync`.
 *
 * Optional (`?:`) versus nullable is not cosmetic here — it is transcribed
 * from a captured 1.37.1 response (`tests/fixtures/sync-1.37.1.json`).
 * Vaultwarden OMITS the login sub-fields it has no value for: a login with
 * no TOTP secret has no `totp` key at all, and one with no username has no
 * `username` key. An earlier version of this guard required them and
 * therefore rejected every real vault.
 *
 * The required fields are exactly the ones `decryptVault` dereferences
 * without a `??`: `id`, `type`, `name`, `favorite` and `organizationId`
 * (compared `=== null` to choose the parent key). Everything a consumer
 * already reads through `?.` or `??` is optional, so a server that trims a
 * field cannot silently produce an empty vault.
 */
export type RawCipher = {
  id: string;
  organizationId: string | null;
  folderId?: string | null;
  type: number;
  name: string;
  favorite: boolean;
  key?: string | null;
  login?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    uris?: RawCipherUri[] | null;
  } | null;
};

export type RawProfile = {
  organizations?: { id: string; name: string; key: string }[] | null;
};

export type SyncResponse = {
  profile: RawProfile;
  ciphers: RawCipher[];
  folders: { id: string; name: string }[];
};

/**
 * Narrows to an indexable object so properties can be READ as `unknown`
 * without an `in` guard per field. This is a type predicate, not a cast:
 * the runtime check is real, and every property it exposes still arrives
 * typed `unknown` and has to be checked before use.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

/** Absent, null, or a string — the shape of a field the server may omit. */
function isOptionalString(v: unknown): v is string | null | undefined {
  return v === undefined || isNullableString(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function isPreloginResponse(v: unknown): v is PreloginBody {
  if (!isRecord(v)) return false;
  // Exactly 0 (PBKDF2-SHA256) or 1 (Argon2id). `deriveMasterKey` throws on
  // anything else, and this guard is what makes that throw unreachable:
  // an unknown KDF type must be refused at the boundary, where it can be
  // reported as "this server's response was not understood", rather than
  // deep inside key derivation.
  if (v.kdf !== 0 && v.kdf !== 1) return false;
  // Positive: a zero or negative iteration count is not a weaker KDF, it is
  // a malformed one, and PBKDF2 with 0 iterations is rejected by WebCrypto
  // anyway.
  if (!isFiniteNumber(v.kdfIterations) || v.kdfIterations <= 0) return false;
  if (v.kdfMemory !== undefined && v.kdfMemory !== null && !isFiniteNumber(v.kdfMemory)) {
    return false;
  }
  if (
    v.kdfParallelism !== undefined &&
    v.kdfParallelism !== null &&
    !isFiniteNumber(v.kdfParallelism)
  ) {
    return false;
  }
  return isOptionalString(v.salt);
}

/**
 * The minimum every token response must satisfy. `access_token` and
 * `refresh_token` are required non-empty because an empty bearer token
 * would be sent to the server as a valid-looking credential and a lost
 * refresh token silently signs the user out at the next unlock.
 */
export function isTokenResponse(v: unknown): v is TokenResponse {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyString(v.access_token) &&
    isNonEmptyString(v.refresh_token) &&
    isFiniteNumber(v.expires_in)
  );
}

/**
 * A password-grant response, which must additionally carry the wrapped key
 * material. Both strings go straight into key unwrapping from `login.ts`
 * and are entirely server-controlled, so they are checked here rather than
 * being discovered as `undefined` inside `parseEncString`.
 */
export function isLoginTokenResponse(v: unknown): v is LoginTokenResponse {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.Key) || !isNonEmptyString(v.PrivateKey)) return false;
  return isTokenResponse(v);
}

/**
 * Whether a 400 body is a two-factor challenge.
 *
 * "Absent or empty means not a challenge" is deliberate and load-bearing:
 * an ordinary wrong-password 400 carries no provider list, and treating one
 * as a challenge would send the user to a 2FA screen they cannot satisfy
 * instead of telling them the credentials were wrong.
 */
export function isTwoFactorChallenge(v: unknown): v is TwoFactorChallenge {
  if (!isRecord(v)) return false;
  const p = v.TwoFactorProviders;
  if (!Array.isArray(p) || p.length === 0) return false;
  return p.every((e) => typeof e === "string" || typeof e === "number");
}

function isRawCipherUri(v: unknown): v is RawCipherUri {
  if (!isRecord(v)) return false;
  return isNullableString(v.uri) && (v.match == null || isFiniteNumber(v.match));
}

function isRawLogin(v: unknown): v is RawCipher["login"] {
  if (v === undefined || v === null) return true;
  if (!isRecord(v)) return false;
  return (
    isOptionalString(v.username) &&
    isOptionalString(v.password) &&
    isOptionalString(v.totp) &&
    (v.uris == null || (Array.isArray(v.uris) && v.uris.every(isRawCipherUri)))
  );
}

/**
 * Exported so a failing payload can be attributed to ONE cipher instead of
 * to the whole response — `isSyncResponse` can only answer false, which is
 * useless for working out which item the server sent differently.
 */
export function isRawCipher(v: unknown): v is RawCipher {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    isNullableString(v.organizationId) &&
    isOptionalString(v.folderId) &&
    isFiniteNumber(v.type) &&
    typeof v.name === "string" &&
    typeof v.favorite === "boolean" &&
    isOptionalString(v.key) &&
    isRawLogin(v.login)
  );
}

function isOrganization(v: unknown): v is { id: string; name: string; key: string } {
  if (!isRecord(v)) return false;
  return typeof v.id === "string" && typeof v.name === "string" && typeof v.key === "string";
}

function isFolder(v: unknown): v is { id: string; name: string } {
  if (!isRecord(v)) return false;
  return typeof v.id === "string" && typeof v.name === "string";
}

function isRawProfile(v: unknown): v is RawProfile {
  if (!isRecord(v)) return false;
  return (
    v.organizations == null ||
    (Array.isArray(v.organizations) && v.organizations.every(isOrganization))
  );
}

/**
 * Explicit runtime narrowing rather than a cast, mirroring `isStoredState`
 * in session/store.ts.
 *
 * Two callers, with deliberately different failure semantics:
 *
 *  - `sync()` validates the network response. A `false` there is an
 *    `InvalidResponseError` — loud, because a server whose ciphers this
 *    client cannot even parse must not be reported as a successful sync.
 *  - `Controller.loadFromCache` validates the offline cache. A `false`
 *    there means "no usable cache" and must NOT throw: that path runs
 *    during unlock, and throwing would leave the session unlocked while
 *    the unlock call rejected.
 *
 * The cache is a JSON string round-tripped through `browser.storage.local`.
 * It is our own data, but `JSON.parse` returns `any` and extension storage
 * is attacker-reachable on a compromised device, so nothing may assume a
 * shape here that has not been checked. Every field the vault decrypter
 * dereferences is validated, including the nested `login.uris` entries — a
 * cipher accepted as a bare `{}` would blow up (or silently misbehave) deep
 * inside `decryptVault`, far from any hint that the value was ever
 * unvalidated.
 *
 * What it must NOT do is reject fields the real server omits; see the
 * `RawCipher` doc comment and `tests/fixtures/sync-1.37.1.json`, a captured
 * response that this guard is tested against on every run.
 */
export function isSyncResponse(v: unknown): v is SyncResponse {
  if (!isRecord(v)) return false;
  return (
    isRawProfile(v.profile) &&
    Array.isArray(v.ciphers) &&
    v.ciphers.every(isRawCipher) &&
    Array.isArray(v.folders) &&
    v.folders.every(isFolder)
  );
}
