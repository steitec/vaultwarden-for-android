# Badge on the first screen of an email-first login (F-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a page with no usable password field but a visible field marked
`autocomplete="username"`, show the badge in that field, and fill only the
username on a tap.

**Architecture:** The content script gains a second detector beside
`findLoginFields`. The badge, the chooser and the `matches` request are reused
unchanged. A new request, `fillUsernameFromPage`, reaches a new
`Controller.fillUsername`. It runs the same guards as `fill()` and sends the
existing content-script fill message with `password: null`. A pending fill
made against a locked vault records its scope, so that redeeming it after the
unlock also stays username-only.

**Tech Stack:** TypeScript (strict), WebExtension MV2, vitest + jsdom. No new
dependencies.

**Spec:** `docs/superpowers/specs/2026-11-26-identifier-first-login-design.md`

## Global Constraints

- **Node 22.23.4.** `npm test` (`tsc --noEmit` + `vitest run`) stays green after every task.
- **No new runtime dependencies.** `hash-wasm` remains the only one.
- **No `as` casts on unvalidated data.** Narrow message payloads with real checks in `isRequest`.
- **Repository language is English**: code, comments, tests, docs, commit messages. No Co-Authored-By trailer.
- **The signal is the `autocomplete` token `username` or `webauthn`, nothing else** (`webauthn` added 2026-11-27 after step 0: Amazon). `"email"` alone, `type="email"`, names or ids never trigger the identifier path.
- **No password reaches the content script on the identifier path.** Not on a tap, and not when a pending fill is redeemed after an unlock.
- **A page with neither a usable password field nor a marked username field sends no message.** This is the existing guarantee, and it stays true.
- **Only trusted taps count** (`isUserGesture`, F-10), on the new badge exactly as on the old one.

## Review Focus

1. **Screen 1 turns into screen 2 in the same document** (single-page login). The identifier badge must go, and the password badge must come, on the next refresh. Pinned in Task 4.
2. **A page that has both a marked username field and a password field** (an ordinary one-step login) must take the existing password path, not the identifier one. Pinned in Task 1 and Task 4.
3. **A marked field inside a hidden or off-screen wrapper** (decoy) must not get a badge. Pinned in Task 1.
4. **The tab navigates between the badge appearing and the tap.** `fillUsername` must re-check the entry against the tab's current URL and refuse. Pinned in Task 2.
5. **A username-scope pending fill redeemed on a page that by then has a password field** (the user moved on during the unlock). It must still send `password: null`. Pinned in Task 3.

---

### Task 0: Check the real sites (manual, on the phone, by the repository owner)

This is a gate, not code. The spec's Step 0 decides whether the approach holds.

**Files:**
- Modify: `docs/DEVICE-CHECKS.md` (new section "F-1 step 0: identifier fields")

- [ ] **Step 1:** In desktop Firefox, open `about:debugging`, connect the phone over USB, and inspect the first login screen on: web.de, accounts.google.com, login.live.com (personal Microsoft account), login.microsoftonline.com (work account), and two sites actually used (for example Amazon, PayPal).
- [ ] **Step 2:** For each one, record the identifier `<input>`'s `type`, `name` and `autocomplete`, and whether a password input is present on that screen, even a hidden one.
- [ ] **Step 3:** Decide. If every provider that matters carries the token `username`, go on with Task 1. If one does not, stop and bring it back to the conversation before writing code.
- [ ] **Step 4: Commit**

```bash
git add docs/DEVICE-CHECKS.md
git commit -m "Record which identifier fields carry autocomplete=username (F-1 step 0)"
```

---

### Task 1: Detect the identifier field, and fill into it

**Files:**
- Modify: `src/content/autofill.ts` (beside `findLoginFields`, and `fillFields`)
- Test: `tests/content/autofill.test.ts` (new `describe("findIdentifierField")`, additions to `describe("fillFields")`)

**Interfaces:**
- Produces: `export function findIdentifierField(doc: Document): HTMLInputElement | null`

- [ ] **Step 1: Write the failing tests** in a new `describe("findIdentifierField")`:

