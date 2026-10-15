#!/usr/bin/env node
/**
 * Notify layer for the Beyblade HK monitor.
 *
 * Reads data/events.json, finds events newer than the last notified timestamp
 * (state kept in data/notify-state.json), and pushes restock / new-in-stock
 * alerts to Telegram.
 *
 * Token/chat are read from env (never hardcoded here):
 *   BEY_TG_TOKEN   — Telegram bot token
 *   BEY_TG_CHAT    — target chat id (defaults to Ivan 6467508991)
 *
 * Only *actionable* events are sent: items transitioning to `in` (restock),
 * brand-new in-stock items, and price drops. OOS + price rises are logged,
 * not pushed (avoid noise).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');

const TOKEN = process.env.BEY_TG_TOKEN || '';
const CHAT = process.env.BEY_TG_CHAT || '6467508991';

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

function formatEvent(e) {
  const tag = e.tag ? `[${e.tag}] ` : '';
  const price = e.price != null ? ` · $${e.price}` : '';
  const map = {
    restock: '🟢 返貨',
    oos: '🔴 售罄',
    new: '✨ 新品',
    price: '💲 改價',
  };
  const head = map[e.type] || e.type;
  let extra = '';
  if (e.type === 'price') extra = ` ($${e.from} → $${e.to})`;
  const link = e.url ? `\n<a href="${e.url}">${esc(e.store)} · 睇貨</a>` : '';
  return `${head} ${tag}${esc(e.name || e.sku)}${price}${extra}${link}`;
}

async function main() {
  if (!TOKEN) {
    console.error('BEY_TG_TOKEN not set — skipping notify.');
    process.exit(0);
  }
  const stateFile = join(DATA, 'notify-state.json');
  const { events } = await readJson(join(DATA, 'events.json'), { events: [] });
  const prev = await readJson(stateFile, { lastNotifiedTs: 0 });

  const fresh = events
    .filter((e) => e.ts > prev.lastNotifiedTs)
    // Only push actionable ones.
    .filter((e) => e.type === 'restock' || (e.type === 'new' && e.status === 'in'))
    .sort((a, b) => a.ts - b.ts);

  if (!fresh.length) {
    // Still advance the watermark so we don't re-scan forever.
    const maxTs = events.reduce((m, e) => Math.max(m, e.ts), prev.lastNotifiedTs);
    await writeFile(stateFile, JSON.stringify({ lastNotifiedTs: maxTs }, null, 2) + '\n');
    console.log('No actionable events.');
    return;
  }

  const lines = fresh.slice(0, 20).map(formatEvent);
  const header = `🌀 <b>Beyblade 到貨通知</b> (${fresh.length} 項)`;
  const footer =
    '\n\n<a href="https://jietech.github.io/beyblade-hk-monitor/">睇全部 →</a>';

  // Telegram messages cap ~4096 chars; chunk if needed.
  let buf = header;
  for (const l of lines) {
    if ((buf + '\n' + l).length > 3500) {
      await sendTelegram(buf);
      buf = '';
    }
    buf += (buf ? '\n' : '') + l;
  }
  await sendTelegram(buf + footer);

  const maxTs = events.reduce((m, e) => Math.max(m, e.ts), prev.lastNotifiedTs);
  await writeFile(stateFile, JSON.stringify({ lastNotifiedTs: maxTs }, null, 2) + '\n');
  console.log(`Notified ${fresh.length} events.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
