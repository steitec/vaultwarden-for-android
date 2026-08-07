import { describe, it, expect, vi, afterEach } from "vitest";
import { prelogin, requestToken, TwoFactorRequiredError, InvalidCredentialsError } from "../../src/api/identity";

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
});
