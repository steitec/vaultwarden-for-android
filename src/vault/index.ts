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
  undecryptable: boolean;
};

const UNDECRYPTABLE_NAME = "⚠ This item cannot be decrypted";

async function maybe(value: string | null, key: SymKey): Promise<string | null> {
  if (value === null || value === "") return null;
  return decryptToString(parseEncString(value), key);
}

async function decryptCipher(raw: RawCipher, parentKey: SymKey): Promise<VaultItem> {
  const key = await unwrapCipherKey(raw.key, parentKey);

  const uris: CipherUri[] = [];
  for (const u of raw.login?.uris ?? []) {
    const decrypted = await maybe(u.uri, key);
    if (decrypted !== null) {
      uris.push({ uri: decrypted, match: (u.match as UriMatchType | null) ?? null });
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
    undecryptable: true,
  };
}

export function searchItems(items: VaultItem[], query: string): VaultItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return items;
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
