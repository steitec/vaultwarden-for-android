import { describe, it, expect, vi, afterEach } from "vitest";
import {
  prelogin,
  requestToken,
  refreshToken,
  TwoFactorRequiredError,
  InvalidCredentialsError,
  TokenRequestFailedError,
  InvalidResponseError,
} from "../../src/api/identity";

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function stubFetchUnparseable(status: number) {
  const spy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
    text: async () => "<html>not json</html>",
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("prelogin", () => {
  it("posts json and returns kdf parameters", async () => {
    const spy = stubFetch(200, {
      kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null, salt: null,
    });
    const r = await prelogin("https://vault.example.net", "a@b.com");

    expect(r.kdf).toBe(0);
    expect(r.kdfIterations).toBe(600000);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://vault.example.net/identity/accounts/prelogin");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "a@b.com" });
  });

  it("strips a trailing slash from the server url", async () => {
    const spy = stubFetch(200, { kdf: 0, kdfIterations: 1, kdfMemory: null, kdfParallelism: null, salt: null });
    await prelogin("https://vault.example.net/", "a@b.com");
    expect(spy.mock.calls[0]![0]).toBe("https://vault.example.net/identity/accounts/prelogin");
  });

  it("raises InvalidResponseError instead of a raw SyntaxError when a 200 body is not parseable JSON", async () => {
    stubFetchUnparseable(200);
    const err = await prelogin("https://v.example.net", "a@b.com").catch((e) => e);
    expect(err).toBeInstanceOf(InvalidResponseError);
  });

  it.each([2, 99, -1, "0", null])(
    "raises InvalidResponseError for kdf %p instead of letting it reach deriveMasterKey",
    async (kdf) => {
      // deriveMasterKey throws "Unknown KDF type" for anything but 0 or 1.
      // This guard is what makes that throw unreachable: an unusable kdf is
      // a bad response, reported as such, not a key-derivation crash.
      stubFetch(200, { kdf, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null, salt: null });
      const err = await prelogin("https://v.example.net", "a@b.com").catch((e) => e);
      expect(err).toBeInstanceOf(InvalidResponseError);
    },
  );

  it.each([0, -5, "600000", null])("raises InvalidResponseError for kdfIterations %p", async (n) => {
    stubFetch(200, { kdf: 0, kdfIterations: n });
    const err = await prelogin("https://v.example.net", "a@b.com").catch((e) => e);
    expect(err).toBeInstanceOf(InvalidResponseError);
  });

  it("normalizes the optional fields a server may omit to null", async () => {
    stubFetch(200, { kdf: 0, kdfIterations: 600000 });
    const r = await prelogin("https://v.example.net", "a@b.com");
    expect(r).toEqual({
      kdf: 0,
      kdfIterations: 600000,
      kdfMemory: null,
      kdfParallelism: null,
      salt: null,
    });
  });

  it("keeps Argon2id parameters", async () => {
    stubFetch(200, { kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4, salt: null });
    const r = await prelogin("https://v.example.net", "a@b.com");
    expect(r.kdf).toBe(1);
    expect(r.kdfMemory).toBe(64);
    expect(r.kdfParallelism).toBe(4);
  });

  it("does not put the server's body into the error message", async () => {
    stubFetch(200, { kdf: 7, kdfIterations: 1, hint: "server-controlled text" });
    const err = await prelogin("https://v.example.net", "a@b.com").catch((e) => e);
    expect((err as Error).message).not.toMatch(/server-controlled/);
  });
});

describe("requestToken", () => {
  it("sends the documented form fields", async () => {
    const spy = stubFetch(200, {
      access_token: "at", refresh_token: "rt", expires_in: 3600, Key: "2.a|b|c", PrivateKey: "2.d|e|f",
    });
    await requestToken("https://v.example.net", "a@b.com", "hash==", "device-uuid");

    const body = new URLSearchParams(spy.mock.calls[0]![1].body as string);
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("username")).toBe("a@b.com");
    expect(body.get("password")).toBe("hash==");
    expect(body.get("scope")).toBe("api offline_access");
    expect(body.get("client_id")).toBe("browser");
    expect(body.get("deviceType")).toBe("3");
    expect(body.get("deviceIdentifier")).toBe("device-uuid");
  });

  it("raises TwoFactorRequiredError with the provider list", async () => {
    stubFetch(400, { error: "invalid_grant", TwoFactorProviders: ["0", "1"] });
    const err = await requestToken("https://v.example.net", "a@b.com", "h", "d").catch((e) => e);
    expect(err).toBeInstanceOf(TwoFactorRequiredError);
    expect((err as TwoFactorRequiredError).providers).toEqual([0, 1]);
  });

  it("includes two-factor fields on retry", async () => {
    const spy = stubFetch(200, {
      access_token: "at", refresh_token: "rt", expires_in: 3600, Key: "2.a|b|c", PrivateKey: "2.d|e|f",
    });
    await requestToken("https://v.example.net", "a@b.com", "h", "d", { token: "123456", provider: 0 });

    const body = new URLSearchParams(spy.mock.calls[0]![1].body as string);
    expect(body.get("twoFactorToken")).toBe("123456");
    expect(body.get("twoFactorProvider")).toBe("0");
    expect(body.get("twoFactorRemember")).toBe("1");
  });

  it("raises InvalidCredentialsError without claiming which field was wrong", async () => {
    stubFetch(400, { error: "invalid_grant", error_description: "username or password is incorrect" });
    const err = await requestToken("https://v.example.net", "a@b.com", "h", "d").catch((e) => e);
    expect(err).toBeInstanceOf(InvalidCredentialsError);
    expect((err as Error).message).toMatch(/email or password/i);
    expect((err as Error).message).not.toMatch(/account.*not.*(exist|found)/i);
  });

  it.each([404, 429, 500, 502])(
    "raises TokenRequestFailedError (not InvalidCredentialsError) for a %i server error",
    async (status) => {
      stubFetch(status, { error: "server_error" });
      const err = await requestToken("https://v.example.net", "a@b.com", "h", "d").catch((e) => e);
      expect(err).toBeInstanceOf(TokenRequestFailedError);
      expect((err as TokenRequestFailedError).status).toBe(status);
      expect(err).not.toBeInstanceOf(InvalidCredentialsError);
    },
  );

  it("raises TokenRequestFailedError for a 500 with an unparseable body, not InvalidCredentialsError", async () => {
    stubFetchUnparseable(500);
    const err = await requestToken("https://v.example.net", "a@b.com", "h", "d").catch((e) => e);
    expect(err).toBeInstanceOf(TokenRequestFailedError);
    expect(err).not.toBeInstanceOf(InvalidCredentialsError);
  });

  it("still raises InvalidCredentialsError with the identical message for a plain 400 (anti-enumeration unaffected)", async () => {
    stubFetch(400, { error: "invalid_grant" });
    const err = await requestToken("https://v.example.net", "a@b.com", "h", "d").catch((e) => e);
    expect(err).toBeInstanceOf(InvalidCredentialsError);
    expect((err as Error).message).toBe("Email or password incorrect");
  });

  it("raises InvalidResponseError instead of a raw SyntaxError when a 200 token body is not parseable JSON", async () => {
    stubFetchUnparseable(200);
    const err = await requestToken("https://v.example.net", "a@b.com", "h", "d").catch((e) => e);
    expect(err).toBeInstanceOf(InvalidResponseError);
  });

  it.each(["access_token", "refresh_token", "Key", "PrivateKey"])(
    "raises InvalidResponseError when the 200 body has no %s",
    async (field) => {
      // Key and PrivateKey are fed straight into unwrapUserKey /
      // unwrapPrivateKey by login.ts and are entirely server-controlled.
      // A missing one must fail here, not as an `undefined` inside
      // parseEncString.
      const body: Record<string, unknown> = {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        Key: "2.a|b|c",
        PrivateKey: "2.d|e|f",
      };
      delete body[field];
      stubFetch(200, body);
      const err = await requestToken("https://v.example.net", "a@b.com", "h", "d").catch((e) => e);
      expect(err).toBeInstanceOf(InvalidResponseError);
    },
  );

  it("raises InvalidResponseError when Key is an empty string", async () => {
    stubFetch(200, {
      access_token: "at", refresh_token: "rt", expires_in: 3600, Key: "", PrivateKey: "2.d|e|f",
    });
    const err = await requestToken("https://v.example.net", "a@b.com", "h", "d").catch((e) => e);
    expect(err).toBeInstanceOf(InvalidResponseError);
  });
});

