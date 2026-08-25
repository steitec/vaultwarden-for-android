import { describe, it, expect } from "vitest";
import { isRedeemable, PENDING_TTL_MS, type PendingFill } from "../../src/background/pending";

const AT = 1_000_000;
const pending: PendingFill = { tabId: 7, origin: "https://fritz.box", at: AT };

describe("isRedeemable", () => {
  it("redeems the same origin within the window", () => {
    expect(isRedeemable(pending, "https://fritz.box/login", AT + 1_000)).toBe(true);
  });

  it("redeems across a path change within the same origin", () => {
    // The tab is allowed to move within the site it was tapped on: a login
    // form that posts to another path is ordinary.
    expect(isRedeemable(pending, "https://fritz.box/deep/other?q=1", AT + 1_000)).toBe(true);
  });

  it("refuses once the window has passed", () => {
    expect(isRedeemable(pending, "https://fritz.box/login", AT + PENDING_TTL_MS + 1)).toBe(false);
  });

  it("redeems at the very edge of the window", () => {
    expect(isRedeemable(pending, "https://fritz.box/login", AT + PENDING_TTL_MS)).toBe(true);
  });

  it("refuses a tab that navigated to another origin while the PIN was typed", () => {
    // The attack this whole function exists for. The tap happens on one page,
    // the tab moves elsewhere during the unlock, and without re-reading the
    // URL the credentials would land on whatever is there now.
    expect(isRedeemable(pending, "https://evil.example/login", AT + 1_000)).toBe(false);
  });

  it("refuses a scheme downgrade on the same host", () => {
    // Same host, different security context. http is where the password is
    // readable by anyone on the path, which is why isFillableOrigin refuses
    // it — inheriting the tap across that boundary would route around it.
    expect(isRedeemable(pending, "http://fritz.box/login", AT + 1_000)).toBe(false);
  });

  it("refuses a different port on the same host", () => {
    expect(isRedeemable(pending, "https://fritz.box:8443/login", AT + 1_000)).toBe(false);
  });

  it("refuses a subdomain of the recorded origin", () => {
    // Origin equality, not domain matching. uriMatches may well consider
    // these the same site; that decision belongs to Controller.fill, which
    // runs afterwards, not to the question of whether this tap still stands.
    expect(isRedeemable(pending, "https://sub.fritz.box/login", AT + 1_000)).toBe(false);
  });

  it("refuses a vanished tab", () => {
    expect(isRedeemable(pending, undefined, AT + 1_000)).toBe(false);
  });

  it("refuses an unparseable URL rather than throwing", () => {
    expect(isRedeemable(pending, "not a url", AT + 1_000)).toBe(false);
    expect(isRedeemable(pending, "", AT + 1_000)).toBe(false);
  });

  it("refuses an opaque origin", () => {
    // `about:blank` parses, and its origin is the string "null". Comparing it
    // as an ordinary origin would make every opaque page match every other.
    expect(isRedeemable(pending, "about:blank", AT + 1_000)).toBe(false);
    expect(isRedeemable({ ...pending, origin: "null" }, "about:blank", AT + 1_000)).toBe(false);
  });

  it("refuses a clock that ran backwards", () => {
    // A negative age is not "very fresh". Treating it as such would make a
    // pending fill immortal across a clock adjustment.
    expect(isRedeemable(pending, "https://fritz.box/login", AT - 1)).toBe(false);
  });
});
