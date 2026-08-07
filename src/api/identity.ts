import type { PreloginResponse, TokenResponse } from "./types";

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
 * A response body that could not be parsed as JSON. Distinct from a
 * non-2xx status: this is a 2xx (or otherwise "successful") response whose
 * body was not what the client expected — e.g. an HTML error page served
 * by a misconfigured reverse proxy with a 200 status. Never embeds the
 * body itself, only the parse failure, so this stays safe to surface to
 * the user or log.
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
  try {
    return (await res.json()) as PreloginResponse;
  } catch (e) {
    throw new InvalidResponseError(e);
  }
}

async function postToken(server: string, body: URLSearchParams): Promise<TokenResponse> {
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
      return (await res.json()) as TokenResponse;
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

  const payload = (await res.json().catch(() => ({}))) as {
    TwoFactorProviders?: (string | number)[];
  };
  if (payload.TwoFactorProviders && payload.TwoFactorProviders.length > 0) {
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
): Promise<TokenResponse> {
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
  return postToken(server, body);
}

export async function refreshToken(server: string, token: string): Promise<TokenResponse> {
  return postToken(
    server,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "browser",
      refresh_token: token,
    }),
  );
}
