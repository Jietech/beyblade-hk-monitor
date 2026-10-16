#!/usr/bin/env node
/**
 * Beyblade HK stock monitor — GitHub Actions poller.
 *
 * Architecture: poll stores → snapshot → diff vs previous → events.
 * Zero dependencies (Node 20+ global fetch). Polite: 1 req/store/run.
 *
 * Usage:  node pollers/poll.mjs
 * Output: data/state.json, data/events.json
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-HK,zh;q=0.9,en;q=0.8,ja;q=0.7',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Focus filter — Ivan (2026-10-16): only track the BX-53 All-in-One set.
// Matches "BX-53", "BX53", "BX 53" (case-insensitive) anywhere in the name.
// Set to null to track every Beyblade product again.
// ---------------------------------------------------------------------------
export const TARGET_FILTER = /\bBX[-\s]?53\b/i;
const matchesTarget = (name = '') =>
  !TARGET_FILTER || TARGET_FILTER.test(String(name));

async function fetchText(url, { json = false } = {}) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return json ? res.json() : res.text();
}

/** Normalise a raw item into a stable record. */
function normalise({ store, sku, name, price, status, url }) {
  return {
    store,
    sku: String(sku),
    name: String(name || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    // Focus filter is applied centrally in main() — keep parsers generic.
    price: price == null ? null : Number(price),
    status: status === 'in' ? 'in' : 'out',
    url,
  };
}

/** Model tag from the product name (BX / UX / CX / Burst / Metal). */
export function modelTag(name = '') {
  const s = name.toUpperCase();
  if (/\bCX[- ]?\d/.test(s) || /\bCX\b/.test(s)) return 'CX';
  if (/\bUX[- ]?\d/.test(s) || /\bUX\b/.test(s)) return 'UX';
  if (/\bBX[- ]?\d/.test(s) || /\bBX\b/.test(s)) return 'BX';
  if (/BURST/.test(s)) return 'BURST';
  if (/METAL/.test(s)) return 'METAL';
  return 'OTHER';
}

// ---------------------------------------------------------------------------
// Store parsers — each returns an array of normalised items.
// Add a store by dropping an entry here (or pollers/stores/<id>.mjs).
// ---------------------------------------------------------------------------
/**
 * Generic Shopify storefront parser via the public `products.json` feed.
 * Works on any Shopify shop (tclub.com.hk, and most HK toy stores).
 */
async function parseShopify(storeId, baseUrl) {
  const items = [];
  for (let page = 1; page <= 4; page++) {
    let data;
    try {
      data = await fetchText(`${baseUrl}/products.json?limit=250&page=${page}`, {
        json: true,
      });
    } catch {
      break;
    }
    const products = data.products || [];
    if (!products.length) break;
    for (const p of products) {
      const name = p.title || '';
      if (!/beyblade|爆旋|陀螺|\bBX[- ]?\d|\bUX[- ]?\d|\bCX[- ]?\d/i.test(name))
        continue;
      // Exclude gift/promo-only SKUs that aren't real Beyblade products.
      if (/贈品|禮品|gift/i.test(name)) continue;
      // Moonroad only sells a couple Bey items; keep the noise filter tight.
      if (/pokemon|龍珠|gundam|高達|日本酒|扭蛋/i.test(name)) continue;
      const variants = p.variants || [];
      if (!variants.length) continue;
      const anyAvailable = variants.some((v) => v.available);
      const v = variants.find((x) => x.available) || variants[0];
      const sku = String(v.sku || p.handle || p.id);
      if (v.price != null && Number(v.price) >= 900) continue;
      items.push(
        normalise({
          store: storeId,
          sku,
          name,
          price: v.price ?? null,
          status: anyAvailable ? 'in' : 'out',
          url: `${baseUrl}/products/${p.handle}`,
        }),
      );
    }
    if (products.length < 250) break;
    await sleep(1200);
  }
  return items;
}

/**
 * Shopline storefront parser (toytoy.com.hk etc.) — HTML category/search page.
 * Shopline renders `.Product-item` blocks with `.title` and `HK$x` prices.
 */
async function parseShopline(storeId, baseUrl, categoryPath) {
  const items = [];
  const html = await fetchText(`${baseUrl}${categoryPath}`);
  for (const block of html.split(/(?=class="Product-item")/).slice(1)) {
    const link = block.match(/href="(https:\/\/[^"]*\/products\/[^"]+)"/);
    if (!link) continue;
    const titleM = block.match(/<div class="title[^"]*">([^<]+)<\/div>/);
    const name = titleM
      ? titleM[1].replace(/&amp;/g, '&').replace(/\(.*?\)\s*/g, '').trim()
      : '';
    if (!/beyblade|爆旋|陀螺|\bBX[- ]?\d|\bUX[- ]?\d|\bCX[- ]?\d/i.test(name))
      continue;
    const priceM = block.match(/HK\$([\d,\.]+)/);
    const soldout = /sold-out|售罄|Sold out|已售完|out-of-stock/i.test(block);
    const slug = link[1].split('/products/')[1].split('?')[0];
    items.push(
      normalise({
        store: storeId,
        sku: slug,
        name,
        price: priceM ? priceM[1].replace(/,/g, '') : null,
        status: soldout ? 'out' : 'in',
        url: link[1],
      }),
    );
  }
  return items;
}

/**
 * Amazon.co.jp search-results parser.
 * Plain HTML fetch works with a normal desktop UA + ja-JP Accept-Language.
 * Each result is a <div data-asin=...> block; we read the ASIN, the <h2> title
 * and the price (HKD/JPY depending on geo). Availability: presence in results
 * = in stock; "在庫切れ" / "Currently unavailable" marks out of stock.
 */
async function parseAmazonJP(storeId, searchTerm) {
  const url = `https://www.amazon.co.jp/s?k=${encodeURIComponent(searchTerm)}`;
  // NOTE: Amazon blocks Node/undici's TLS fingerprint, so shell out to curl
  // (same approach that works interactively). curl is present on GH runners.
  // Persistent cookie jar is REQUIRED: without cookies Amazon returns a
  // ~1.5KB bm-verify/bot interstitial instead of the results page. With a
  // jar, the first request usually passes cleanly. --compressed so we get
  // real HTML (not gzip bytes) when curl doesn't auto-decode.
  const jar = join(DATA, '.amazon-cookies.txt');
  const curlArgs = [
    '-sL',
    '--compressed',
    '--max-time', '30',
    '-c', jar,
    '-b', jar,
    '-A', UA,
    '-H', 'Accept-Language: ja-JP,ja;q=0.9,en;q=0.8',
    '-H', 'Accept: text/html,application/xhtml+xml,*/*;q=0.8',
  ];
  let html = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await execFileP('curl', [...curlArgs, url], {
        maxBuffer: 20 * 1024 * 1024,
      });
      html = stdout;
    } catch (err) {
      throw new Error(`curl failed: ${err.message}`);
    }
    // Detect the bm-verify interstitial (meta refresh + pow script).
    const isChallenge = /bm-verify/.test(html) && html.length < 60000;
    if (!isChallenge) break;
    await sleep(2000 + attempt * 1500);
  }
  if (!html || html.length < 5000)
    throw new Error(`Amazon short/empty response (${html.length} bytes)`);
  if (/bm-verify|captcha|automated access|api-services-support/i.test(html.slice(0, 4000)))
    throw new Error('Amazon bot-check page');

  const items = [];
  const blocks = html.split(/(?=<div[^>]*data-asin="[A-Z0-9]{10}")/).slice(1);
  const seen = new Set();
  for (const b of blocks) {
    const asin = (b.match(/data-asin="([A-Z0-9]{10})"/) || [])[1];
    if (!asin || seen.has(asin)) continue;
    const titleM = b.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([^<]{5,200})<\/span>/);
    const title = titleM ? titleM[1].replace(/&amp;/g, '&').trim() : '';
    if (!/beyblade|ベイブレード|\bBX[- ]?\d|\bUX[- ]?\d|\bCX[- ]?\d/i.test(title))
      continue;
    if (/カートに入れる|Buy Now/.test(title)) continue;
    const priceM = b.match(/a-offscreen">(?:HKD|JPY|￥)?\s*([\d,\.]+)/);
    const oos = /在庫切れ|一時的に在庫切れ|Currently unavailable|Out of Stock/i.test(b);
    seen.add(asin);
    items.push(
      normalise({
        store: storeId,
        sku: asin,
        name: title,
        price: priceM ? priceM[1].replace(/,/g, '') : null,
        status: oos ? 'out' : 'in',
        url: `https://www.amazon.co.jp/dp/${asin}`,
      }),
    );
  }
  return items;
}

