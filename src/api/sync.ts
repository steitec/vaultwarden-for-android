import { isSyncResponse, type SyncResponse } from "./types";
import { ServerUnreachableError, InvalidResponseError } from "./identity";

export class UnauthorizedError extends Error {
  constructor() {
    super("Access token rejected");
    this.name = "UnauthorizedError";
  }
}

export class SyncFailedError extends Error {
  constructor(public status: number) {
    super(`Sync failed with status ${status}`);
    this.name = "SyncFailedError";
  }
}

export async function sync(server: string, accessToken: string): Promise<SyncResponse> {
  let res: Response;
  try {
    res = await fetch(`${server.replace(/\/+$/, "")}/api/sync?excludeDomains=true`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    throw new ServerUnreachableError(e);
  }
  // 401 before the generic !ok: Controller.syncAttempt keys its
  // refresh-and-retry on exactly UnauthorizedError, so collapsing this into
  // SyncFailedError would break token refresh for every user whose access
  // token expires. Vaultwarden answers a rejected bearer token with an HTML
  // 401 page, so this must be decided on the status, not the body.
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new SyncFailedError(res.status);

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (e) {
    throw new InvalidResponseError(e);
  }
  // Loud, on purpose. A payload this client cannot parse used to become a
  // silently empty vault — `Controller.loadFromCache` validates the same
  // shape and treats a rejection as "no usable cache" — which reports a
  // successful sync and shows nothing. The guard is checked against a
  // captured 1.37.1 response in tests/api/types.test.ts, so a rejection
  // here really does mean the server sent something unexpected.
  if (!isSyncResponse(payload)) {
    throw new InvalidResponseError("sync response did not have the expected vault shape");
  }
  return payload;
}
