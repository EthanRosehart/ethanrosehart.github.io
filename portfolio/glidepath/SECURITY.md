# Security policy

Glidepath is a static single-page app: no server, no accounts, no secrets.
Uploaded data never leaves the visitor's browser, and the nightly pipeline
runs with a repo-scoped GitHub token only. That keeps the attack surface
small, but not zero — the areas worth scrutiny are:

- the generated export files (CSV/XLSX/PPTX/DOCX) — free-text fields are
  escaped against CSV formula injection and HTML injection
  (`GP_csvCell` / `GP_escapeHtml` in `data.jsx`);
- the session-import and share-link paths, which parse
  visitor-supplied JSON;
- the lazily-loaded SheetJS script (the one runtime dependency that
  cannot be self-hosted — see `vendor/README.md`), pinned by host in
  `index.html`'s Content-Security-Policy;
- the nightly data pipeline, which parses responses from public APIs.

## Reporting a vulnerability

Please **do not open a public issue** for anything exploitable. Email
**ethanrosehart@gmail.com** with a description and reproduction steps, or
use GitHub's private vulnerability reporting on this repository if
enabled. You should get an acknowledgement within a week. Fixes ship via
the normal deploy path (a push to `main` redeploys within minutes).
