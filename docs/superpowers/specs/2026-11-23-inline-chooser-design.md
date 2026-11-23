# Inline chooser for several matches (F-9) — Design

Approved 2026-11-23 (approach chosen in conversation; "go ahead").

## Why

With several entries matching a page, the badge is in chooser mode. A tap
sends `handOff`, which tries `browserAction.openPopup()`. Firefox for Android
cannot open an extension popup, so nothing visible happens and nothing is
filled (F-9 in `docs/DEVICE-CHECKS.md`). It reads as a broken fill.

## Goal

A tap on a chooser badge opens a small list under the password field: one row
per matching entry, name and username. A tap on a row fills that entry through
the same `fillFromPage` message the single-match badge sends. Two taps, no
trip through ⋮ → Extensions → Vaultwarden.

## Non-goals

- No change to the locked case: the unlock badge still records a pending fill
  and hands off (an in-page unlock UI stays a non-goal, 2026-08-25 design §3).
- No in-page error reporting for a refused fill; unchanged from the
  single-match badge.
- No search or filter in the list.

## Approaches considered

1. **List on the page (chosen).** Solves the problem; names and usernames
   already reach the content script (2026-08-25 design §9), so nothing new is
   exposed to it.
2. Hint on tap ("2 entries — open the add-on to choose"). Honest but leaves the
   long route.
3. No badge in chooser mode on Android. Looks like "no entry", and the badge
   shown while locked would vanish after unlocking.

## Behaviour (builder's calls, stated)

- Same behaviour on every platform, desktop included; chooser mode no longer
  sends `handOff`. `handOff` stays for the locked case.
- The list lives in its own host element with a closed shadow root and
  `all:initial`, like the badge, z-index max. Positioned under the field, left
  edge aligned to the field, at least 220 px wide and never wider than the
  viewport; flips above the field when there is no room below. Follows the
  field on scroll and resize like the badge.
- Rows: entry name (bold), username below, or "No username". An entry that
  could not be decrypted is shown disabled with "Could not be decrypted" and
  does nothing on tap.
- At most about five rows visible; more scroll inside the list.
- Closes on: a row tap (after sending the fill), a second badge tap (toggle),
  a tap anywhere else, Escape, and whenever the badge is unmounted (page
  refresh of the badge, field gone).
- Clicks on the list and its rows are swallowed in the capture phase, as the
  badge's are, so the page's own handlers never see them.
- Accessibility: list `role="menu"`, rows `role="menuitem"`, badge host gets
  `aria-expanded`.

## Testing

Unit tests under jsdom for the list module (rows, disabled row, close paths,
position flip) and for `refreshBadge` (chooser tap opens the list and sends no
`handOff`; row tap sends `fillFromPage` with that id). Device check on the
signed 0.3.4: V2 again with two entries for one page.
