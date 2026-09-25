import { parseEncString, decryptToString, type SymKey } from "../crypto/encstring";
import { unwrapCipherKey } from "../crypto/keys";
import { uriMatches, type CipherUri, type UriMatchType } from "./uri-match";
import type { SyncResponse, RawCipher } from "../api/types";

export type VaultItem = {
  id: string;
  name: string;
  username: string | null;
  password: string | null;
  totp: string | null;
  uris: CipherUri[];
  favorite: boolean;
  /**
   * The organization that owns this item, or null for the personal vault.
   *
   * Read by the write path, which refuses an organization item: changing one
   * needs a different endpoint and a collection the user has never been asked
   * for. Carried on the item rather than re-derived from the cache, so the
   * refusal cannot disagree with what was decrypted.
   */
  organizationId: string | null;
  undecryptable: boolean;
};

const UNDECRYPTABLE_NAME = "⚠ This item cannot be decrypted";

async function maybe(value: string | null, key: SymKey): Promise<string | null> {
  if (value === null || value === "") return null;
  return decryptToString(parseEncString(value), key);
}

/**
 * Validates a raw match value against the known UriMatchType set instead of
 * asserting it with a type cast. Server JSON is unvalidated input: an
 * out-of-range value (e.g. 99) must become null, not flow through as a
 * falsely-typed UriMatchType that downstream consumers would trust.
 */
function normalizeMatch(match: number | null): UriMatchType | null {
  switch (match) {
    case 0:
      return 0;
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 3;
    case 4:
      return 4;
    case 5:
      return 5;
    default:
      return null;
  }
}

async function decryptCipher(raw: RawCipher, parentKey: SymKey): Promise<VaultItem> {
  const key = await unwrapCipherKey(raw.key, parentKey);

  const uris: CipherUri[] = [];
  for (const u of raw.login?.uris ?? []) {
    const decrypted = await maybe(u.uri, key);
    if (decrypted !== null) {
      uris.push({ uri: decrypted, match: normalizeMatch(u.match) });
    }
  }

  return {
    id: raw.id,
    name: (await maybe(raw.name, key)) ?? "(no name)",
    username: await maybe(raw.login?.username ?? null, key),
    password: await maybe(raw.login?.password ?? null, key),
    totp: await maybe(raw.login?.totp ?? null, key),
    uris,
    favorite: raw.favorite,
    organizationId: raw.organizationId,
    undecryptable: false,
  };
}

export async function decryptVault(
  payload: SyncResponse,
  userKey: SymKey,
  orgKeys: Map<string, SymKey>,
): Promise<VaultItem[]> {
  const items: VaultItem[] = [];

  for (const raw of payload.ciphers) {
    if (raw.type !== 1) continue; // logins only in v1

    // An item in the trash is not part of the vault. Without this it is
    // listed and offered for filling — which is what this add-on did until
    // 2026-09, because nothing here ever looked at the field. `!= null`
    // covers both spellings the server uses: an absent key and an explicit
    // null both mean "not trashed".
    if (raw.deletedDate != null) continue;

    const parentKey =
      raw.organizationId === null ? userKey : orgKeys.get(raw.organizationId);

    if (parentKey === undefined) {
      items.push(undecryptablePlaceholder(raw));
      continue;
    }

    try {
      items.push(await decryptCipher(raw, parentKey));
    } catch {
      // Surface the failure rather than silently omitting the entry: a missing
      // item looks like it was never there, which hides data loss.
      items.push(undecryptablePlaceholder(raw));
    }
  }

  return items;
}

function undecryptablePlaceholder(raw: RawCipher): VaultItem {
  return {
    id: raw.id,
    name: UNDECRYPTABLE_NAME,
    username: null,
    password: null,
    totp: null,
    uris: [],
    favorite: raw.favorite,
    organizationId: raw.organizationId,
    undecryptable: true,
  };
}

export function searchItems(items: VaultItem[], query: string): VaultItem[] {
  const q = query.trim().toLowerCase();
  // Return a fresh array even for an empty query. Returning `items` itself
  // would let a caller that sorts/splices the "all items" result mutate the
  // vault store's own array in place, and only on the empty-query path —
  // exactly the kind of intermittent bug that is miserable to track down.
  if (q === "") return [...items];
  return items.filter(
    (i) =>
      i.name.toLowerCase().includes(q) ||
      (i.username?.toLowerCase().includes(q) ?? false) ||
      i.uris.some((u) => u.uri.toLowerCase().includes(q)),
  );
}

export function matchItems(items: VaultItem[], pageUrl: string): VaultItem[] {
  return items.filter((i) => i.uris.some((u) => uriMatches(pageUrl, u)));
}
