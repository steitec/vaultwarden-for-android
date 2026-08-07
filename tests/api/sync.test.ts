import { describe, it, expect, vi, afterEach } from "vitest";
import { sync, UnauthorizedError, SyncFailedError } from "../../src/api/sync";
import { ServerUnreachableError, InvalidResponseError } from "../../src/api/identity";

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

describe("sync", () => {
  it("requests the sync endpoint with a bearer token and excludeDomains, returning the parsed body", async () => {
    const responseBody = {
      profile: { organizations: [] },
      ciphers: [],
      folders: [],
    };
    const spy = stubFetch(200, responseBody);

    const r = await sync("https://vault.example.net", "access-token-123");

    expect(r).toEqual(responseBody);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://vault.example.net/api/sync?excludeDomains=true");
    expect(init.headers.Authorization).toBe("Bearer access-token-123");
  });

  it("strips a trailing slash from the server url", async () => {
    const spy = stubFetch(200, { profile: { organizations: null }, ciphers: [], folders: [] });
    await sync("https://vault.example.net/", "t");
    expect(spy.mock.calls[0]![0]).toBe("https://vault.example.net/api/sync?excludeDomains=true");
  });

  it("raises UnauthorizedError for a 401", async () => {
    stubFetch(401, { error: "unauthorized" });
    const err = await sync("https://v.example.net", "expired-token").catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it("raises SyncFailedError (not UnauthorizedError) for a non-401 non-ok status", async () => {
    stubFetch(500, { error: "server_error" });
    const err = await sync("https://v.example.net", "t").catch((e) => e);
    expect(err).toBeInstanceOf(SyncFailedError);
    expect((err as SyncFailedError).status).toBe(500);
    expect(err).not.toBeInstanceOf(UnauthorizedError);
  });

  it("raises ServerUnreachableError when fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("NetworkError when attempting to fetch resource.")),
    );
    const err = await sync("https://v.example.net", "t").catch((e) => e);
    expect(err).toBeInstanceOf(ServerUnreachableError);
    expect((err as Error).message).toMatch(/self-signed/i);
  });

  it("raises InvalidResponseError instead of a raw SyntaxError when a 200 body is not parseable JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
        text: async () => "<html>not json</html>",
      }),
    );
    const err = await sync("https://v.example.net", "t").catch((e) => e);
    expect(err).toBeInstanceOf(InvalidResponseError);
  });
});
