# hkbeybladex-style Stock Monitor — Clone Build

**Goal (Ivan 2026-10-15):** Research the "real-time Beyblade stock monitor" pattern (ref: happinetonline.com product page + hkbeybladex.com aggregator) and build **an equivalent site running on GitHub**.

## What the reference does
- **happinetonline.com** — Takara Tomy's official online store (JP). Product pages (`/ec/pro/disp/1/<id>?sFlg=2`) show live availability. It is **cloudfront-fronted, hotlink-protected (403 to non-browser)** and rate-limits hard under load ("アクセスが集中しております"). This is the *source* signal.
- **hkbeybladex.com** — aggregator: polls N stores on a cron, snapshots per-SKU (sku/price/status), diffs, and pushes restock events to Threads/Discord/Telegram + a `/history` feed. Static front-end on Cloudflare.

## Our clone architecture (100% on GitHub, $0)
```
GitHub Actions (cron */15)          GitHub Pages (static)
  pollers/*.mjs  ──►  data/state.json  ──►  index.html (live table + /history)
        │                     │
        │  diff (oos→in)      │
        └──► data/events.json ┘        notify (optional): webhook → TG/Discord
```
- **Poller**: Node 20, per-store parser modules. `fetch` with browser-like headers + polite delay. State kept in `data/state.json` (committed by the workflow `github-actions[bot]`).
- **Diff engine**: compares previous snapshot vs new → emits events `{ts, store, sku, name, from, to, price, url}` into `data/events.json` (append, capped).
- **Front-end**: static HTML + vanilla JS reading `data/*.json` (no build step). Search/filter by model tag (BX/UX/CX), store, status.
- **Scheduling**: `.github/workflows/poll.yml` on `schedule: '*/15 * * * *'` + `workflow_dispatch`.
- **Legal posture**: we store **only factual SKU/price/availability + a link back**. No copied product photos. `noindex` on the site. Politeness: 1 req/store/run, identifying UA, honour robots.

## Store parser strategy
| Store | Platform | Method |
|---|---|---|
| tclub.com.hk | Shopify | `/search?type=product&q=` HTML or `products.json` |
| theclub.com.hk | Magento | REST/HTML |
| happinetonline.com | Cloudflare/S3 | **blocked to bots** → record as manual-entry / affiliate link only |
| others | Shopify/Shopline | `products.json` (Shopify) / HTML |

Parsers are pluggable: drop a file in `pollers/stores/` exporting `{id, name, url, parse(html)}`.

## Why this is the right version
Previous research (`work/woah-bbx-arbitrage-2026-10-10/RESEARCH.md`) flagged that **"copy price × 1.15 and auto-list someone else's stock" is not advisable** (copyright/trademark on photos & brand, no fulfilment guarantee, thin margin). This build keeps the **monitor → alert** mechanic (which is the valuable part) and drops the risky arbitrage layer. It can later power Option A (affiliate), B (group-buy), or C (sell the service to retailers).
