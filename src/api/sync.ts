import type { SyncResponse } from "./types";
import { ServerUnreachableError } from "./identity";

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
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new SyncFailedError(res.status);
  return (await res.json()) as SyncResponse;
}
