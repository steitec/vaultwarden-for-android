import { ServerUnreachableError } from "./identity";
import { UnauthorizedError } from "./sync";

/**
 * The server refused a write.
 *
 * Carries the status for diagnosis, and a message the popup can render as it
 * stands — `errorText` shows `.message` to the user, so every message that can
 * reach it has to be a sentence rather than a code.
 */
export class CipherWriteFailedError extends Error {
  constructor(readonly status: number) {
    super(`The server could not save this change (status ${status}). Try again in a moment.`);
    this.name = "CipherWriteFailedError";
  }
}

/**
 * The entry changed on the server since this device last synced.
 *
 * Vaultwarden 1.37.1 answers an update carrying a stale `lastKnownRevisionDate`
 * with 400 — confirmed by the probe in `tests/integration/live.test.ts`. That
 * is the ONLY reason this client sends the field, so a 400 on an update is
 * read as the guard doing its job rather than as a malformed request.
 *
 * Deliberately not applied to a create: there is nothing for a new item to
 * conflict with, so a 400 there means something else entirely and must not be
 * dressed up as a concurrent edit.
 */
export class CipherConflictError extends Error {
  constructor() {
    super("This entry changed somewhere else. Sync and try again.");
    this.name = "CipherConflictError";
  }
}

/**
 * One authenticated write, with the error classification `sync()` uses.
 *
 * 401 becomes UnauthorizedError BEFORE the generic !ok, because
 * `Controller.withAccessToken` keys its refresh-and-retry on exactly that
 * class — and on nothing else. A write is not idempotent: a POST that reached
 * the server and lost its response would create a second item if it were
 * retried. A 401 is the one status that proves the request was never applied.
 *
 * The id goes through encodeURIComponent. It should always be a server-issued
 * UUID, but this is the point where a string becomes a URL path, and a path is
 * not somewhere to start trusting a caller.
 */
async function write(
  server: string,
  accessToken: string,
  path: string,
  method: "POST" | "PUT",
  options: { body?: Record<string, unknown>; conflictOn400?: boolean } = {},
): Promise<void> {
  const { body, conflictOn400 = false } = options;
  let res: Response;
  try {
    res = await fetch(`${server.replace(/\/+$/, "")}${path}`, {
      method,
      headers:
        body === undefined
          ? { Authorization: `Bearer ${accessToken}` }
          : { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new ServerUnreachableError(e);
  }
  if (res.status === 401) throw new UnauthorizedError();
  if (res.status === 400 && conflictOn400) throw new CipherConflictError();
  if (!res.ok) throw new CipherWriteFailedError(res.status);
}

export async function createCipher(
  server: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  await write(server, accessToken, "/api/ciphers", "POST", { body });
}

export async function updateCipher(
  server: string,
  accessToken: string,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  await write(server, accessToken, `/api/ciphers/${encodeURIComponent(id)}`, "PUT", {
    body,
    conflictOn400: true,
  });
}

/**
 * Moves an item to the trash.
 *
 * Not permanent deletion, which this add-on does not offer at all: a phone is
 * too easy to mistap, and the web vault can restore from the trash.
 */
export async function deleteCipher(server: string, accessToken: string, id: string): Promise<void> {
  await write(server, accessToken, `/api/ciphers/${encodeURIComponent(id)}/delete`, "PUT");
}
