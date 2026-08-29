# Third-party notices

This add-on is licensed under GPL-3.0-only (see `LICENSE`). It ships, or builds
against, the following third-party components, whose own notices are reproduced
as their licences require.

## hash-wasm

Bundled into the built `background.js`. Used for PBKDF2 and Argon2id key
derivation.

> MIT License
>
> Copyright (c) 2020 Dani Biró
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

**Known gap:** the bundler does not carry this notice into `dist/background.js`,
so a signed XPI redistributes the code without it. The notice here covers the
repository; closing it for the built artefact is an open item in
`docs/BACKLOG.md`.

## Public Suffix List

Vendored as `src/vault/public-suffix-data.ts`, a generated file. Retrieved
2026-08-07 from <https://publicsuffix.org/list/public_suffix_list.dat> and used
to compute the registrable domain a vault entry is matched against.

The list is distributed under the Mozilla Public License 2.0, which is
compatible with GPL-3.0. The file carries its own attribution header, which must
not be removed when the snapshot is refreshed.
