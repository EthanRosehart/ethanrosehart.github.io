# Contributing to Glidepath

Thanks for looking at this. The [README](README.md) covers the
architecture; this file covers the mechanics of changing it safely.

## Local setup

```bash
# run the app (committed bundle + data snapshots, no build needed)
python3 -m http.server 8000     # from portfolio/glidepath/, then open :8000

# rebuild after editing any .jsx file
npm install && npm run build    # or `npm run watch` while developing

# tests
node --test                                    # data.jsx model/helpers + pipeline helpers
pip install -r scripts/requirements.txt
pytest scripts/test_build_forecast.py -v       # build-forecast.py helpers
node scripts/validate-data.mjs                 # committed snapshots still match their schemas
```

## Ground rules

1. **No synthetic data, ever.** An airport appears only if a public feed
   carries real monthly data for it; a fetcher failure keeps the last good
   snapshot rather than inventing numbers. This is the product's core
   promise — PRs that soften it will be declined.
2. **Model changes need evidence.** Anything that alters forecast output
   (Prophet settings, the elasticity formula, ETS, backtesting) must come
   with a before/after backtest comparison in the PR description.
3. **Every number stays traceable.** New data sources document themselves
   in `data/README.md` (source, dataset IDs, caveats) and emit provenance
   into `data/manifest.json`.
4. **The bundle is a build artifact but it's committed.** Run
   `npm run build` before committing `.jsx` changes (CI also rebuilds on
   `main`, but keep the diff honest).
5. **Fetcher contract** (see `scripts/`): own your entries in
   `activity-index.json` + `series/`, never clobber another source's
   airports, keep last-good on failure, exit non-zero on total failure.
   Pure parsing logic should be exported and covered by a fixture test.

## What's most useful

The [ROADMAP](ROADMAP.md) is the priority list. National data feeds
(UK CAA, Brazil ANAC, Australia BITRE) and accessibility work are the
most valuable contributions that don't require touching the models.
