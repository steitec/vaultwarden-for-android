import { describe, it, expect } from "vitest";
import { uriMatches, registrableDomain, type UriMatchType } from "../../src/vault/uri-match";

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

  it("type 0 is port-aware for IPv4 addresses", () => {
    expect(uriMatches("http://192.168.1.5:8080/", { uri: "http://192.168.1.5:9090/", match: 0 })).toBe(false);
    expect(uriMatches("http://192.168.1.5:8080/", { uri: "http://192.168.1.5:8080/", match: 0 })).toBe(true);
  });

  it("type 0 is port-aware for localhost", () => {
    expect(uriMatches("http://localhost:8080/", { uri: "http://localhost:9090/", match: 0 })).toBe(false);
    expect(uriMatches("http://localhost:8080/", { uri: "http://localhost:8080/", match: 0 })).toBe(true);
  });

  it("type 0 is port-aware for IPv6 addresses", () => {
    expect(uriMatches("https://[::1]:8080/", { uri: "https://[::1]:9090/", match: 0 })).toBe(false);
    expect(uriMatches("https://[::1]:8080/", { uri: "https://[::1]:8080/", match: 0 })).toBe(true);
  });

  it("type 2 rejects domain boundary violations", () => {
    // Substring confusion: stored domain as substring in a different domain
    expect(uriMatches("https://example.com.evil.net/", { uri: "https://example.com", match: 2 })).toBe(false);
    expect(uriMatches("https://example.com.evil.net/", { uri: "https://example.com/", match: 2 })).toBe(false);

    // Substring confusion with path
    expect(uriMatches("https://example.com@evil.net/", { uri: "https://example.com", match: 2 })).toBe(false);
    expect(uriMatches("https://example.commerce-evil.net/", { uri: "https://example.com", match: 2 })).toBe(false);

    // Path boundary violation
    expect(uriMatches("https://example.com/appeal-to-evil", { uri: "https://example.com/app", match: 2 })).toBe(false);
    expect(uriMatches("https://example.com/application", { uri: "https://example.com/app/", match: 2 })).toBe(false);

    // Google Accounts case
    expect(uriMatches("https://accounts.google.com.evil.net/login", { uri: "https://accounts.google.com", match: 2 })).toBe(false);
  });

  it("type 2 accepts valid prefix matches at path boundaries", () => {
    expect(uriMatches("https://example.com/app/login", { uri: "https://example.com/app", match: 2 })).toBe(true);
    expect(uriMatches("https://example.com/app?query=1", { uri: "https://example.com/app", match: 2 })).toBe(true);
    expect(uriMatches("https://example.com/app#fragment", { uri: "https://example.com/app", match: 2 })).toBe(true);
  });
});

describe("uriMatches with real Public Suffix List", () => {
  it("rejects different tenants under shared hosting suffixes", () => {
    // Heroku
    expect(uriMatches("https://victim.herokuapp.com/", { uri: "https://attacker.herokuapp.com/", match: 0 })).toBe(false);
    // Azure
    expect(uriMatches("https://victim.azurewebsites.net/", { uri: "https://attacker.azurewebsites.net/", match: 0 })).toBe(false);
    // Google Firebase
    expect(uriMatches("https://victim.firebaseapp.com/", { uri: "https://attacker.firebaseapp.com/", match: 0 })).toBe(false);
    // Vercel
    expect(uriMatches("https://victim.vercel.app/", { uri: "https://attacker.vercel.app/", match: 0 })).toBe(false);
    // Fly.io
    expect(uriMatches("https://victim.fly.dev/", { uri: "https://attacker.fly.dev/", match: 0 })).toBe(false);
  });

  it("handles wildcard public suffix rules", () => {
    // *.ck is a wildcard rule (Cook Islands)
    expect(uriMatches("https://attacker.example.ck/", { uri: "https://victim.example.ck/", match: 0 })).toBe(false);
    expect(uriMatches("https://victim.example.ck/", { uri: "https://victim.example.ck/", match: 0 })).toBe(true);
  });

  it("handles exception public suffix rules", () => {
    // !www.ck is an exception to *.ck
    expect(uriMatches("https://www.ck/page", { uri: "https://www.ck/", match: 0 })).toBe(true);
    expect(uriMatches("https://other.ck/page", { uri: "https://other.ck/", match: 0 })).toBe(true);
  });

  it("handles 3-label suffixes like s3.amazonaws.com", () => {
    // victim and attacker are different sites even though under the same PSL suffix
    expect(uriMatches("https://victim.s3.amazonaws.com/", { uri: "https://attacker.s3.amazonaws.com/", match: 0 })).toBe(false);
    expect(uriMatches("https://victim.s3.amazonaws.com/", { uri: "https://victim.s3.amazonaws.com/", match: 0 })).toBe(true);
  });
});

describe("uriMatches edge cases", () => {
  it("rejects empty hostnames (file://, blob://)", () => {
    expect(uriMatches("file:///home/x.html", { uri: "blob:https://evil.net/uuid", match: 0 })).toBe(false);
  });

  it("returns false for unknown match types", () => {
    expect(uriMatches("https://example.com/a", { uri: "https://example.com/a", match: 99 as UriMatchType })).toBe(false);
  });
});
