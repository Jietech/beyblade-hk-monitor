# Beyblade HK 到貨監測 (hkbeybladex-style monitor)

Real-time-ish stock monitor for HK Beyblade storefronts, running entirely on GitHub
(Actions = poller, Pages = front-end). Inspired by hkbeybladex.com's
poll → snapshot → diff → alert pattern.

## How it works
- `pollers/poll.mjs` fetches each store every 15 min (GitHub Actions cron), normalises
  items to `{store, sku, name, price, status, url}`, and diffs vs `data/state.json`.
- Changes (`restock` / `oos` / `new` / `price`) are appended to `data/events.json`.
- `index.html` is a static dashboard (GitHub Pages) reading those JSON files.
- `pollers/notify.mjs` pushes actionable events (restock / new-in-stock) to Telegram.

### Stores monitored (2026-10-15)
| id | name | platform | method |
|---|---|---|---|
| `tclub` | TClub HK | Shopify | `products.json` |
| `toytoy` | ToyToy HK | Shopline | HTML `/categories/beyblade-x` |
| `moonroad` | Moonroad HK | Shopify | `products.json` |
| `amazonjp` | Amazon JP | Amazon | search HTML via `curl` (Node fetch is TLS-blocked) |
| `toysrus` | ToysRUs HK | Salesforce CC | `Search-ShowAjax?cgid=spinning_battle_tops_hk` (`data-metadata`) |

Notes on the two new sources:
- **Amazon JP**: Node's built-in `fetch` is blocked by Amazon (short/bot-check response);
  the parser shells out to `curl` which works. Prices are returned in HKD for our geo.
  Presence in search results = in stock; `在庫切れ` / `Currently unavailable` = out.
- **ToysRUs HK**: SFCC storefront; the `Spinning & Battle Tops` category is currently
  **empty (0 products)** — the parser will correctly show 0 and fire `new` events once
  Takara Tomy stock appears. Grid tiles carry a `data-metadata` JSON blob (id/name/price/sku).

Blocked/unsuitable sources: happinetonline.com (CloudFront + hotlink 403), theclub.com.hk (Magento, no public feed), animespro / hobbyland / maytoys / battleground (unreachable from here).

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

