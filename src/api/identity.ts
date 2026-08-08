import {
  isPreloginResponse,
  isTokenResponse,
  isLoginTokenResponse,
  isTwoFactorChallenge,
  type PreloginResponse,
  type TokenResponse,
  type LoginTokenResponse,
} from "./types";

/** Bitwarden DeviceType.FirefoxExtension */
const DEVICE_TYPE = "3";

export class TwoFactorRequiredError extends Error {
  constructor(public providers: number[]) {
    super("Two-factor authentication required");
    this.name = "TwoFactorRequiredError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    // The server deliberately does not distinguish a wrong email from a wrong
    // password, and prelogin answers for accounts that do not exist. Do not
    // invent a distinction the server withholds.
    super("Email or password incorrect");
    this.name = "InvalidCredentialsError";
  }
}

export class ServerUnreachableError extends Error {
  constructor(cause: unknown) {
    super(
      "Could not reach the server. If it uses a self-signed certificate, open " +
        "it in Firefox once and accept the certificate, then try again.",
    );
    this.name = "ServerUnreachableError";
    this.cause = cause;
  }
}

export class PreloginFailedError extends Error {
  constructor(public status: number) {
    super(`Prelogin failed with status ${status}`);
    this.name = "PreloginFailedError";
  }
}

export class TokenRequestFailedError extends Error {
  constructor(public status: number) {
    super(`Token request failed with status ${status}`);
    this.name = "TokenRequestFailedError";
  }
}

/**
 * A response body that was not what the client expected: either not JSON at
 * all — e.g. an HTML error page served by a misconfigured reverse proxy
 * with a 200 status — or JSON whose structure a boundary guard rejected.
 * Distinct from a non-2xx status.
 *
 * The message is fixed and carries nothing from the response. `cause` may
 * hold a parse error or a short guard label; it is never promoted into
 * `.message`, and the popup refuses to render it, because everything on the
 * far side of this boundary is server-controlled text.
 */
export class InvalidResponseError extends Error {
  constructor(cause: unknown) {
    super("The server returned a response this client could not parse.");
    this.name = "InvalidResponseError";
    this.cause = cause;
  }
}

function base(server: string): string {
  return server.replace(/\/+$/, "");
}

export async function prelogin(server: string, email: string): Promise<PreloginResponse> {
  let res: Response;
  try {
    res = await fetch(`${base(server)}/identity/accounts/prelogin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch (e) {
    throw new ServerUnreachableError(e);
  }
  if (!res.ok) throw new PreloginFailedError(res.status);

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (e) {
    throw new InvalidResponseError(e);
  }
  // Validated, not asserted: `kdf` and `kdfIterations` go straight into key
  // derivation, and an unrecognised kdf value would otherwise only be
  // caught deep inside deriveMasterKey (or, worse, fall through to the
  // wrong algorithm). Optional fields are normalized to null here so no
  // caller has to distinguish absent from null.
  if (!isPreloginResponse(payload)) {
    throw new InvalidResponseError("prelogin response had unusable kdf parameters");
  }
  return {
    kdf: payload.kdf,
    kdfIterations: payload.kdfIterations,
    kdfMemory: payload.kdfMemory ?? null,
    kdfParallelism: payload.kdfParallelism ?? null,
    salt: payload.salt ?? null,
  };
}

/**
 * Posts to the token endpoint and returns the parsed body UNVALIDATED —
 * the two grants have different required fields (a refresh grant carries no
 * key material at all), so each caller applies its own guard.
 */
async function postToken(server: string, body: URLSearchParams): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base(server)}/identity/connect/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Device-Type": DEVICE_TYPE,
      },
      body: body.toString(),
    });
  } catch (e) {
    throw new ServerUnreachableError(e);
  }

  if (res.ok) {
    try {
      return await res.json();
    } catch (e) {
      throw new InvalidResponseError(e);
    }
  }

  // Only a 400 is the credential-ambiguous shape Vaultwarden uses for both
  // "wrong password" and a 2FA challenge. Any other status (404 misconfigured
  // URL, 429 rate limit, 500/502 server trouble, ...) is a distinct failure —
  // collapsing it into InvalidCredentialsError would tell a user their
  // correct password is wrong, and would mask client-side bugs (e.g. in
  // refreshToken) as ordinary session expiry.
  if (res.status !== 400) {
    throw new TokenRequestFailedError(res.status);
  }

  // An unparseable 400 body is not a 2FA challenge; `{}` keeps the
  // behaviour identical to a 400 that simply carries no provider list.
  const payload: unknown = await res.json().catch(() => ({}));
  if (isTwoFactorChallenge(payload)) {
    throw new TwoFactorRequiredError(payload.TwoFactorProviders.map(Number));
  }
  throw new InvalidCredentialsError();
}

export async function requestToken(
  server: string,
  email: string,
  masterPasswordHash: string,
  deviceId: string,
  twoFactor?: { token: string; provider: number },
): Promise<LoginTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "password",
    username: email,
    password: masterPasswordHash,
    scope: "api offline_access",
    client_id: "browser",
    deviceType: DEVICE_TYPE,
    deviceIdentifier: deviceId,
    deviceName: "firefox",
  });
  if (twoFactor) {
    body.set("twoFactorToken", twoFactor.token);
    body.set("twoFactorProvider", String(twoFactor.provider));
    body.set("twoFactorRemember", "1");
  }
  const payload = await postToken(server, body);
  // The strict guard: this response's `Key` and `PrivateKey` are fed
  // straight into unwrapUserKey/unwrapPrivateKey by login.ts, and both are
  // entirely server-controlled. Refuse here rather than discovering an
  // `undefined` inside parseEncString.
  if (!isLoginTokenResponse(payload)) {
    throw new InvalidResponseError("token response was missing tokens or key material");
  }
  return payload;
}

export async function refreshToken(server: string, token: string): Promise<TokenResponse> {
  const payload = await postToken(
    server,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "browser",
      refresh_token: token,
    }),
  );
  // Deliberately the loose guard: vaultwarden's refresh grant answers with
  // tokens only and no key material. Demanding Key/PrivateKey here would
  // reject every real refresh.
  if (!isTokenResponse(payload)) {
    throw new InvalidResponseError("refresh response did not contain tokens");
  }
  return payload;
}
