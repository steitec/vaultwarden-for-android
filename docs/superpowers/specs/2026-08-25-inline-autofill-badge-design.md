# Inline autofill badge — Design

Date: 2026-08-25
Status: Approved for planning

**Supersedes §7.1 of `2026-08-06-vaultwarden-firefox-android-addon-design.md`**
("activeTab, not host permissions"). That section is the deliberate decision this
design reverses; §9 below states what is given up and what is kept.

## 1. Motivation

Filling a password currently costs four interactions: tap the addon icon, unlock,
read a list, tap the entry. On a phone, against a router admin page the user signs
into regularly, that is enough friction to make the addon feel worse than typing
the password from memory.

The user's stated goal is for it to behave like Firefox's built-in password
manager. That comparison has a hard floor: the built-in manager is browser code,
not an extension, and is not subject to the permission model at all. No extension
reaches page content without a declared host permission.

What *is* achievable is removing every per-site interaction after install. One
install-time permission notice, and from then on: page loads, badge appears in the
password field, one tap fills.

## 2. Goals

- Fill a matched entry with a single tap on the page, no popup, no list.
- No runtime permission dialogs. One install-time notice, never repeated.
- After a PIN unlock triggered from the page, fill without a second tap.
- Keep credentials inside the background page until the user's tap, exactly as
  today.

## 3. Non-goals

- Filling without any user gesture. Rejected: the tap is what keeps credentials
  out of a page until the user has seen where they are going, and it is the
  mitigation that makes an all-sites content script acceptable.
- An in-page unlock UI. The PIN must never be typed into a surface a page could
  imitate. Unlock stays in the popup.
- Resolving multiple matches automatically. See §7.
- Save-password prompts, or any other v2 item from the original spec.

## 4. Behaviour

**Unlocked, one match.** Page loads, a lock glyph appears inside the password
field, tapping it fills username and password. Username is skipped when the entry
has none or the page has no username field — unchanged from today.

**Unlocked, no match.** No badge. The page is untouched.

**Unlocked, several matches.** The badge hands off to the popup (§5.4), which
already lists page matches first (`popup.ts:339`). The list survives here because
nothing can pick between two entries for one domain.

**Locked.** The badge appears on any page with a usable password field, because a
locked vault cannot be consulted (§7). Tapping it records a pending fill and hands
off to the popup; after the PIN, the original tab is filled — or the user is told
no entry matched, which is only knowable after decryption.

## 5. Architecture

`src/content/autofill.ts` changes from an on-demand injected script to a
**declared content script** and gains a second responsibility: rendering the
badge. `findLoginFields` and `fillFields` are unchanged — the field detection
already built and tested is exactly what the badge needs.

```
document_idle
  └─ findLoginFields(document)
     ├─ no usable password field → done, nothing rendered
     └─ password field found
        └─ → background: { kind: "matches" }
           ├─ locked   → render badge (unlock affordance)
           ├─ 0 matches → done, nothing rendered
           ├─ 1 match   → render badge (fill affordance)
           └─ n matches → render badge (chooser affordance)

badge tap, unlocked, 1 match
  └─ → background: { kind: "fillFromPage" }
     └─ Controller.fill(tabId from sender, itemId)   ← existing validation
        └─ → content script: { kind: "fill", username, password }

badge tap, locked
  └─ → background: { kind: "handOff" }
     ├─ record pendingFill { tabId, origin, at }
     └─ hand off to popup (§5.4)

badge tap, unlocked, n matches
  └─ → background: { kind: "handOff" }
     └─ hand off to popup (§5.4)   ← no pendingFill; the user picks
```

### 5.4 Handing off to the popup

Two badge taps cannot complete on the page: a locked vault, and several matches.
Both do the same thing, so there is one mechanism rather than two.

The background page records a pending fill if the vault was locked, then attempts
`browserAction.openPopup()`. If that resolves, the user is already looking at the
right screen — the popup lists page matches first, so no extra routing is needed.
If it rejects or is unavailable (§8), the badge instead renders a short hint to
open the addon, and the user does it manually. Both routes converge: the popup
opens, and the pending fill (if any) is redeemed on unlock.

### 5.1 The `matches` request must stop trusting its caller

