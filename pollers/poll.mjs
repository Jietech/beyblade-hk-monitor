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
async function parseShopify(baseUrl) {
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
      const variants = p.variants || [];
      if (!variants.length) continue;
      const anyAvailable = variants.some((v) => v.available);
      const v = variants.find((x) => x.available) || variants[0];
      const sku = String(v.sku || p.handle || p.id);
      if (v.price != null && Number(v.price) >= 900) continue;
      items.push(
        normalise({
          store: 'tclub',
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

// ---------------------------------------------------------------------------
// Store registry
// ---------------------------------------------------------------------------
const STORES = [
  // Shopify storefront: tclub.com.hk (HK Beyblade retailer)
  {
    id: 'tclub',
    name: 'TClub HK',
    platform: 'shopify',
    run: () => parseShopify('https://www.tclub.com.hk'),
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
      const items = await store.run();
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
