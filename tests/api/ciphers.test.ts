import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createCipher,
  updateCipher,
  deleteCipher,
  CipherWriteFailedError,
  CipherConflictError,
} from "../../src/api/ciphers";
import { UnauthorizedError } from "../../src/api/sync";
import { ServerUnreachableError } from "../../src/api/identity";

function stubFetch(status: number) {
  const spy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => "",
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

const body = { type: 1, name: "2.aaa|bbb|ccc" };

describe("createCipher", () => {
  it("posts the body to /api/ciphers with a bearer token", async () => {
    const spy = stubFetch(200);
    await createCipher("https://vault.example.net", "tok", body);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://vault.example.net/api/ciphers");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it("strips a trailing slash from the server url", async () => {
    const spy = stubFetch(200);
    await createCipher("https://vault.example.net/", "tok", body);
    expect(spy.mock.calls[0]![0]).toBe("https://vault.example.net/api/ciphers");
  });

  it("raises UnauthorizedError for a 401, which is what the retry keys on", async () => {
    stubFetch(401);
    const err = await createCipher("https://v.test", "tok", body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it("raises CipherWriteFailedError carrying the status for anything else", async () => {
    stubFetch(500);
    const err = await createCipher("https://v.test", "tok", body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CipherWriteFailedError);
    expect((err as CipherWriteFailedError).status).toBe(500);
    expect(err).not.toBeInstanceOf(UnauthorizedError);
  });

  it("does not treat a 400 on a create as a conflict: there is nothing to conflict with", async () => {
    stubFetch(400);
    const err = await createCipher("https://v.test", "tok", body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CipherWriteFailedError);
    expect(err).not.toBeInstanceOf(CipherConflictError);
  });

  it("raises ServerUnreachableError when fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("NetworkError")));
    const err = await createCipher("https://v.test", "tok", body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerUnreachableError);
  });

  it("says something a user can act on", async () => {
    stubFetch(500);
    const err = await createCipher("https://v.test", "tok", body).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/could not save/i);
  });
});

describe("updateCipher", () => {
  it("puts the body to /api/ciphers/{id}", async () => {
    const spy = stubFetch(200);
    await updateCipher("https://v.test", "tok", "abc-123", body);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://v.test/api/ciphers/abc-123");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it("reads a 400 as a concurrent edit, because that is what a stale lastKnownRevisionDate gets", async () => {
    stubFetch(400);
    const err = await updateCipher("https://v.test", "tok", "abc-123", body).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CipherConflictError);
    expect((err as Error).message).toMatch(/changed somewhere else/i);
  });

  it("still reports other failures as ordinary write failures", async () => {
    stubFetch(500);
    const err = await updateCipher("https://v.test", "tok", "abc-123", body).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CipherWriteFailedError);
    expect(err).not.toBeInstanceOf(CipherConflictError);
  });

  it("escapes an id that would otherwise change the path", async () => {
    const spy = stubFetch(200);
    await updateCipher("https://v.test", "tok", "../accounts/profile", body);
    expect(spy.mock.calls[0]![0]).toBe("https://v.test/api/ciphers/..%2Faccounts%2Fprofile");
  });
});

describe("deleteCipher", () => {
  it("puts to the trash route with no body", async () => {
    const spy = stubFetch(200);
    await deleteCipher("https://v.test", "tok", "abc-123");
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://v.test/api/ciphers/abc-123/delete");
    expect(init.method).toBe("PUT");
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("raises UnauthorizedError for a 401", async () => {
    stubFetch(401);
    const err = await deleteCipher("https://v.test", "tok", "abc-123").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
  });
});
