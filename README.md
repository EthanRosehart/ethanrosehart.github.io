# ethanrosehart.com

Personal site and interactive resume for Ethan Rosehart — Data & Strategy, Greater Toronto Airports Authority. Built as a single-file static HTML page, hosted free on GitHub Pages at [ethanrosehart.com](https://ethanrosehart.com).

## Files in this repo

| File | Purpose |
|---|---|
| `index.html` | Interactive resume (dark-mode by default, light-mode toggle) |
| `resume.pdf` | ATS-friendly downloadable resume — linked from the site's "Download PDF" button |
| `og-image.png` | 1200×627 social-share preview (LinkedIn, Slack, iMessage, Twitter, etc.) |
| `favicon.svg` | Vector favicon (modern browsers) |
| `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png` | Raster fallback favicons |
| `apple-touch-icon.png` | 180×180 iOS home-screen icon |
| `404.html` | Branded "page not found" page (auto-served by GitHub Pages) |
| `robots.txt` | Tells crawlers the site is open and points to the sitemap |
| `sitemap.xml` | URL inventory for search-engine indexing |
| `CNAME` | Tells GitHub Pages to serve the site at `ethanrosehart.com` |
| `.nojekyll` | Disables GitHub's Jekyll processor (we don't need it) |

## Stack

No build step. Vanilla HTML + CSS + a single Chart.js CDN import. Deploys instantly on push.

## Updating the interactive resume

Edit `index.html` locally or via the GitHub web editor, then commit. GitHub Pages redeploys within ~30 seconds.

## Keeping the ATS PDF in sync

**The interactive site (`index.html`) and the ATS resume are TWO separate documents that must be edited together.** When you change role bullets, dates, certifications, or skills, do the following:

1. **Update `index.html`** with the new content (the interactive resume).
2. **Update the ATS source** — `Ethan Rosehart - Resume (ATS).html` in the parent project folder. Mirror the same wording for any role bullets, dates, skills, or recognition items so recruiters see the same story whether they read the live site or the PDF.
3. **Re-export the PDF:**
   - Open `Ethan Rosehart - Resume (ATS).html` in Chrome or Edge.
   - Press `Ctrl + P` (Windows) or `Cmd + P` (Mac).
   - Destination: **Save as PDF**. Paper size: **Letter**. Margins: **Default**. Headers/footers: **Off**.
   - Save the file as `resume.pdf`.
4. **Upload the new `resume.pdf`** to this repo, replacing the previous one. Commit.
5. The `<a href="/resume.pdf" download>` button on the live site automatically serves the latest version — no other change needed.

### Sync checklist (run before every PDF re-export)

- [ ] Job title, employer, dates current?
- [ ] Most recent bullets reflect actual shipped work?
- [ ] New certifications / training added in **both** files?
- [ ] Skills list (Python, SQL, Power BI, etc.) reflects current proficiencies?
- [ ] Recognition items (awards, panels, committees) up to date in both?
- [ ] Contact info matches across both files?

## Custom domain & SSL

- Apex domain `ethanrosehart.com` points to GitHub Pages via four A records (185.199.108–111.153).
- `www.ethanrosehart.com` CNAMEs to `ethanrosehart.github.io`.
- `ethanrosehart.ca` forwards to `.com` via GoDaddy.
- HTTPS is enforced via GitHub's free Let's Encrypt cert (auto-renewed).

## Social-share preview

The `og-image.png` (1200×627) is referenced in `index.html`'s `<meta property="og:image">` tag and gets fetched by LinkedIn / Slack / Twitter / iMessage / WhatsApp when anyone shares the URL. To refresh the cached preview after updating the image, run the URL through [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/).