```ts
it("finds a visible field whose autocomplete carries the username token", () => {
  setBody(`<input type="email" id="id" autocomplete="username">`);
  expect(findIdentifierField(document)?.id).toBe("id");
});
it("reads the token among others and in any case", () => {
  setBody(`<input type="text" id="a" autocomplete="Section-Login USERNAME webauthn">`);
  expect(findIdentifierField(document)?.id).toBe("a");
});
it("takes webauthn alone, as Amazon sets it", () => {
  setBody(`<input type="text" name="email" id="az" autocomplete="webauthn">`);
  expect(findIdentifierField(document)?.id).toBe("az");
});
it("does not take autocomplete=email, a bare email field, or a name hint", () => {
  setBody(`<input type="email" autocomplete="email"><input type="email"><input name="username">`);
  expect(findIdentifierField(document)).toBeNull();
});
it("returns null when the page has a usable password field", () => {
  setBody(`<input autocomplete="username"><input type="password">`);
  expect(findIdentifierField(document)).toBeNull();
});
it("rejects a marked field that is hidden, disabled, read-only or parked off-screen", () => {
  setBody(`
    <div hidden><input autocomplete="username"></div>
    <input autocomplete="username" disabled>
    <input autocomplete="username" readonly>
    <div style="position:absolute;left:-9999px"><input autocomplete="username"></div>`);
  expect(findIdentifierField(document)).toBeNull();
});
it("takes the first usable marked field in document order", () => {
  setBody(`<input autocomplete="username" id="one"><input autocomplete="username" id="two">`);
  expect(findIdentifierField(document)?.id).toBe("one");
});
```

Add to `describe("fillFields")`:

```ts
it("with no password field, fills the marked identifier field rather than the first text input", () => {
  setBody(`<input type="text" id="search"><input type="email" id="id" autocomplete="username">`);
  const r = fillFields(document, { username: "a@b.de", password: null });
  expect((document.getElementById("id") as HTMLInputElement).value).toBe("a@b.de");
  expect((document.getElementById("search") as HTMLInputElement).value).toBe("");
  expect(r).toEqual({ filledUsername: true, filledPassword: false });
});
it("with no password field and no marked field, keeps today's first-text-input choice", () => {
  setBody(`<input type="text" id="first">`);
  fillFields(document, { username: "a@b.de", password: null });
  expect((document.getElementById("first") as HTMLInputElement).value).toBe("a@b.de");
});
```

The `as HTMLInputElement` in the tests reads back a fixture the test wrote itself, so it is not a cast on unvalidated data. If the suite already has a helper for this, use that.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/content/autofill.test.ts`
Expected: FAIL, `findIdentifierField is not a function` (add it to the dynamic `import()` destructuring at the top of the file).

- [ ] **Step 3: Implement `findIdentifierField(doc: Document): HTMLInputElement | null`** in `src/content/autofill.ts`.
  - Return `null` whenever `findLoginFields(doc).password` is not null.
  - Otherwise, among `USERNAME_SELECTOR` matches that pass `isUsable(el, hasLayout(doc))`, return the first whose `autocomplete` attribute, lowercased and split on whitespace, contains `"username"` or `"webauthn"`.
  - Read the attribute with `getAttribute("autocomplete")`, not the `.autocomplete` IDL property: jsdom and Firefox differ there for non-canonical token lists.
  - Then change `fillFields`: when `findLoginFields` returns `password === null`, fill the username into `findIdentifierField(doc) ?? fields.username`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`
Expected: PASS, including every existing `findLoginFields`, `fillFields` and select test, unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/content/autofill.ts tests/content/autofill.test.ts
git commit -m "Detect the first screen of an email-first login by autocomplete=username (F-1)"
```

---

### Task 2: `fillUsernameFromPage`: the request, the controller method, the dispatch

**Files:**
- Modify: `src/background/messages.ts` (`Request` union, `isRequest`)
- Modify: `src/background/controller.ts` (new `fillUsername`, beside `fill`)
- Modify: `src/background/index.ts` (`dispatch`)
- Test: `tests/background/controller.test.ts`, `tests/background/index.test.ts`

**Interfaces:**
- Produces: `Request` member `{ kind: "fillUsernameFromPage"; itemId: string }`
- Produces: `Controller.fillUsername(tabId: number, itemId: string): Promise<void>`

- [ ] **Step 1: Write the failing tests** in `tests/background/controller.test.ts`, in a new `describe("fillUsername")`. Use `makeController`, `cacheOf`, `stubTabs` and `PIN`, as the `fill` tests do.

```ts
it("sends the username and a null password", async () => {
  // entry { id: "gh", username: "octocat", password: "hunter2", uris: ["https://github.com"] }
  await controller.fillUsername(7, "gh");
  expect(sendMessage).toHaveBeenCalledWith(7, { kind: "fill", username: "octocat", password: null });
});
it("refuses an entry with no username, without sending anything", /* rejects /no username/i; sendMessage not called */);
it("refuses a plain http page", /* stubTabs("http://github.com/login"); rejects /insecure/i */);
it("refuses when the tab no longer matches the entry", /* stubTabs("https://evil.test/"); rejects /does not match/i */);
it("refuses while locked", /* no unlock; rejects LockedError */);
```

In `tests/background/index.test.ts`, mirror `describe("fillFromPage")`:

```ts
it("routes to fillUsername with the sender's own tab", /* CONTENT_SCRIPT sender → fillUsername(senderTabId, "c1") */);
it("refuses a tabless sender rather than falling back to the active tab", /* SELF sender → rejects /no tab/i */);
it("ignores a tabId named in the message", /* { kind, itemId, tabId: 99 } → still the sender's tab */);
```

And add two rows to the malformed-request table at line ~230:

```ts
["fillUsernameFromPage with no itemId", { kind: "fillUsernameFromPage" }],
["fillUsernameFromPage with a non-string itemId", { kind: "fillUsernameFromPage", itemId: 7 }],
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/background`
Expected: FAIL, `controller.fillUsername is not a function`. The table rows already pass, because `isRequest` rejects the unknown kind. They pin the shape once the kind is known.

- [ ] **Step 3: Implement.**
  - `isRequest`: add the case `"fillUsernameFromPage"` with `"itemId" in v && isString(v.itemId)`.
  - `Controller.fillUsername`: factor what it shares with `fill()` into one private method, `private async fillableTarget(tabId: number, itemId: string): Promise<VaultItem>`. It does the item lookup via `require("user")`, reads the tab URL, and checks `isFillableOrigin` and `uriMatches`, with the existing error texts. Both `fill` and `fillUsername` call it.
  - `fill` keeps its no-password refusal.
  - `fillUsername` refuses `item.username === null` with `"This entry has no username to fill."`, then sends `{ kind: "fill", username: item.username, password: null }`.
  - `dispatch`: add the case `"fillUsernameFromPage"`, written like `"fillFromPage"` (`sender.tab?.id`, `"No tab to fill"`).

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`
Expected: PASS. Every existing `fill` test passes unchanged, which shows the factoring did not move a guard.

