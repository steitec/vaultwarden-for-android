import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The owner's domain is allowed to survive publication in exactly one shape:
 * the extension id. Anything else — a vault hostname, a test site — is private
 * infrastructure and must not be in a public repository.
 *
 * Note the domain is derived from the id rather than written out, so this file
 * does not itself become the leak it exists to prevent.
 */
const EXTENSION_ID = "vaultwarden-android@steitec.net";
const OWNER_DOMAIN = EXTENSION_ID.slice(EXTENSION_ID.indexOf("@") + 1);
const REPO = resolve(__dirname, "..");

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO,
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.toString("utf8").split("\0").filter((p) => p.length > 0);
}

describe("no private hostname survives in tracked files", () => {
  it("mentions the owner's domain only as the extension id", () => {
    const offenders: string[] = [];

    for (const file of trackedFiles()) {
      let text: string;
      try {
        text = readFileSync(resolve(REPO, file), "utf8");
      } catch {
        continue;
      }

      let at = text.indexOf(OWNER_DOMAIN);
      while (at !== -1) {
        // The id is the domain plus its prefix; take exactly that many
        // characters back and require an exact match.
        const from = at - (EXTENSION_ID.length - OWNER_DOMAIN.length);
        const context = from < 0 ? "" : text.slice(from, at + OWNER_DOMAIN.length);
        if (context !== EXTENSION_ID) {
          const line = text.slice(0, at).split("\n").length;
          offenders.push(`${file}:${line}`);
        }
        at = text.indexOf(OWNER_DOMAIN, at + 1);
      }
    }

    expect(offenders).toEqual([]);
  });
});