/**
 * ToysRUs Hong Kong (Salesforce Commerce Cloud) category parser.
 * The category grid is served by the Demandware `Search-ShowAjax` endpoint,
 * which returns product tiles carrying a `data-metadata` JSON blob with
 * id / name / price / sku / quantity. Presence = listed; sold-out tiles carry
 * a sold-out class/text. Politeness: 1 request per category per run.
 */
async function parseToysRUs(storeId, cgid) {
  const url =
    `https://www.toysrus.com.hk/on/demandware.store/Sites-ToysRUs_HK-Site/en_HK/Search-ShowAjax` +
    `?cgid=${encodeURIComponent(cgid)}&sz=200`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-HK,zh;q=0.9,en;q=0.8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html,*/*;q=0.8',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();

  const items = [];
  const metas = html.match(/data-metadata='([^']+)'/g) || [];
  for (const raw of metas) {
    let m;
    try {
      m = JSON.parse(raw.slice("data-metadata='".length, -1));
    } catch {
      continue;
    }
    const name = m.name || m.name_local || '';
    if (!/beyblade|爆旋|陀螺|\bBX[- ]?\d|\bUX[- ]?\d|\bCX[- ]?\d/i.test(name))
      continue;
    const pid = String(m.sku || m.id || '');
    if (!pid) continue;
    items.push(
      normalise({
        store: storeId,
        sku: pid,
        name,
        price: m.price != null ? m.price : null,
        status: 'in',
        url: `https://www.toysrus.com.hk/en-hk/p/${pid}.html`,
      }),
    );
  }
  return items;
}

// ---------------------------------------------------------------------------
// Store registry
// ---------------------------------------------------------------------------
const STORES = [
  // Shopify storefront: tclub.com.hk (HK Beyblade specialist)
  {
    id: 'tclub',
    name: 'TClub HK',
    platform: 'shopify',
    run: () => parseShopify('tclub', 'https://www.tclub.com.hk'),
  },
  // Shopline storefront: toytoy.com.hk (HK toy shop)
  {
    id: 'toytoy',
    name: 'ToyToy HK',
    platform: 'shopline',
    run: () => parseShopline('toytoy', 'https://www.toytoy.com.hk', '/categories/beyblade-x'),
  },
  // Shopify storefront: moonroadhk.com (HK collectibles)
  {
    id: 'moonroad',
    name: 'Moonroad HK',
    platform: 'shopify',
    run: () => parseShopify('moonroad', 'https://moonroadhk.com'),
  },
  // Amazon Japan search (Takara Tomy official Beyblade X listings ship from JP)
  {
    id: 'amazonjp',
    name: 'Amazon JP',
    platform: 'amazon',
    run: () => parseAmazonJP('amazonjp', 'ベイブレードX'),
  },
  // ToysRUs Hong Kong (SFCC) — Spinning & Battle Tops category
  {
    id: 'toysrus',
    name: 'ToysRUs HK',
    platform: 'sfcc',
    run: () => parseToysRUs('toysrus', 'spinning_battle_tops_hk'),
  },
];

// ---------------------------------------------------------------------------
// Diff engine
// ---------------------------------------------------------------------------
function diff(prev, next) {
  const events = [];
  const now = Date.now();
  for (const [sku, item] of Object.entries(next)) {
    const before = prev[sku];
    if (!before) {
      events.push({ ts: now, type: 'new', ...item });
    } else if (before.status !== item.status) {
      events.push({
        ts: now,
        type: item.status === 'in' ? 'restock' : 'oos',
        from: before.status,
        to: item.status,
        ...item,
      });
    } else if (before.price !== item.price && item.price != null) {
      events.push({
        ts: now,
        type: 'price',
        from: before.price,
        to: item.price,
        ...item,
      });
    }
  }
  return events;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  await mkdir(DATA, { recursive: true });
  const stateFile = join(DATA, 'state.json');
  const eventsFile = join(DATA, 'events.json');

  const prev = await readJson(stateFile, { items: {}, updatedAt: null });
  const prevEvents = await readJson(eventsFile, { events: [] });

  const snapshot = {};
  const storeMeta = [];
  for (const store of STORES) {
    const started = Date.now();
    try {
      const items = (await store.run()).filter((it) => matchesTarget(it.name));
      for (const it of items) snapshot[`${it.store}:${it.sku}`] = it;
      storeMeta.push({
        id: store.id,
        name: store.name,
        ok: true,
        count: items.length,
        ms: Date.now() - started,
      });
      console.log(`[ok]   ${store.id}: ${items.length} items`);
    } catch (err) {
      storeMeta.push({
        id: store.id,
        name: store.name,
        ok: false,
        error: String(err.message || err),
        ms: Date.now() - started,
      });
      console.warn(`[fail] ${store.id}: ${err.message}`);
    }
    await sleep(1500); // polite pacing between stores
  }

  // On first run (empty prev), seed the snapshot WITHOUT flooding events:
  // new-item events only make sense once we have a baseline.
  const hadBaseline = Object.keys(prev.items || {}).length > 0;
  let events = hadBaseline ? diff(prev.items || {}, snapshot) : [];
  // Tag each event with a model series for the UI.
  for (const e of events) e.tag = modelTag(e.name);

  await writeFile(
    stateFile,
    JSON.stringify(
      {
        updatedAt: Date.now(),
        count: Object.keys(snapshot).length,
        stores: storeMeta,
        items: snapshot,
      },
      null,
      2,
    ) + '\n',
  );

  // Append new events, keep newest 500.
  const merged = [...events.reverse(), ...(prevEvents.events || [])].slice(0, 500);
  await writeFile(
    eventsFile,
    JSON.stringify({ updatedAt: Date.now(), events: merged }, null, 2) + '\n',
  );

  console.log(
    `\nSnapshot: ${Object.keys(snapshot).length} items | new events: ${events.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
