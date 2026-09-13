# Third-party notices

Aeolus is licensed under the GNU Affero General Public License version 3; see
`LICENSE` at the root of this repository. The files listed here come from other
projects and carry their own terms, which apply to those files and not to the
rest of the repository.

This file covers what is **redistributed inside this repository**. Runtime
dependencies installed from npm at build time have their own licences, recorded
in `pnpm-lock.yaml` and readable with `pnpm licenses list`.

---

## Jost

`apps/web/public/fonts/Jost-latin.woff2`
`apps/web/public/fonts/Jost-latin-ext.woff2`

Copyright (c) 2020 The Jost Project Authors, indestructible type\*
<https://github.com/indestructible-type/Jost>

Licensed under the SIL Open Font License, Version 1.1. Full text:
`third_party/Jost-OFL.md`.

The files here are the variable-weight web builds of the Latin and Latin
Extended subsets. The complete family, including the sources, is available from
the project above.

---

## JetBrains Mono

`apps/web/public/fonts/JetBrainsMono-Regular.woff2`
`apps/web/public/fonts/JetBrainsMono-Medium.woff2`
`apps/web/public/fonts/JetBrainsMono-Bold.woff2`

Copyright 2020 The JetBrains Mono Project Authors
<https://github.com/JetBrains/JetBrainsMono>

Licensed under the SIL Open Font License, Version 1.1. Full text:
`third_party/JetBrainsMono-OFL.txt`.

---

## EFF short wordlist

`packages/auth/src/wordlist.ts`

The 1296 words in that file are the Electronic Frontier Foundation's "short"
wordlist for random passphrases, published in 2016 alongside *Deep Dive: EFF's
New Wordlists for Random Passphrases*.

<https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt>
<https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases>

Copyright Electronic Frontier Foundation, licensed
[CC BY 3.0 US](https://creativecommons.org/licenses/by/3.0/us/).

The list is used to generate the credential printed at first launch and the
suggestions the passphrase setup screen offers. The words are transcribed
verbatim; only the file format differs.

---

## Solarized

`apps/web/src/lib/editor-theme.ts`

The editor's background and base tones are Solarized, by Ethan Schoonover,
which is licensed MIT.

<https://ethanschoonover.com/solarized/>

The hex values are reproduced there as constants; no code from the project is
included. The accent colours the editor paints on top of them are Aeolus's own.
