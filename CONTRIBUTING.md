# Contributing

Thanks for looking. A few things worth knowing before you spend time.

## Security reports do not go here

Anything that would let someone read a vault they should not goes through
[`SECURITY.md`](SECURITY.md), privately. Not the issue tracker.

## Getting set up

```bash
npm ci
npm test
```

Node 22.23.4. `npm test` runs the typechecker and then the unit suite; it needs
no network and no Docker, and it must be green before anything else is worth
discussing.

`npm run test:integration` starts a pinned Vaultwarden container, runs the live
suite against it, and tears it down. It needs Docker. It talks only to the
container it starts — **never point it at a real vault.**

## Tests come first

Write the failing test, watch it fail for the reason you expect, then make it
pass. The suite is the argument that this add-on can be trusted with a password,
so a change that cannot be expressed as a test is a change that needs discussing
before it needs writing.

Two areas want more than a unit test:

- **Cryptography, key handling and the API layer.** A mock proves you called
  what you meant to call. Whether a real Vaultwarden accepts it is a different
  question, and `tests/integration/` is where it gets answered.
- **Anything touching a page.** jsdom covers the field detection and the badge,
  and it does not cover Firefox for Android. `docs/DEVELOPMENT.md` has the
  manual checklist, and `docs/VERIFICATION-2026-08-25.md` shows what a run of it
  looks like — including the traps that cost time, such as `web-ext` not
  reloading on Android whatever it prints.

## Scope

`docs/DEVELOPMENT.md` lists what is deferred and what is known to be missing,
and `docs/BACKLOG.md` indexes the open work in the order it should be picked up.
Both lists are deliberate. If you want to build something on them, say so in an
issue first — not for permission, but because some of them have a decision
attached that is not obvious from the code.

## Commits

One change per commit, with a message that says why rather than what. The diff
already says what.

## Licence

Contributions are made under GPL-3.0-only, the licence this repository ships
under.
