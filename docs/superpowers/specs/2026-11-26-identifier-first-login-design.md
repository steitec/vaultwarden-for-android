# Badge on the first screen of an email-first login (F-1) — Design

Draft 2026-11-26, for approval. Approach chosen in conversation: detect the
first screen by `autocomplete="username"` only, and fill it with a message that
carries the username and nothing else.

**Amended 2026-11-27 after step 0:** Amazon marks its identifier field with
`autocomplete="webauthn"` alone. The signal is now the token `username` **or**
the token `webauthn`. Both are reserved for credential fields; names, ids and
a bare `type="email"` still never count. Wherever this document says
`autocomplete="username"`, read "either token".

## Why

On email-first ("identifier-first") logins — web.de, Google, Microsoft and
many others — the first screen asks for the address only. The content script
looks for a visible password field before it does anything, finds none, and
stays silent. On the next screen the password badge appears and fills the
password, but by then the username has had to be typed by hand. The popup path
works on both screens; on a phone it is the long route (⋮ → Extensions →
Vaultwarden).

It is the most visible gap before a listed submission: it reads as "the add-on
does nothing on my mail provider" (`docs/VERIFICATION-2026-08-25.md` § F-1).

## Goal

On a page with no usable password field but a visible field explicitly marked
as a login username, the badge appears in that field. A tap fills the username
of the matching entry, and only the username. The second screen is unchanged:
its password badge fills the password as it does today.

## Non-goals

- No pressing "Next" or submitting the form. The user moves on themselves.
- No carrying the chosen entry over from screen 1 to screen 2. Screen 2 does
  its own matching, as now.
