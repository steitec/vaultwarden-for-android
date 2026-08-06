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

  it("declares no content scripts", () => {
    expect(manifest.content_scripts).toBeUndefined();
  });
});
