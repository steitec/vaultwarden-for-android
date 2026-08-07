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
  return (await res.json()) as PreloginResponse;
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

  if (res.ok) return (await res.json()) as TokenResponse;

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
