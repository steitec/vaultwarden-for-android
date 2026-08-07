import { describe, it, expect } from "vitest";
import { uriMatches, registrableDomain } from "../../src/vault/uri-match";

describe("registrableDomain", () => {
  it("reduces a subdomain to eTLD+1", () => {
    expect(registrableDomain("sub.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
  });

  it("handles multi-part public suffixes", () => {
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
  });

  it("returns ip addresses and single labels unchanged", () => {
    expect(registrableDomain("192.168.178.50")).toBe("192.168.178.50");
    expect(registrableDomain("localhost")).toBe("localhost");
  });
});

describe("uriMatches base domain (type 0, the default)", () => {
  it("matches a subdomain of the stored domain", () => {
    expect(uriMatches("https://login.example.com/x", { uri: "https://example.com", match: 0 })).toBe(true);
  });

  it("applies base-domain matching when match is null", () => {
    expect(uriMatches("https://login.example.com/x", { uri: "https://example.com", match: null })).toBe(true);
  });

  it("does not match a domain that merely contains the stored domain", () => {
    expect(uriMatches("https://example.com.evil.net/x", { uri: "https://example.com", match: 0 })).toBe(false);
    expect(uriMatches("https://notexample.com/x", { uri: "https://example.com", match: 0 })).toBe(false);
  });

  it("does not match a different public suffix", () => {
    expect(uriMatches("https://example.co.uk/x", { uri: "https://example.com", match: 0 })).toBe(false);
  });
});

describe("uriMatches other types", () => {
  it("type 1 matches host exactly, including port, and rejects subdomains", () => {
    expect(uriMatches("https://a.example.com/x", { uri: "https://a.example.com", match: 1 })).toBe(true);
    expect(uriMatches("https://b.example.com/x", { uri: "https://a.example.com", match: 1 })).toBe(false);
    expect(uriMatches("https://a.example.com:8443/x", { uri: "https://a.example.com", match: 1 })).toBe(false);
  });

  it("type 2 matches a url prefix", () => {
    expect(uriMatches("https://example.com/app/login", { uri: "https://example.com/app", match: 2 })).toBe(true);
    expect(uriMatches("https://example.com/other", { uri: "https://example.com/app", match: 2 })).toBe(false);
  });

  it("type 3 requires an exact url", () => {
    expect(uriMatches("https://example.com/a", { uri: "https://example.com/a", match: 3 })).toBe(true);
    expect(uriMatches("https://example.com/a?b=1", { uri: "https://example.com/a", match: 3 })).toBe(false);
  });

  it("type 4 regex never matches in v1", () => {
    expect(uriMatches("https://example.com/a", { uri: ".*", match: 4 })).toBe(false);
  });

  it("type 5 never matches", () => {
    expect(uriMatches("https://example.com/a", { uri: "https://example.com/a", match: 5 })).toBe(false);
  });

  it("returns false for an unparseable stored uri rather than throwing", () => {
    expect(uriMatches("https://example.com/a", { uri: "!!!", match: 0 })).toBe(false);
  });
});
