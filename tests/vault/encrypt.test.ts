import { describe, it, expect } from "vitest";
import {
  encryptNewCipher,
  encryptUpdatedCipher,
  DraftIncompleteError,
  type ItemDraft,
} from "../../src/vault/encrypt";
import { encryptToString } from "../../src/crypto/encstring";
import { utf8 } from "../../src/crypto/bytes";
import { decryptVault, type VaultItem } from "../../src/vault/index";
import type { SymKey } from "../../src/crypto/encstring";
import type { SyncResponse } from "../../src/api/types";

const userKey: SymKey = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) };

const draft: ItemDraft = {
  name: "GitHub",
  username: "octocat",
  uri: "https://github.com",
  password: "hunter2",
};

/**
 * Reads a request body back through the production decrypter.
 *
 * The decrypter is the oracle. If it cannot read what the encrypter wrote,
 * the encrypter is wrong — and no assertion about base64 could have told us
 * that. This is the whole reason encrypt.ts holds no state: both halves fit
 * in one test with nothing else in the room.
 */
async function readBack(body: Record<string, unknown>): Promise<VaultItem[]> {
  const payload = {
    profile: { organizations: null },
    folders: [],
    ciphers: [{ ...body, id: "c1" }],
  } as unknown as SyncResponse;
  return decryptVault(payload, userKey, new Map());
}

describe("encryptNewCipher", () => {
  it("produces a login cipher the vault decrypter reads back field for field", async () => {
    const [item] = await readBack(await encryptNewCipher(draft, userKey));
    expect(item!.name).toBe("GitHub");
    expect(item!.username).toBe("octocat");
    expect(item!.password).toBe("hunter2");
    expect(item!.uris[0]!.uri).toBe("https://github.com");
    expect(item!.undecryptable).toBe(false);
  });

  it("is a personal login with no per-cipher key", async () => {
    const body = await encryptNewCipher(draft, userKey);
    expect(body.type).toBe(1);
    expect(body.key).toBeNull();
    expect(body.organizationId).toBeNull();
    expect(body.folderId).toBeNull();
  });

  it("omits an empty username instead of encrypting an empty string", async () => {
    // An encrypted "" decrypts to "", which `maybe()` cannot tell from a real
    // value — so the entry would claim a username nobody typed.
    const body = await encryptNewCipher({ ...draft, username: "" }, userKey);
    expect(body.login).not.toHaveProperty("username");
    const [item] = await readBack(body);
    expect(item!.username).toBeNull();
  });

  it("omits the uris array entirely when no URL was given", async () => {
    const body = await encryptNewCipher({ ...draft, uri: "" }, userKey);
    expect(body.login).not.toHaveProperty("uris");
    const [item] = await readBack(body);
    expect(item!.uris).toEqual([]);
  });

  it("trims the name it encrypts", async () => {
    const [item] = await readBack(await encryptNewCipher({ ...draft, name: "  GitHub  " }, userKey));
    expect(item!.name).toBe("GitHub");
  });

  it("encrypts the same draft to different ciphertext each time", async () => {
    // A fresh iv per call. Identical ciphertext would mean a reused iv, which
    // is a real weakness and an easy one to introduce.
    const a = await encryptNewCipher(draft, userKey);
    const b = await encryptNewCipher(draft, userKey);
    expect(a.name).not.toBe(b.name);
  });

  it("refuses a draft with no name", async () => {
    await expect(encryptNewCipher({ ...draft, name: "   " }, userKey)).rejects.toBeInstanceOf(
      DraftIncompleteError,
    );
  });

  it("refuses a new entry with no password, because fill() would refuse it", async () => {
    await expect(encryptNewCipher({ ...draft, password: null }, userKey)).rejects.toBeInstanceOf(
      DraftIncompleteError,
    );
    await expect(encryptNewCipher({ ...draft, password: "" }, userKey)).rejects.toBeInstanceOf(
      DraftIncompleteError,
    );
  });

  it("says something the user can act on when it refuses", async () => {
    const err = await encryptNewCipher({ ...draft, name: "" }, userKey).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/needs a name/i);
  });
});

/** A cached cipher as /api/sync delivers it, plus fields this client never models. */
async function cached(): Promise<Record<string, unknown>> {
  return {
    id: "c1",
    organizationId: null,
    folderId: "f1",
    type: 1,
    name: await encryptToString(utf8("GitHub"), userKey),
    favorite: true,
    key: null,
    notes: await encryptToString(utf8("recovery codes in the safe"), userKey),
    fields: [
      {
        type: 0,
        name: await encryptToString(utf8("PIN"), userKey),
        value: await encryptToString(utf8("1234"), userKey),
      },
    ],
    reprompt: 0,
    revisionDate: "2026-09-01T08:00:00.000Z",
    login: {
      username: await encryptToString(utf8("octocat"), userKey),
      password: await encryptToString(utf8("hunter2"), userKey),
      totp: await encryptToString(utf8("JBSWY3DPEHPK3PXP"), userKey),
      uris: [
        { uri: await encryptToString(utf8("https://github.com"), userKey), match: null },
        { uri: await encryptToString(utf8("https://gist.github.com"), userKey), match: 3 },
      ],
    },
  };
}

const NOW = "2026-09-25T12:00:00.000Z";
const FIRST_URI = { uri: "https://github.com" };
const unchanged: ItemDraft = {
  name: "GitHub",
  username: "octocat",
  uri: "https://github.com",
  password: null,
};

function loginOf(body: Record<string, unknown>): Record<string, unknown> {
  return body.login as Record<string, unknown>;
}

