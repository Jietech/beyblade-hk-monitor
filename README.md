# Beyblade HK 到貨監測 (hkbeybladex-style monitor)

Real-time-ish stock monitor for HK Beyblade storefronts, running entirely on GitHub
(Actions = poller, Pages = front-end). Inspired by hkbeybladex.com's
poll → snapshot → diff → alert pattern.

## How it works
- `pollers/poll.mjs` fetches each store every 15 min (GitHub Actions cron), normalises
  items to `{store, sku, name, price, status, url}`, and diffs vs `data/state.json`.
- Changes (`restock` / `oos` / `new` / `price`) are appended to `data/events.json`.
- `index.html` is a static dashboard (GitHub Pages) reading those JSON files.

## Add a store
Append an entry to the `STORES` array in `pollers/poll.mjs`:

```js
{
  id: 'mystore', name: 'My Store', platform: 'shopify',
  async run() { /* return normalised items */ }
}
```

## Notes / legal
- Only factual SKU/price/availability + a link back are stored. **No copied product photos.**
- Site is `noindex`. Politeness: 1 request per store per run, browser-like UA, 1.5s pacing.
- Some sources (e.g. happinetonline.com) are Cloudflare + hotlink protected (403 to bots) —
  those are linked, not scraped.

## Scheduling & the `workflow` scope blocker (2026-10-15)
The intended design is `.github/workflows/poll.yml` (Actions cron). **But our GitHub PAT
(`Jietech`, `repo, write:packages` only) cannot create/update files under `.github/workflows/`** —
GitHub requires the `workflow` scope. API + git push both return:
`refusing to allow a Personal Access Token to create or update workflow ... without workflow scope`.

Workaround in use: **`run-and-push.sh` runs the poll locally via OpenClaw cron (`*/15 * * * *`)**
and pushes the fresh `data/` snapshot to `main`. Pages then serves it. Same result.

To switch to native Actions later either:
- add `workflow` scope to the PAT (`gh auth refresh -s workflow`), then push `ci-templates/poll.yml` to `.github/workflows/poll.yml`; or
- add the workflow file manually in the GitHub web UI (paste `ci-templates/poll.yml`), then delete the local cron job.

## Run locally
```bash
node pollers/poll.mjs
./run-and-push.sh          # poll + commit + push
python3 -m http.server 8080   # open http://localhost:8080
```

## Live
- Dashboard: https://jietech.github.io/beyblade-hk-monitor/
- Repo: https://github.com/Jietech/beyblade-hk-monitor