`{ kind: "matches"; pageUrl: string }` currently takes the URL from the message.
That was safe while the popup was the only caller. A content script running on
arbitrary pages is not such a caller: a compromised or malicious page cannot
reach the listener directly under MV2 isolation, but the URL must not be the
content script's to assert regardless.

The handler reads `sender.tab.url` instead, matching what `Controller.fill`
already does (`controller.ts:461` — *"The caller does not get to tell us where
the credentials are going"*). `pageUrl` is dropped from the request shape; the
popup's own call site changes with it.

This is the one existing message whose contract changes. `fillFromPage` and
`handOff` likewise derive their tab from `sender`, never from the payload.

A second, smaller knock-on: `popup.ts:327` documents `tab.url` as *"genuinely
absent whenever `activeTab` has not been granted"* and returns null to avoid a
`matches` call that could only answer "none". With host permissions in place the
URL is always readable, so that branch becomes unreachable. It should be removed
rather than left as a comment describing a world that no longer exists.

### 5.2 Badge rendering

The badge lives in a **closed shadow root** attached to a wrapper the content
script inserts next to the password field, so page CSS cannot hide, move, or
restyle it, and page script cannot read it. It is removed when the field is
removed and repositioned on resize.

A page can of course draw a *fake* badge. Tapping one does nothing — page script
cannot message the background — so the worst outcome is a fill that appears not
to work. Acceptable; the alternative (no page-side affordance at all) is the
status quo the user is asking to leave.

Dynamic login forms (SPAs mounting the form after `document_idle`) are covered by
a `MutationObserver` on the document, debounced, re-running detection.

### 5.3 Manifest

```json
"permissions": ["storage", "https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
"content_scripts": [{
  "matches": ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  "js": ["autofill.js"],
  "run_at": "document_idle"
}]
```

`activeTab` is removed; it becomes dead weight once host permissions cover the
same ground. `optional_permissions` stays for the server origin, which is still
requested at setup and still checked with `permissions.contains()` before any
network call — that mechanism is untouched.

The match list mirrors `isFillableOrigin` deliberately, so the badge cannot
appear where a fill would be refused. It has one gap: `http://[::1]` is a
fillable origin but not expressible as a match pattern, so loopback-over-IPv6
pages get no badge. They keep the popup path. This is a knowingly accepted
inconsistency, not an oversight.

`all_frames` is left at its default (`false`). Filling inside third-party iframes
is the classic exfiltration vector for autofill extensions, and nothing in the
current field detection reasons about frame ancestry.

## 6. The pending fill

The only genuinely new state in the design.

```ts
type PendingFill = { tabId: number; origin: string; at: number };
```

Recorded when the badge is tapped on a locked vault. Redeemed after a successful
unlock, and only if **all** of the following hold:

- less than 120 seconds have passed;
- the tab still exists;
- the tab's current URL still parses and has the same origin as when recorded;
- that URL still passes `isFillableOrigin`;
- exactly one vault entry matches it.

Anything else discards it rather than guessing. Several matches hand the popup
that tab's list instead; zero matches reports that plainly.

Discarded on lock, on sign-out, on navigation of the recorded tab, on redemption,
and on expiry. It is held in memory only — never written to `storage` — so a
background-page restart loses it, which is the correct failure direction.

The origin check is what stops the interesting attack: the user taps a badge on
one page, and while the PIN is being typed the tab navigates elsewhere. Re-reading
the URL at redemption time and comparing origins means the credentials land on the
page the user was looking at when they tapped, or nowhere.

Redemption reuses `Controller.fill` unchanged, so every existing guard —
`isFillableOrigin`, `uriMatches`, the `password === null` refusal — applies again
at the moment of filling. The pending fill is an intent to call it, never a
bypass of it.

## 7. Why a locked vault shows an indiscriminate badge

A locked vault holds no decrypted items, so it cannot answer "does anything match
this page". The badge therefore appears on every page with a usable password
field while locked, including pages with no entry.

The alternative would be an unencrypted index of the domains held in the vault.
That is a plaintext directory of every account the user has, readable by anyone
with storage access, and it is a strictly worse trade than an occasionally
useless badge. Rejected outright.

The user-visible consequence — tapping, unlocking, then being told nothing
matched — is accepted and must be reported clearly rather than as a silent no-op.

## 8. `browserAction.openPopup()` is an enhancement, not a dependency

Whether `openPopup()` works on Firefox for Android is unverified. The addon
button lives in the menu rather than a toolbar there, and the API's user-gesture
requirement may not survive the hop from content script to background page.

The design does not rest on it. When it is unavailable or throws, the pending
fill is still recorded and the badge switches to a hint to open the addon
manually. The user opens it, enters the PIN, and the fill happens automatically
just the same. `openPopup()` saves one gesture and carries nothing.

**This must be probed on hardware before the pending-fill work begins**, since a
working `openPopup()` changes only which branch is the common one, and the probe
is cheap — a device is already attached and running the addon.

## 9. Security model: what changes, what holds

**Holds.**

- Credentials leave the background page only after a user tap on the badge, and
  only into the tab whose URL the background page read itself.
- `ItemSummary` remains passwordless. The badge learns how many entries match and
  their names; it never learns a secret.
- Every fill-time guard is unchanged and still runs on every path, including
  redemption.
- A locked vault stays inert (§7.3 of the original spec is untouched).
- Plain http is still refused outside loopback.

**Given up.** The claim in §7.1 of the original design — no content script on any
page, no access to a tab until the user taps the addon — is no longer true. A
script now runs on every https page. A defect in it has page-wide reach rather
than being confined to tabs the user pointed at.

The mitigation is that the script holds nothing worth stealing. It renders a
badge, reports whether a password field exists, and receives credentials only in
response to a tap it did not originate. That is the whole of it.

**Not claimed.** This does not rule out the invisible-iframe exfiltration class
as cleanly as the old model did. `all_frames: false` and the existing off-screen
detection (`isCssHiddenBox`, `isRenderedOffScreen`) are what stand in its place,
and both predate this design.

## 10. AMO consequences

`docs/AMO-SUBMISSION.md:141-155` tells reviewers the extension holds exactly one
host permission and injects only on user action. That is the load-bearing claim
of the current submission note and it becomes false.

It must be rewritten to describe the new posture honestly: all-sites host
permission, a content script that holds no credentials, and the tap as the gate.
This is the ordinary shape for a password manager — Bitwarden and 1Password match
all URLs in their content scripts — but it will attract more review attention
than the current note does, and the rewrite is part of this work, not a follow-up.

Install now shows a permission notice ("Access your data for all websites"). The
`data_collection_permissions: { "required": ["none"] }` key is unaffected; host
access and data collection are separate declarations.

## 11. Testing

Unit (jsdom, alongside the existing suite):

- Badge renders only when a usable password field exists; not on a page without
  one; not when the vault is unlocked with zero matches.
- Badge is removed when its field leaves the DOM; re-rendered when a form mounts
  late.
- `matches` derives the URL from `sender.tab.url` and ignores a URL supplied in
  the message — asserted with a message whose payload disagrees with the tab.
- `fillFromPage` and `handOff` derive their tab from `sender`.
- `handOff` records a pending fill when locked and does not when merely
  ambiguous, so an unlocked multi-match tap leaves no redeemable state behind.
- The hand-off falls back to the hint when `openPopup()` rejects, and the pending
  fill is recorded either way.
- Pending fill: redeemed on the happy path; discarded on expiry, on lock, on
  sign-out, on origin change, on a vanished tab; routed to the list on several
  matches; reported plainly on zero.
- Redemption still refuses an entry with no password and a non-fillable origin,
  proving the guards are not bypassed.

Regression: the existing 536 tests stay green. The popup fill path loses its
`tabs.executeScript` call and the `matches` call site changes shape, so those
tests change with it.

On device, after the unit suite passes: badge on `https://fritz.box`, one-tap
fill, the locked flow end to end, and the `openPopup()` probe from §8.

## 12. Known risks

- **`openPopup()` unavailable on Android.** Mitigated by design (§8). Probe early.
- **Badge fights the page's own layout** in fields with custom decoration.
  Shadow DOM limits the blast radius but cannot guarantee a good position on
  every site. Accepted; the fallback is a badge that looks slightly wrong, not a
  broken page.
- **Content script cost on every page load.** Detection runs once at
  `document_idle` plus debounced mutations. Should be negligible, but it is now
  on the critical path of every page the user opens on a phone, so it is worth
  measuring rather than assuming.
- **AMO review friction** (§10). Real but ordinary for this category.
