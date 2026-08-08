import { prelogin, requestToken } from "../api/identity";
import { sync } from "../api/sync";
import { deriveMasterKey, deriveMasterPasswordHash, type KdfConfig } from "../crypto/kdf";
import { unwrapUserKey, unwrapPrivateKey, unwrapOrgKey } from "../crypto/keys";
import { zero } from "../crypto/bytes";
import type { SymKey } from "../crypto/encstring";
import type { TokenResponse, SyncResponse } from "../api/types";

export type LoginResult = {
  userKey: SymKey;
  orgKeys: Map<string, SymKey>;
  tokens: TokenResponse;
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
  const orgKeys = new Map<string, SymKey>();
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

    // `payload` is not yet structurally validated (that lands with the
    // captured-server-response fixture in Task 16), so reach into it
    // defensively: a server that answered 200 with an unexpected body must
    // not crash setup with a raw TypeError.
    const orgs = payload.profile?.organizations ?? [];
    if (orgs.length > 0) {
      const privateKey = await unwrapPrivateKey(tokens.PrivateKey, userKey);
      for (const org of orgs) {
        try {
          orgKeys.set(org.id, await unwrapOrgKey(org.key, privateKey));
        } catch {
          // One unreadable organization must not prevent the rest of the
          // vault from loading; its items surface as undecryptable.
        }
      }
    }

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
