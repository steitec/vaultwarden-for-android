import { describe, it, expect, afterEach, vi } from "vitest";

const DATA_MODULE = "../../src/vault/public-suffix-data";
const PSL_MODULE = "../../src/vault/public-suffix";

type Psl = typeof import("../../src/vault/public-suffix");

/**
 * Loads public-suffix.ts over a synthetic rule list.
 *
 * The module builds its index once, at import time, from the vendored data
 * module — so a rule set that is not in that data can only be exercised by
 * replacing the data module and re-importing. `vi.resetModules()` is what
 * forces the index to be rebuilt; without it the second call would hand back
 * the first call's already-built index.
 */
async function pslWith(rules: string): Promise<Psl> {
  vi.resetModules();
  vi.doMock(DATA_MODULE, () => ({ PUBLIC_SUFFIX_RULES: rules }));
  return import(PSL_MODULE);
}

afterEach(() => {
  vi.doUnmock(DATA_MODULE);
  vi.resetModules();
});

describe("getPublicSuffix over a synthetic rule set", () => {
  it("returns the exact rule that matched", async () => {
    const psl = await pslWith("com\nco.uk\n");
    expect(psl.getPublicSuffix("example.com")).toBe("com");
    expect(psl.getPublicSuffix("shop.example.co.uk")).toBe("co.uk");
    expect(psl.getPublicSuffix("example.invalidtld")).toBeNull();
  });

  it("prefers a wildcard over the shorter exact rule beneath it", async () => {
    const psl = await pslWith("ck\n*.ck\n");
    expect(psl.getPublicSuffix("blog.example.ck")).toBe("example.ck");
  });

  it("strips the leftmost label of a multi-label exception rule", async () => {
    // The real list's shape: "*.ck" makes every second-level label a public
    // suffix, and "!www.ck" carves www back out so that www.ck is a site.
    const psl = await pslWith("ck\n*.ck\n!www.ck\n");
    expect(psl.getPublicSuffix("www.ck")).toBe("ck");
    expect(psl.registrableDomain("www.ck")).toBe("www.ck");
  });
});

describe("a single-label exception rule", () => {
  // There is no 1-label exception rule in the vendored data — the list's own
  // format guarantees an exception always negates a wildcard, which needs at
  // least two labels. This is therefore a latent defect, and the only way to
  // reach it is to supply the rule. A data refresh is the whole distance
  // between latent and live, and this function decides which stored entries
  // are offered for a page, so it is guarded rather than left to chance.
  const RULES = "com\n!ck\n";

  it("does not report the whole hostname as its own public suffix", async () => {
    const psl = await pslWith(RULES);
    // `-(len - 1)` is `-0` at len 1, and `labels.slice(-0)` is the entire
    // array: the unguarded branch answers "sub.example.ck" here.
    expect(psl.getPublicSuffix("sub.example.ck")).toBeNull();
    expect(psl.getPublicSuffix("ck")).toBeNull();
  });

  it("still groups two subdomains of one site together", async () => {
    const psl = await pslWith(RULES);
    // The unguarded branch sends both of these down registrableDomain's
    // "hostname IS a public suffix" path, which appends the ".~null" marker
    // that is designed never to match anything. Two pages of one site would
    // then stop sharing a registrable domain, and the stored entry for one
    // would no longer be offered on the other.
    expect(psl.registrableDomain("a.example.ck")).toBe("example.ck");
    expect(psl.registrableDomain("b.example.ck")).toBe("example.ck");
    expect(psl.registrableDomain("a.example.ck")).toBe(psl.registrableDomain("b.example.ck"));
  });

  it("still keeps two different sites apart", async () => {
    const psl = await pslWith(RULES);
    expect(psl.registrableDomain("login.example.ck")).not.toBe(
      psl.registrableDomain("login.evil.ck"),
    );
  });
});

describe("getPublicSuffix over the vendored list", () => {
  it("agrees with the real data on the rules the synthetic tests stand in for", async () => {
    vi.resetModules();
    const psl: Psl = await import(PSL_MODULE);
    expect(psl.getPublicSuffix("example.com")).toBe("com");
    expect(psl.getPublicSuffix("shop.example.co.uk")).toBe("co.uk");
    // "*.ck" plus "!www.ck", straight out of the vendored list.
    expect(psl.getPublicSuffix("example.ck")).toBe("example.ck");
    expect(psl.getPublicSuffix("www.ck")).toBe("ck");
  });
});