- [ ] **Step 5: Commit**

```bash
git add src/background tests/background
git commit -m "Add a username-only fill for the identifier screen (F-1)"
```

---

### Task 3: A pending fill remembers its scope

**Files:**
- Modify: `src/background/pending.ts` (`PendingFill`)
- Modify: `src/background/messages.ts` (`handOff` gains an optional `scope`)
- Modify: `src/background/controller.ts` (`redeemPending`)
- Modify: `src/background/index.ts` (`handOff` case passes `scope`)
- Test: `tests/background/controller.test.ts` (`describe("pending fill")`), `tests/background/index.test.ts`

**Interfaces:**
- Consumes: `Controller.fillUsername` (Task 2)
- Produces: `PendingFill = { tabId: number; origin: string; at: number; scope: "login" | "username" }`
- Produces: `Request` member `{ kind: "handOff"; scope?: "username" }`. Absent means `"login"`.

- [ ] **Step 1: Write the failing tests** in `describe("pending fill")`:

```ts
it("redeems a username-scope tap with the username only", async () => {
  controller.recordPending({ tabId: 7, origin: "https://fritz.box", at: Date.now(), scope: "username" });
  await controller.unlock(PIN);
  expect(sendMessage).toHaveBeenCalledWith(7, { kind: "fill", username: "octocat", password: null });
});
it("still sends no password when the page has moved on to its password screen", /* same tab URL; assert password: null; Review Focus 5 */);
```

Existing `recordPending` calls in this file gain `scope: "login"`, and their expectations stay as they are.

In `tests/background/index.test.ts`:

```ts
it("records a username-scope pending fill for handOff { scope: 'username' }", /* locked; recordPending called with scope "username" */);
it("records a login-scope pending fill for a bare handOff", /* scope "login" */);
// malformed-table rows:
["handOff with an unknown scope", { kind: "handOff", scope: "password" }],
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/background`
Expected: FAIL. Type errors on `scope`, and the new expectations are unmet.

- [ ] **Step 3: Implement.**
  - `isRequest` `"handOff"`: true when `scope` is absent, `undefined` or `"username"`. Any other value is false.
  - `dispatch` `"handOff"`: `scope: msg.scope ?? "login"` into `recordPending`.
  - `redeemPending`: after the existing exactly-one-match check, `p.scope === "username" ? this.fillUsername(...) : this.fill(...)`.
  - `isRedeemable` is untouched.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background tests/background
