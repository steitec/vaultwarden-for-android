import { prelogin, requestToken } from "../api/identity";
import { sync } from "../api/sync";
import { deriveMasterKey, deriveMasterPasswordHash, type KdfConfig } from "../crypto/kdf";
import { unwrapUserKey, unwrapOrgKeyMap } from "../crypto/keys";
import { zero } from "../crypto/bytes";
import type { SymKey } from "../crypto/encstring";
import type { LoginTokenResponse, SyncResponse } from "../api/types";

export type LoginResult = {
  userKey: SymKey;
  orgKeys: Map<string, SymKey>;
  tokens: LoginTokenResponse;
  kdf: KdfConfig;
  payload: SyncResponse;
};

/**
 * One full master-password login: prelogin, token request, key unwrap, and
 * the first vault fetch.
 *
 * Error discipline, which the setup UI depends on:
 *
 *  - `TwoFactorRequiredError` from `requestToken` propagates UNCHANGED. It
 *    carries the provider list the 2FA screen needs, and it is the only way
 *    to tell "supply a second factor" apart from "those credentials are
 *    wrong". Nothing here may catch and re-throw it as a generic failure.
 *  - `InvalidCredentialsError` keeps its field-agnostic message. The server
 *    deliberately does not say whether the email or the password was wrong,
 *    and `prelogin` answers with plausible KDF parameters for accounts that
 *    do not exist. Do not invent a distinction the server withholds — it
 *    would turn this endpoint into an account-enumeration oracle.
 *
 * The master password itself is a plain string and cannot be zeroed in JS;
 * that is inherent to the message API it arrives over. What this module does
 * guarantee is that it never reaches an error message, a log line, or a
 * persisted field — and neither do the tokens or the derived password hash.
 *
 * Key hygiene: the master key and, on any failure, the freshly derived
 * user/organization keys are zeroed before this function returns. Ownership
 * of the returned keys transfers to the caller, which is then responsible
 * for zeroing them (see Session.adoptLogin).
 */
export async function performLogin(params: {
  serverUrl: string;
  email: string;
  password: string;
  deviceId: string;
  twoFactor?: { token: string; provider: number };
}): Promise<LoginResult> {
  const pre = await prelogin(params.serverUrl, params.email);
  const kdf: KdfConfig = {
    kdf: pre.kdf,
    iterations: pre.kdfIterations,
    memory: pre.kdfMemory,
    parallelism: pre.kdfParallelism,
    salt: pre.salt,
  };

  const masterKey = await deriveMasterKey(params.password, params.email, kdf);

  let userKey: SymKey | null = null;
  // Reassigned, not filled in place: unwrapOrgKeyMap builds its own map. The
  // `finally` below zeroes whichever map this ends up holding.
  let orgKeys = new Map<string, SymKey>();
  let transferred = false;
  try {
    const hash = await deriveMasterPasswordHash(masterKey, params.password);

    const tokens = await requestToken(
      params.serverUrl,
      params.email,
      hash,
      params.deviceId,
      params.twoFactor,
    );

    userKey = await unwrapUserKey(tokens.Key, masterKey);

    const payload = await sync(params.serverUrl, tokens.access_token);

    // `sync()` validates the payload structurally (isSyncResponse), so this
    // is a well-formed vault. `organizations` stays optional-chained
    // because the guard permits an absent/null list — an account in no
    // organizations is the common case, not an error.
    //
    // A private key that will not unwrap propagates and fails the whole
    // login: it means the master password produced a user key that cannot
    // read this account's own key material, which is not a state to sign in
    // over. Individual organizations that fail are skipped inside the
    // helper.
    orgKeys = await unwrapOrgKeyMap(
      tokens.PrivateKey,
      payload.profile.organizations ?? [],
      userKey,
    );

    transferred = true;
    return { userKey, orgKeys, tokens, kdf, payload };
  } finally {
    // The master key has no further use once the user key is unwrapped, and
    // no use at all on the failure paths. Zero it either way rather than
    // leaving password-equivalent material resident for the GC.
    zero(masterKey);
    if (!transferred) {
      if (userKey !== null) {
        zero(userKey.encKey);
        zero(userKey.macKey);
      }
      for (const k of orgKeys.values()) {
        zero(k.encKey);
        zero(k.macKey);
      }
    }
  }
}
