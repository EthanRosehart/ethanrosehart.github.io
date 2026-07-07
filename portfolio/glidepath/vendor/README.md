# Vendored runtime dependencies

Self-hosted copies of third-party scripts the app runs. React used to
come from unpkg.com, but a CDN outage left the app stuck on its loading
screen with no error — GitHub Pages already serves everything else on
this page, so serving these the same way removes third-party points of
failure (and the supply-chain risk of an un-hashed CDN script).

| File | Package | Version | Loaded |
|---|---|---|---|
| `react.production.min.js` | [react](https://www.npmjs.com/package/react) | 18.3.1 | `index.html`, at boot |
| `react-dom.production.min.js` | [react-dom](https://www.npmjs.com/package/react-dom) | 18.3.1 | `index.html`, at boot |
| `pptxgen.bundle.js` | [pptxgenjs](https://www.npmjs.com/package/pptxgenjs) | 3.12.0 | lazily, by the PPTX export |

All files are byte-identical to the builds inside the published npm
tarballs (MIT licensed, header comments retained).

**Not vendored:** SheetJS (`xlsx.full.min.js`, used by the XLSX export
and the spreadsheet-upload parser) — versions ≥0.19 are only distributed
via cdn.sheetjs.com, not npm, so there's no integrity-checked tarball to
vendor from. It stays lazily CDN-loaded, with its host pinned in
`index.html`'s Content-Security-Policy; a CDN failure degrades soft
(CSV export and the rest of the app keep working).

## Updating

```sh
npm pack react@<version> react-dom@<version> pptxgenjs@<version>
tar xzf react-<version>.tgz  package/umd/react.production.min.js
mv package/umd/react.production.min.js vendor/
tar xzf react-dom-<version>.tgz  package/umd/react-dom.production.min.js
mv package/umd/react-dom.production.min.js vendor/
tar xzf pptxgenjs-<version>.tgz  package/dist/pptxgen.bundle.js
mv package/dist/pptxgen.bundle.js vendor/
```

Keep the two versions in lockstep, and note that React 19 dropped UMD
builds — moving past 18.x means switching `index.html` and `build.mjs`
to ESM first.