git commit -m "Keep a pending fill username-only when it came from the identifier screen (F-1)"
```

---

### Task 4: The badge on the identifier screen

**Files:**
- Modify: `src/content/autofill.ts` (`refreshBadge`, `mountChooserBadge`, `fillFromPage`/`handOff` senders)
- Test: `tests/content/autofill.test.ts` (`describe("refreshBadge")`, new `describe("on an identifier screen")`)

**Interfaces:**
- Consumes: `findIdentifierField` (Task 1), the `fillUsernameFromPage` request (Task 2), `handOff { scope: "username" }` (Task 3)

- [ ] **Step 1: Write the failing tests** in a new nested `describe("on an identifier screen")`. Use the existing `badge()`, `tapBadge()` and `sendMessage` helpers.

```ts
const ID = `<input type="email" autocomplete="username">`;
it("asks the background page and mounts a fill badge for one entry with a username", /* matches → [{id:"c1", username:"u"...}]; badge mode "fill" */);
it("drops entries without a username, and shows nothing if none is left", /* items: [{username:null}] → badge() null */);
it("shows the chooser for several entries with usernames", /* mode "chooser"; row tap → sendMessage({kind:"fillUsernameFromPage", itemId}) */);
it("sends fillUsernameFromPage, not fillFromPage, on a tap", ...);
it("mounts an unlock badge while locked and hands off with scope username", /* tap → {kind:"handOff", scope:"username"} */);
it("does not take the identifier path on a page that also has a password field", /* ID + <input type=password>; tap → fillFromPage */);
it("replaces the identifier badge by the password badge when the screen changes", async () => {
  setBody(ID); /* matches → one entry */ await refreshBadge(document);
  setBody(`<input type="password">`); await refreshBadge(document);
  // exactly one badge host, sitting on the password field; a tap sends fillFromPage
});
```

The test `renders nothing on a page with no password field` keeps its fixture, `<input type="text" name="q">`. It is the guarantee that an unmarked field still sends nothing.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/content/autofill.test.ts`
Expected: FAIL. No badge is mounted on the identifier screen, and no message is sent.

- [ ] **Step 3: Implement.**
  - In `refreshBadge`: when `password === null`, take `findIdentifierField(doc)`. If that is null too, return before any message.
  - On the identifier path, everything stays the same apart from the following:
    - the field the badge mounts on
    - `matches.items` filtered to `username !== null` before `modeFor`
    - the senders: `fillUsernameFromPage` instead of `fillFromPage`, and `handOff` with `scope: "username"`
  - Thread the difference through as one value instead of duplicating `refreshBadge`. For example, a `target: { field: HTMLInputElement; scope: "login" | "username" }` that `mountChooserBadge` and the two senders take.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test && npm run build && npm run lint:ext`
Expected: tests PASS, and lint reports 0 errors, 0 warnings, 0 notices (`docs/AMO-SUBMISSION.md` → "Expected lint output").

- [ ] **Step 5: Commit**

```bash
git add src/content/autofill.ts tests/content/autofill.test.ts
git commit -m "Show the badge on the first screen of an email-first login (F-1)"
```

---

### Task 5: Say so everywhere it is promised, and version 0.4.0

**Files:**
- Modify:
  - `docs/PRIVACY.md`: "Web pages you visit", first bullet
  - `docs/AMO-SUBMISSION.md`: reviewer note, content-script paragraph
  - `docs/AMO-LISTING.md`: drop the email-first bullet in both languages
  - `SECURITY.md`: line ~50
  - `README.md`: the "What it does not do" first bullet, and "Version 0.3.4"
  - `docs/BACKLOG.md`: F-1 bullet
  - `docs/VERIFICATION-2026-08-25.md`: § F-1, add "Resolved in 0.4.0"
  - `docs/DEVICE-CHECKS.md`: new section with the device checks below
  - `CHANGELOG.md`
  - `package.json`, `package-lock.json` (both version fields), `src/manifest.json`

- [ ] **Step 1:** Rewrite each promise to the same rule. The add-on consults the background page only on a page with a usable password field, **or** with a visible field marked `autocomplete="username"`. On the second kind it fills the username only, and never sends a password there. Each file says it in its own voice. Check each sentence against Tasks 1–4.
- [ ] **Step 2:** In `docs/DEVICE-CHECKS.md`, add the checks from the spec's Testing section:
  - web.de, Google and Microsoft, screen 1 and screen 2, unlocked and locked
  - one newsletter or search form, which must show no badge
- [ ] **Step 3:** In `CHANGELOG.md`, add `## [0.4.0] — <date>` with:
  - "Changed": the badge on the first screen of an email-first login fills the username, F-1
  - "Security": a password is never sent to that screen

  Then set the version to `0.4.0` in the three files.
- [ ] **Step 4: Verify**

Run: `npm test && npm run package`
Expected: tests PASS. `package` succeeds on a clean tree after the commit below, so run it after committing. `dist/manifest.json` shows `"version": "0.4.0"`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Version 0.4.0: the identifier screen gets a badge (F-1)"
```

Signing (`npm run sign:unlisted`) and the device run are the repository owner's, after review, as for every release.
