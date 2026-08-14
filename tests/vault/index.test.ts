import { describe, it, expect } from "vitest";
import { decryptVault, searchItems, matchItems, type VaultItem } from "../../src/vault/index";
import type { SymKey } from "../../src/crypto/encstring";
import type { SyncResponse } from "../../src/api/types";
import { toBase64, concat, type Bytes } from "../../src/crypto/bytes";

const userKey: SymKey = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) };
const orgKey: SymKey = { encKey: new Uint8Array(32).fill(5), macKey: new Uint8Array(32).fill(6) };

async function wrapBytes(data: Bytes, key: SymKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ck = await crypto.subtle.importKey("raw", key.encKey, "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, data));
  const mk = await crypto.subtle.importKey("raw", key.macKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", mk, concat(iv, ct)));
  return `2.${toBase64(iv)}|${toBase64(ct)}|${toBase64(mac)}`;
}

async function wrap(text: string, key: SymKey): Promise<string> {
  return wrapBytes(new TextEncoder().encode(text), key);
}

async function payload(overrides: Partial<SyncResponse["ciphers"][0]> = {}): Promise<SyncResponse> {
  return {
    profile: { organizations: null },
    folders: [],
    ciphers: [
      {
        id: "c1",
        organizationId: null,
        folderId: null,
        type: 1,
        name: await wrap("GitHub", userKey),
        favorite: false,
        key: null,
        login: {
          username: await wrap("octocat", userKey),
          password: await wrap("hunter2", userKey),
          totp: null,
          uris: [{ uri: await wrap("https://github.com", userKey), match: null }],
        },
        ...overrides,
      },
    ],
  };
}

describe("decryptVault", () => {
  it("decrypts name, username, password, and uris", async () => {
    const [item] = await decryptVault(await payload(), userKey, new Map());
    expect(item!.name).toBe("GitHub");
    expect(item!.username).toBe("octocat");
    expect(item!.password).toBe("hunter2");
    expect(item!.uris[0]!.uri).toBe("https://github.com");
    expect(item!.undecryptable).toBe(false);
  });

  it("skips non-login cipher types", async () => {
    expect(await decryptVault(await payload({ type: 2 }), userKey, new Map())).toHaveLength(0);
  });

  it("marks an undecryptable cipher rather than dropping it", async () => {
    const p = await payload();
    p.ciphers[0]!.name = "2.aaaa|bbbb|cccc";
    const [item] = await decryptVault(p, userKey, new Map());
    expect(item!.undecryptable).toBe(true);
    expect(item!.name).toMatch(/cannot be decrypted/i);
  });

  it("uses a per-cipher key when the cipher carries one", async () => {
    const cipherKeyRaw = crypto.getRandomValues(new Uint8Array(64));
    const cipherKey: SymKey = { encKey: cipherKeyRaw.slice(0, 32), macKey: cipherKeyRaw.slice(32) };
    const p = await payload();
    // Wrap the raw key bytes directly. Round-tripping them through a string
    // corrupts every byte above 0x7F on re-encoding.
    p.ciphers[0]!.key = await wrapBytes(cipherKeyRaw, userKey);
    // Re-wrap the fields under the per-cipher key.
    p.ciphers[0]!.name = await wrap("Scoped", cipherKey);
    p.ciphers[0]!.login!.username = await wrap("scoped-user", cipherKey);
    p.ciphers[0]!.login!.password = await wrap("scoped-pass", cipherKey);
    p.ciphers[0]!.login!.uris = [{ uri: await wrap("https://scoped.example", cipherKey), match: null }];

    const [item] = await decryptVault(p, userKey, new Map());
    expect(item!.name).toBe("Scoped");
    expect(item!.username).toBe("scoped-user");
  });

  it("decrypts an organization item using the matching org key", async () => {
    const p = await payload({ organizationId: "org1" });
    p.ciphers[0]!.name = await wrap("OrgSecret", orgKey);
    p.ciphers[0]!.login!.username = await wrap("org-user", orgKey);
    p.ciphers[0]!.login!.password = await wrap("org-pass", orgKey);
    p.ciphers[0]!.login!.uris = [{ uri: await wrap("https://org.example", orgKey), match: null }];

    const [item] = await decryptVault(p, userKey, new Map([["org1", orgKey]]));
    expect(item!.name).toBe("OrgSecret");
    expect(item!.username).toBe("org-user");
    expect(item!.password).toBe("org-pass");
    expect(item!.uris[0]!.uri).toBe("https://org.example");
    expect(item!.undecryptable).toBe(false);
  });

  it("marks an organization item undecryptable when its org key is absent, never falling back to the user key", async () => {
    // Fields are wrapped under userKey (the payload() default). If the
    // implementation ever fell back to the user key when the org key is
    // missing, this item would actually decrypt successfully to "GitHub" —
    // that is exactly the bug this test must catch.
    const p = await payload({ organizationId: "org1" });
    const items = await decryptVault(p, userKey, new Map()); // no "org1" entry
    expect(items).toHaveLength(1);
    expect(items[0]!.undecryptable).toBe(true);
    expect(items[0]!.name).not.toBe("GitHub");
    expect(items[0]!.name).toMatch(/cannot be decrypted/i);
  });
});

describe("searchItems", () => {
  const items: VaultItem[] = [
    { id: "1", name: "GitHub", username: "octocat", password: null, totp: null, uris: [], favorite: false, undecryptable: false },
    { id: "2", name: "GitLab", username: "fox", password: null, totp: null, uris: [{ uri: "https://gitlab.com", match: null }], favorite: false, undecryptable: false },
  ];

  it("matches on name, case-insensitively", () => {
    expect(searchItems(items, "github").map((i) => i.id)).toEqual(["1"]);
  });

  it("matches on username", () => {
    expect(searchItems(items, "octo").map((i) => i.id)).toEqual(["1"]);
  });

  it("matches on uri", () => {
    expect(searchItems(items, "gitlab.com").map((i) => i.id)).toEqual(["2"]);
  });

  it("returns everything for an empty query", () => {
    expect(searchItems(items, "  ")).toHaveLength(2);
  });
});

describe("matchItems", () => {
  const items: VaultItem[] = [
    { id: "1", name: "GitHub", username: "a", password: null, totp: null, uris: [{ uri: "https://github.com", match: null }], favorite: false, undecryptable: false },
    { id: "2", name: "Other", username: "b", password: null, totp: null, uris: [{ uri: "https://example.com", match: null }], favorite: false, undecryptable: false },
  ];

  it("returns only items matching the page url", () => {
    expect(matchItems(items, "https://gist.github.com/x").map((i) => i.id)).toEqual(["1"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(matchItems(items, "https://unrelated.test/")).toHaveLength(0);
  });

  it("never matches a 'never' (match: 5) uri, even when the hostname coincides", () => {
    const neverItems: VaultItem[] = [
      {
        id: "3",
        name: "Never",
        username: null,
        password: null,
        totp: null,
        uris: [{ uri: "https://example.com/login", match: 5 }],
        favorite: false,
        undecryptable: false,
      },
    ];
    expect(matchItems(neverItems, "https://example.com/login")).toEqual([]);
  });
});