describe("encryptUpdatedCipher", () => {
  it("keeps every field this client does not model", async () => {
    // The whole reason the body is built from the raw cipher. Built from a
    // VaultItem, every one of these would be gone after one save.
    const raw = await cached();
    const body = await encryptUpdatedCipher(raw, unchanged, FIRST_URI, userKey, NOW);

    expect(body.notes).toBe(raw.notes);
    expect(body.fields).toEqual(raw.fields);
    expect(body.folderId).toBe("f1");
    expect(body.favorite).toBe(true);
    expect(body.reprompt).toBe(0);
    expect(loginOf(body).totp).toBe(loginOf(raw).totp);
  });

  it("copies an unchanged password byte for byte instead of re-encrypting it", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(raw, unchanged, FIRST_URI, userKey, NOW);
    expect(loginOf(body).password).toBe(loginOf(raw).password);
  });

  it("replaces the password when one was typed", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(
      raw,
      { ...unchanged, password: "correct horse" },
      FIRST_URI,
      userKey,
      NOW,
    );
    expect(loginOf(body).password).not.toBe(loginOf(raw).password);
    const [item] = await readBack(body);
    expect(item!.password).toBe("correct horse");
  });

  it("keeps further URLs and their match types, and copies an unchanged first URL verbatim", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(raw, unchanged, FIRST_URI, userKey, NOW);
    const uris = loginOf(body).uris as { uri: string; match: number | null }[];
    const original = loginOf(raw).uris as { uri: string; match: number | null }[];
    expect(uris).toHaveLength(2);
    expect(uris[0]).toEqual(original[0]);
    expect(uris[1]).toEqual(original[1]);
  });

  it("replaces only the first URL when it changed, keeping the rest and its own match type", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(
      raw,
      { ...unchanged, uri: "https://github.example" },
      FIRST_URI,
      userKey,
      NOW,
    );
    const original = loginOf(raw).uris as { match: number | null }[];
    const [item] = await readBack(body);
    expect(item!.uris[0]!.uri).toBe("https://github.example");
    expect(item!.uris[1]!.uri).toBe("https://gist.github.com");
    expect((loginOf(body).uris as { match: number | null }[])[1]).toEqual(original[1]);
  });

  it("keeps the first URL's match type when only its text changed", async () => {
    // A user correcting a typo has not asked for the matching RULE to change.
    const raw = await cached();
    const login = { ...loginOf(raw) };
    login.uris = [{ uri: await encryptToString(utf8("https://github.com"), userKey), match: 3 }];
    const body = await encryptUpdatedCipher(
      { ...raw, login },
      { ...unchanged, uri: "https://github.example" },
      FIRST_URI,
      userKey,
      NOW,
    );
    expect((loginOf(body).uris as { match: number | null }[])[0]!.match).toBe(3);
  });

  it("adds a first URL to an item that had none", async () => {
    const raw = await cached();
    const login = { ...loginOf(raw) };
    delete login.uris;
    const body = await encryptUpdatedCipher(
      { ...raw, login },
      { ...unchanged, uri: "https://new.example" },
      { uri: null },
      userKey,
      NOW,
    );
    const [item] = await readBack(body);
    expect(item!.uris.map((u) => u.uri)).toEqual(["https://new.example"]);
  });

  it("drops the first URL when the user emptied the field, keeping the rest", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(
      raw,
      { ...unchanged, uri: "" },
      FIRST_URI,
      userKey,
      NOW,
    );
    const [item] = await readBack(body);
    expect(item!.uris.map((u) => u.uri)).toEqual(["https://gist.github.com"]);
  });

  it("clears a username the user emptied", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(
      raw,
      { ...unchanged, username: "" },
      FIRST_URI,
      userKey,
      NOW,
    );
    expect(loginOf(body).username).toBeNull();
    const [item] = await readBack(body);
    expect(item!.username).toBeNull();
  });

  it("encrypts under the item's own key when it has one, and sends that key back unchanged", async () => {
    // Encrypting under the user key here would leave the item permanently
    // undecryptable, and nothing but a round trip would reveal it.
    const itemKeyRaw = new Uint8Array(64).fill(9);
    const itemKey: SymKey = { encKey: itemKeyRaw.slice(0, 32), macKey: itemKeyRaw.slice(32) };
    const raw = {
      ...(await cached()),
      key: await encryptToString(itemKeyRaw, userKey),
      name: await encryptToString(utf8("GitHub"), itemKey),
      login: { password: await encryptToString(utf8("hunter2"), itemKey) },
    };

    const body = await encryptUpdatedCipher(
      raw,
      { ...unchanged, name: "Renamed" },
      { uri: null },
      itemKey,
      NOW,
    );

    expect(body.key).toBe(raw.key);
    const [item] = await readBack(body);
    expect(item!.name).toBe("Renamed");
    expect(item!.password).toBe("hunter2");
  });

  it("sends the cached revision as lastKnownRevisionDate, so a concurrent edit is refused", async () => {
    // 1.37.1 answers a stale one with 400 (confirmed by the integration
    // probe). Omitting it would make every save last-writer-wins.
    const raw = await cached();
    const body = await encryptUpdatedCipher(raw, unchanged, FIRST_URI, userKey, NOW);
    expect(body.lastKnownRevisionDate).toBe("2026-09-01T08:00:00.000Z");
  });

  it("omits lastKnownRevisionDate when the cache has no revision to report", async () => {
    // Better an unguarded write than one guarded by a value we invented.
    const raw = await cached();
    delete raw.revisionDate;
    const body = await encryptUpdatedCipher(raw, unchanged, FIRST_URI, userKey, NOW);
    expect(body).not.toHaveProperty("lastKnownRevisionDate");
  });

  it("refuses an update with no name", async () => {
    await expect(
      encryptUpdatedCipher(await cached(), { ...unchanged, name: " " }, FIRST_URI, userKey, NOW),
    ).rejects.toBeInstanceOf(DraftIncompleteError);
  });
});
