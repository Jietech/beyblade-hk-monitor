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

## Run locally
```bash
node pollers/poll.mjs
python3 -m http.server 8080   # open http://localhost:8080
```