describe("refreshToken", () => {
  it("sends the documented refresh_token grant fields", async () => {
    const spy = stubFetch(200, {
      access_token: "at", refresh_token: "rt2", expires_in: 3600, Key: "2.a|b|c", PrivateKey: "2.d|e|f",
    });
    await refreshToken("https://v.example.net", "rt-old");

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://v.example.net/identity/connect/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("browser");
    expect(body.get("refresh_token")).toBe("rt-old");
  });

  it("raises TokenRequestFailedError, not InvalidCredentialsError, for a 500", async () => {
    stubFetch(500, { error: "server_error" });
    const err = await refreshToken("https://v.example.net", "rt-old").catch((e) => e);
    expect(err).toBeInstanceOf(TokenRequestFailedError);
    expect(err).not.toBeInstanceOf(InvalidCredentialsError);
  });

  it("accepts a response with no key material, which is what the server actually sends", async () => {
    // Captured from vaultwarden 1.37.1: a refresh_token grant answers with
    // tokens only — no Key, no PrivateKey. Requiring them here would turn
    // every access-token refresh into an InvalidResponseError, i.e. would
    // sign out every user whose token expired.
    stubFetch(200, {
      refresh_token: "rt",
      access_token: "at",
      expires_in: 7200,
      token_type: "Bearer",
      scope: "api offline_access",
    });
    const r = await refreshToken("https://v.example.net", "rt");
    expect(r.access_token).toBe("at");
  });

  it("raises InvalidResponseError when the refreshed body has no access_token", async () => {
    stubFetch(200, { refresh_token: "rt", expires_in: 7200 });
    const err = await refreshToken("https://v.example.net", "rt").catch((e) => e);
    expect(err).toBeInstanceOf(InvalidResponseError);
  });
});
