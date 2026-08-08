export type PreloginResponse = {
  kdf: 0 | 1;
  kdfIterations: number;
  kdfMemory: number | null;
  kdfParallelism: number | null;
  salt: string | null;
};

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  /** EncString of the user key, wrapped under the stretched master key */
  Key: string;
  /** EncString of the PKCS#8 RSA private key, wrapped under the user key */
  PrivateKey: string;
};

export type RawCipherUri = { uri: string | null; match: number | null };

export type RawCipher = {
  id: string;
  organizationId: string | null;
  folderId: string | null;
  type: number;
  name: string;
  favorite: boolean;
  key: string | null;
  login: {
    username: string | null;
    password: string | null;
    totp: string | null;
    uris: RawCipherUri[] | null;
  } | null;
};

export type RawProfile = {
  organizations: { id: string; name: string; key: string }[] | null;
};

export type SyncResponse = {
  profile: RawProfile;
  ciphers: RawCipher[];
  folders: { id: string; name: string }[];
};

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isRawCipherUri(v: unknown): v is RawCipherUri {
  if (typeof v !== "object" || v === null) return false;
  if (!("uri" in v) || !("match" in v)) return false;
  return isNullableString(v.uri) && (v.match === null || isFiniteNumber(v.match));
}

function isRawLogin(v: unknown): v is RawCipher["login"] {
  if (v === null) return true;
  if (typeof v !== "object") return false;
  if (!("username" in v) || !("password" in v) || !("totp" in v) || !("uris" in v)) return false;
  return (
    isNullableString(v.username) &&
    isNullableString(v.password) &&
    isNullableString(v.totp) &&
    (v.uris === null || (Array.isArray(v.uris) && v.uris.every(isRawCipherUri)))
  );
}

function isRawCipher(v: unknown): v is RawCipher {
  if (typeof v !== "object" || v === null) return false;
  if (
    !("id" in v) ||
    !("organizationId" in v) ||
    !("folderId" in v) ||
    !("type" in v) ||
    !("name" in v) ||
    !("favorite" in v) ||
    !("key" in v) ||
    !("login" in v)
  ) {
    return false;
  }
  return (
    typeof v.id === "string" &&
    isNullableString(v.organizationId) &&
    isNullableString(v.folderId) &&
    isFiniteNumber(v.type) &&
    typeof v.name === "string" &&
    typeof v.favorite === "boolean" &&
    isNullableString(v.key) &&
    isRawLogin(v.login)
  );
}

function isOrganization(v: unknown): v is { id: string; name: string; key: string } {
  if (typeof v !== "object" || v === null) return false;
  if (!("id" in v) || !("name" in v) || !("key" in v)) return false;
  return typeof v.id === "string" && typeof v.name === "string" && typeof v.key === "string";
}

function isFolder(v: unknown): v is { id: string; name: string } {
  if (typeof v !== "object" || v === null) return false;
  if (!("id" in v) || !("name" in v)) return false;
  return typeof v.id === "string" && typeof v.name === "string";
}

function isRawProfile(v: unknown): v is RawProfile {
  if (typeof v !== "object" || v === null) return false;
  if (!("organizations" in v)) return false;
  return (
    v.organizations === null ||
    (Array.isArray(v.organizations) && v.organizations.every(isOrganization))
  );
}

/**
 * Explicit runtime narrowing rather than a cast, mirroring `isStoredState`
 * in session/store.ts.
 *
 * The offline cipher cache is a JSON string round-tripped through
 * `browser.storage.local`. It is our own data, but `JSON.parse` returns
 * `any` and extension storage is attacker-reachable on a compromised
 * device, so nothing may assume a shape here that has not been checked.
 * Every field the vault decrypter dereferences is validated, including the
 * nested `login.uris` entries — a cipher accepted as a bare `{}` would blow
 * up (or silently misbehave) deep inside `decryptVault`, far from any hint
 * that the value was ever unvalidated.
 *
 * Callers must treat a `false` result as "no usable cache", not as a fatal
 * error: see `Controller.loadFromCache`.
 */
export function isSyncResponse(v: unknown): v is SyncResponse {
  if (typeof v !== "object" || v === null) return false;
  if (!("profile" in v) || !("ciphers" in v) || !("folders" in v)) return false;
  return (
    isRawProfile(v.profile) &&
    Array.isArray(v.ciphers) &&
    v.ciphers.every(isRawCipher) &&
    Array.isArray(v.folders) &&
    v.folders.every(isFolder)
  );
}
