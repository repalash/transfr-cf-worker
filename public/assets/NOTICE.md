# Third-party files served from this directory

These are copied into the repository, so the pages load nothing from another
site at runtime.

| File | What | Source | License |
| --- | --- | --- | --- |
| `openpgp.min.js` | OpenPGP.js 5.10.2, unmodified | `https://cdn.jsdelivr.net/npm/openpgp@5.10.2/dist/openpgp.min.js` | LGPL-3.0-or-later |
| `style.css` | StackEdit stylesheet; KaTeX and italic font faces removed, font URLs made local | `https://stackedit.io/style.css` | Apache-2.0 |
| `fonts/lato-*.woff` | Lato, regular and black | as shipped by StackEdit | SIL Open Font License 1.1 |
| `fonts/roboto-mono-*.woff` | Roboto Mono, regular and bold | as shipped by StackEdit | Apache-2.0 |

`openpgp.min.js` is pinned by the `integrity` hash on its `<script>` tag in
`html/*.html`. To update it, replace the file and the hash together:

```sh
openssl dgst -sha384 -binary public/assets/openpgp.min.js | openssl base64 -A
```
