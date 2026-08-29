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

  it("declares no optional permissions, because nothing is asked for at runtime", () => {
    // This held ["https://*/*"] until 2026-08-27 — the pattern the popup
    // requested the single configured server origin under. `permissions`
    // requires that same wildcard at install time, so the request could only
    // ever resolve true without a prompt, and it is gone (§ F-3 of
    // docs/VERIFICATION-2026-08-25.md).
    //
    // An optional permission that is already required asks for nothing and
    // grants nothing. Leaving it declared tells a reviewer that some access
    // is deferred to a runtime prompt, which is exactly the claim that is no
    // longer true. What it used to protect — that the server origin is only
    // ever reachable over https — is now held by the exact-array assertion
    // on `permissions` above, together with the loopback test below.
    expect(manifest).not.toHaveProperty("optional_permissions");
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

  it("keeps the extension id exactly as signed", () => {
    // Firefox treats a changed id as a different add-on: the signed build in
    // daily use would become uninstallable-over, and setup, master password
    // and PIN would all have to be entered again on the device.
    //
    // This is also the guard for the publication rewrite of 2026-08-29, which
    // replaces two hostnames under this same domain across every commit. A
    // replacement written against the bare domain instead of the two
    // subdomains would rewrite this string as a side effect, and nothing else
    // in the suite would notice.
    const gecko = manifest.browser_specific_settings.gecko as { id?: string };
    expect(gecko.id).toBe("vaultwarden-android@steitec.net");
  });
});
