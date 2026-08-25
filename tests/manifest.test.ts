import { describe, it, expect } from "vitest";
import manifest from "../src/manifest.json";

describe("manifest", () => {
  it("is Manifest V2 with a persistent background page", () => {
    expect(manifest.manifest_version).toBe(2);
    expect(manifest.background.persistent).toBe(true);
  });

  it("declares Android compatibility, the flag Bitwarden omits", () => {
    const bss = manifest.browser_specific_settings as {
      gecko_android?: { strict_min_version?: string };
    };
    expect(bss.gecko_android?.strict_min_version).toBe("121.0");
  });

  it("holds host permissions for every fillable origin, and no more", () => {
    // This reverses §7.1 of the original design deliberately. The badge has
    // to render before the user has touched the addon, and nothing renders
    // on a page the extension has no host access to. `<all_urls>` is still
    // refused: it would cover ftp:, file: and every other scheme, none of
    // which this addon fills into.
    expect(manifest.permissions).toEqual([
      "storage",
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
    ]);
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
  });

  it("no longer requests activeTab, which host permissions supersede", () => {
    expect(manifest.permissions).not.toContain("activeTab");
  });

  it("declares the content script on exactly the origins a fill is allowed on", () => {
    // The match list mirrors isFillableOrigin so a badge cannot appear where
    // a fill would be refused. http://[::1] is fillable but is not an
    // expressible match pattern, so it keeps the popup path only — a known
    // and accepted gap, recorded in the 2026-08-25 design's §5.3.
    const scripts = (manifest as typeof manifest & {
      content_scripts: Array<{ matches: string[]; js: string[]; run_at?: string }>;
    }).content_scripts;

    expect(scripts).toHaveLength(1);
    const script = scripts[0];
    // Explicit narrowing rather than `!`: noUncheckedIndexedAccess is on, and
    // this file asserts on a shape it reads from JSON.
    if (script === undefined) throw new Error("expected exactly one content script");

    expect(script.matches).toEqual([
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
    ]);
    expect(script.js).toEqual(["autofill.js"]);
    expect(script.run_at).toBe("document_idle");

    // Filling inside third-party iframes is the classic exfiltration vector
    // for autofill extensions, and nothing in the field detection reasons
    // about frame ancestry. Absent means false; asserting on the absence
    // keeps a later `true` from slipping in unnoticed.
    expect(script).not.toHaveProperty("all_frames");
  });

  it("declares optional host access as https-only", () => {
    // MV2 cannot declare a runtime-determined origin, so the user's server
    // has to be covered by a pattern — but the pattern must not include
    // plain http. Setup posts the derived master password hash to this
    // address and every sync carries a bearer token to it; over http both
    // are readable by anyone on the path. Controller.setup then requests
    // only the single configured origin at runtime, so a `*://*/*` grant is
    // never actually held — but it must not be requestable either.
    expect(manifest.optional_permissions).toEqual(["https://*/*"]);

    // Scoped to optional_permissions rather than the whole manifest: since
    // the badge landed, `permissions` legitimately contains http loopback
    // patterns. What must stay https-only is the grant the SERVER origin is
    // requested under — that is the one carrying the master password hash
    // and every bearer token.
    const json = JSON.stringify(manifest.optional_permissions);
    expect(json).not.toContain("*://*/*");
    expect(json).not.toContain("http://");
    expect(json).not.toContain("<all_urls>");
    for (const p of manifest.optional_permissions) {
      expect(p.startsWith("https://"), `optional permission ${p} must be https-only`).toBe(true);
    }
  });

  it("declares that it collects no data at all", () => {
    // Mozilla is making this key mandatory; addons-linter already emits
    // MISSING_DATA_COLLECTION_PERMISSIONS without it. `none` is the honest
    // answer here and it has to stay the honest answer: this extension talks
    // to exactly one server, the one the user typed, and ships no analytics
    // or telemetry of any kind.
    //
    // The literal `"none"` is load-bearing beyond the lint. It is exclusive —
    // addons-linter rejects it (NONE_DATA_COLLECTION_IS_EXCLUSIVE) if any
    // other required data-collection permission appears beside it. So the
    // exact-array assertion below is what would fail first if someone ever
    // added a collected data category, forcing the AMO listing claim and the
    // manifest to be reconciled deliberately rather than by accident.
    const gecko = manifest.browser_specific_settings.gecko as {
      data_collection_permissions?: { required?: string[] };
    };
    expect(gecko.data_collection_permissions?.required).toEqual(["none"]);
  });

  it("keeps plain http out of everything except the two loopback hosts", () => {
    // The replacement for the old blanket "no http:// anywhere" assertion.
    // isFillableOrigin allows http on loopback only, and the manifest must
    // not quietly widen that: `http://*/*` here would put a badge on every
    // plaintext page on the internet.
    const httpPatterns = manifest.permissions.filter((p) => p.startsWith("http://"));
    expect(httpPatterns).toEqual(["http://localhost/*", "http://127.0.0.1/*"]);
  });
});