- No heuristic detection of unmarked fields (name/id guessing, "the only email
  field in a form") in this change. Step 0 decides whether it is needed; if it
  is, it comes back as its own design.
- No fix for login pages on a different registrable domain from the entry
  (`login.live.com` against an entry for `microsoft.com`). That already
  affects screen 2 today; the remedy is a second URI on the entry.
- No change to the popup path.

## Anti-goals

- A badge on newsletter, search, contact or sign-up fields. This is why the
  signal is `autocomplete="username"` and not `type="email"`.
- The page's content script ever receiving a password on screen 1.

## Approaches considered

1. **`autocomplete="username"` only (chosen).** The HTML standard defines the
   token for exactly this field, and browser vendors tell site owners to set it
   on the identifier step of email-first flows. Almost no non-login field
   carries it, so the badge stays rare and the privacy promise stays narrow.
   Misses sites that do not set it.
2. Heuristics on top: a lone `type="email"` field, or names like `login`,
   `user`, `identifier`. Catches more sites, but brings badges on the wrong
   fields and much more test surface. Held back until step 0 shows it is
   needed.
3. Leave it and document it. Honest, already done in the listing text, but
   leaves the gap.

## Step 0 — before building

Check on the phone what the first-screen field actually carries on web.de,
Google, Microsoft (consumer and work account), and two or three other sites
the user really logs into, such as Amazon or PayPal. A remote check could not
settle it: Google and Microsoft render the field with JavaScript, and web.de's
login form was not in its served HTML.

Method: desktop Firefox, `about:debugging` → the phone over USB → inspect the
tab, read the `<input>`'s `autocomplete`. Record the results in the device
checks file.

If a provider that matters lacks the token, stop and bring it back to the
conversation before building: approach 2 would then be on the table for that
case.

## Behaviour

**Detection.** Only when `findLoginFields` finds no usable password field. A
new `findIdentifierField(doc)` looks among the usable username candidates
(same selector, same visibility and decoy checks as `findLoginFields`) for one
whose `autocomplete` attribute contains the token `username`. The attribute is
read case-insensitively and split on whitespace, so `"username webauthn"` and
`"section-login username"` both count; `"email"` alone does not. The first
such field in document order wins. If none is found, nothing happens, and no
message is sent, as today.

**Unlocked.** The content script sends the existing `matches` request; the
background page reads the tab's URL itself, unchanged. From the answer, the
content script keeps only entries that have a username, because there is
nothing else to fill here. None left: no badge. One: a fill badge in the
identifier field. Several: the chooser badge from F-9, with the same list.

**Tap.** A trusted tap (`isUserGesture`, F-10) sends a new request,
`fillUsernameFromPage { itemId }`. The background page resolves the tab from
the sender, as `fillFromPage` does, and calls a new `Controller.fillUsername`.
That runs the same guards as `fill()`: entry exists, tab URL read from the tab,
`isFillableOrigin`, `uriMatches` against the entry's URIs. Instead of refusing
an entry with no password, it refuses one with no username. It then sends the
existing content-script message with `password: null`:
`{ kind: "fill", username, password: null }`. The content script's
`isFillMessage` already accepts that shape.

**Which field gets the username.** `fillFields` with no password field
currently puts the username into the first usable text input. It now prefers
the identifier field from `findIdentifierField` and falls back to today's
choice only when there is none. That keeps the popup path filling what it
fills today on pages without the token, and makes the badge path fill the
field the badge sits in.

**Locked.** The unlock badge appears in the identifier field too, the same as
it does in any password field: the vault cannot be asked while locked
(2026-08-25 design §7). My call, because the token is strict enough that the
extra badges are few. A tap sends `handOff` as today. The pending fill records
that it came from an identifier field (`PendingFill` gains
`scope: "login" | "username"`), and `redeemPending` calls `fillUsername` for a
`"username"` one, so a password is not sent here after the unlock either. The
exactly-one-match rule is unchanged, and the two-minute expiry and origin
check apply as before. On Android `openPopup` is unavailable (F-9), so the user
opens the add-on by hand to unlock. That is the same as on password pages
today.

**Screen 2.** No change. The password badge fills the password; the username
part of the fill finds no field and is skipped, as today.

## What else changes

The privacy promise changes in one sentence everywhere it is made: the add-on
now also consults the background page on a page with a field marked
`autocomplete="username"`, not only on one with a password field. To update:

- `docs/PRIVACY.md` ("Web pages you visit")
- `docs/AMO-SUBMISSION.md`: the reviewer note's content-script paragraph, and
  the username-only fill (the network surface does not change)
- `docs/AMO-LISTING.md` (drop the F-1 bullet, both languages)
- `README.md` ("What it does not do"), `SECURITY.md` if it states the
  password-field rule
- `docs/BACKLOG.md` and `docs/VERIFICATION-2026-08-25.md` § F-1: resolved
- `CHANGELOG.md`

## Testing

Unit tests under jsdom:

- `findIdentifierField`: the token alone, among others, in mixed case; `email`
  alone not matched; hidden, disabled, read-only and off-screen decoys
  rejected; a page with a password field never reaches it.
- `refreshBadge`: an identifier page sends `matches`; a page with neither
  field sends nothing; entries without a username are dropped; zero, one and
  several remaining entries give no badge, a fill badge and a chooser; a tap
  sends `fillUsernameFromPage`, an untrusted click sends nothing.
- `Controller.fillUsername`: the message it sends has `password: null`; it
  refuses http, a non-matching tab, and an entry with no username.
- Pending fill: a `"username"` scope redeems through `fillUsername` and never
  through `fill`.
- `fillFields` with no password field: the identifier field is preferred, and
  the old fallback is kept.
- `isRequest`: the new kind, with its `itemId` checked.

Device checks on the signed build: screen 1 and screen 2 on web.de, Google and
Microsoft, unlocked and locked; and one newsletter or search form, which must
show no badge.

## Left to the builder

- Module layout: whether `findIdentifierField` lives beside `findLoginFields`
  in `autofill.ts`.
- Names of the new request kind and the `PendingFill` field, if better ones
  come up while building.
- The version number. This is a feature, so probably 0.4.0, which would also
  be the first number not spent on the unlisted channel.
