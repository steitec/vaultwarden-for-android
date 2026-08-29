import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../package.json";

/**
 * The build and signing scripts, pinned where they are dangerous.
 *
 * `web-ext sign` is the only command in this repository that reaches AMO and
 * cannot be undone: a version number is spent there whether or not the result
 * is ever installed, and it is spent across *both* channels at once. So the
 * properties asserted here are not style — each one is a way the command could
 * become harmful by drifting, and none of them is visible in a diff that only
 * shows a changed string in package.json.
 */

const scripts = pkg.scripts as Record<string, string | undefined>;

describe("package and sign scripts", () => {
  it("keeps the harmless half offline: package builds, lints and archives, and sends nothing", () => {
    const pack = scripts.package;
    if (pack === undefined) throw new Error("expected a `package` script");

    expect(pack).toContain("npm run build");
    expect(pack).toContain("npm run lint:ext");
    expect(pack).toContain("git archive");
    // The whole point of the split. If `package` ever grows a `web-ext sign`,
    // then "make me a build" submits to AMO as a side effect, which is the
    // trap the two-script shape exists to prevent.
    expect(pack).not.toContain("web-ext sign");
  });

  it("names the channel in the script name, not just in its flags", () => {
    // `npm run sign` must not exist as a bare name. Today it would mean
    // unlisted; the day a listed submission is wanted, the same muscle memory
    // would submit for public review instead. The channel belongs where the
    // person typing it can see it.
    expect(scripts.sign).toBeUndefined();

    const unlisted = scripts["sign:unlisted"];
    if (unlisted === undefined) throw new Error("expected a `sign:unlisted` script");
    expect(unlisted).toContain("--channel=unlisted");
    expect(unlisted).not.toContain("--channel=listed");
  });

  it("runs the suite and the build before anything reaches the network", () => {
    const unlisted = scripts["sign:unlisted"];
    if (unlisted === undefined) throw new Error("expected a `sign:unlisted` script");

    // Order matters, not just presence: `&&` chains, with the signing last.
    // Thirty seconds of tests against a version that cannot be recalled is
    // cheap, but only if they run first.
    const testAt = unlisted.indexOf("npm test");
    const packageAt = unlisted.indexOf("npm run package");
    const signAt = unlisted.indexOf("web-ext sign");
    expect(testAt).toBeGreaterThanOrEqual(0);
    expect(packageAt).toBeGreaterThan(testAt);
    expect(signAt).toBeGreaterThan(packageAt);
  });

  it("carries the source archive with the submission", () => {
    const unlisted = scripts["sign:unlisted"];
    if (unlisted === undefined) throw new Error("expected a `sign:unlisted` script");
    expect(unlisted).toContain("--upload-source-code=source.zip");
  });

  it("holds no AMO credentials anywhere in package.json", () => {
    // Credentials come from WEB_EXT_API_KEY and WEB_EXT_API_SECRET in the
    // environment. As flags they would land in shell history and in the
    // process list of every user on the machine — and in this file, which is
    // committed. This assertion covers the whole file, not just the scripts,
    // because that is the property worth having.
    const whole = JSON.stringify(pkg);
    expect(whole).not.toContain("--api-key");
    expect(whole).not.toContain("--api-secret");
  });

  it("keeps the source archive out of version control", () => {
    // `package` writes source.zip into the working tree on every run, and it
    // is the exact source of a submitted version. Prose in AMO-SUBMISSION.md
    // used to be the only thing stopping it being committed.
    const ignored = readFileSync(resolve(__dirname, "../.gitignore"), "utf8");
    expect(ignored.split("\n").map((l) => l.trim())).toContain("source.zip");
  });
});
