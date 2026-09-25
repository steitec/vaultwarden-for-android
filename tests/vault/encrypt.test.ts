import { describe, it, expect } from "vitest";
import { encryptNewCipher, DraftIncompleteError, type ItemDraft } from "../../src/vault/encrypt";
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
