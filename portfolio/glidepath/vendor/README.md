# Vendored runtime dependencies

Self-hosted copies of the two scripts `index.html` loads before the app
bundle. They used to come from unpkg.com, but a CDN outage left the app
stuck on its loading screen with no error — GitHub Pages already serves
everything else on this page, so serving React the same way removes the
only third-party point of failure.

| File | Package | Version |
|---|---|---|
| `react.production.min.js` | [react](https://www.npmjs.com/package/react) | 18.3.1 |
| `react-dom.production.min.js` | [react-dom](https://www.npmjs.com/package/react-dom) | 18.3.1 |

Both files are byte-identical to the `umd/` builds inside the published
npm tarballs (MIT licensed, header comment retained).

## Updating

```sh
npm pack react@<version> react-dom@<version>
tar xzf react-<version>.tgz  package/umd/react.production.min.js
mv package/umd/react.production.min.js vendor/
tar xzf react-dom-<version>.tgz  package/umd/react-dom.production.min.js
mv package/umd/react-dom.production.min.js vendor/
```

Keep the two versions in lockstep, and note that React 19 dropped UMD
builds — moving past 18.x means switching `index.html` and `build.mjs`
to ESM first.
