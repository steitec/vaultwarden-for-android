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

  it("requests no ambient host permissions", () => {
    expect(manifest.permissions).toEqual(["storage", "activeTab"]);
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
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

    const json = JSON.stringify(manifest);
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

  it("declares no content scripts", () => {
    const m = manifest as typeof manifest & { content_scripts?: unknown };
    expect(m.content_scripts).toBeUndefined();
  });
});
