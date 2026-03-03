/**
 * GVH Árfigyelő – Price Monitor
 * Apify Actor — main.js
 *
 * Flow:
 *   1. Scrape arfigyelo.gvh.hu (API interception → DOM fallback)
 *   2. Filter by category / keyword / retailer
 *   3. Compare prices to KV Store history (delta)
 *   4. Save results to Dataset
 *   5. Send Telegram alerts for price drops / new products / below threshold
 *   6. Optional: POST webhook
 */

import { Actor, log } from 'apify';
import { scrapeArfigyelo }     from './scrapers/arfigyelo.js';
import { computePriceDeltas }  from './utils/price_delta.js';
import { sendTelegramAlerts }  from './utils/telegram.js';
import fetch from 'node-fetch';

await Actor.init();

const input = await Actor.getInput() ?? {};

const {
    categories          = [],
    keywords            = [],
    retailers           = [],
    alert_price_drop_pct    = 5,
    alert_price_below       = 0,
    alert_new_product       = false,
    delta_mode          = true,
    max_items           = 500,
    telegram_bot_token  = null,
    telegram_chat_id    = null,
    webhook_url         = null,
} = input;

log.info('GVH Árfigyelő Price Monitor starting', {
    categories: categories.length || 'ALL',
    keywords: keywords.length || 'none',
    retailers: retailers.length || 'ALL',
    delta_mode,
    alert_price_drop_pct,
    alert_price_below,
});

const dataset = await Actor.openDataset();
const kvStore = await Actor.openKeyValueStore();

// ─── 1. Scrape ────────────────────────────────────────────────────────────────
log.info('Scraping arfigyelo.gvh.hu...');
let products = [];
try {
    products = await scrapeArfigyelo({
        categories,
        keywords,
        retailers,
        maxItems: max_items,
    });
    log.info(`Scraped ${products.length} products`);
} catch (err) {
    log.error('Scraping failed', { error: err.message });
    await Actor.exit(1);
}

if (products.length === 0) {
    log.warning('No products scraped. The site structure may have changed. Check the run log and report at https://apify.com/issues');
    await Actor.exit();
}

// ─── 2. Compute price deltas ─────────────────────────────────────────────────
const { allItems, alerts } = await computePriceDeltas(products, kvStore, {
    priceDropPct:        alert_price_drop_pct,
    priceBelowThreshold: alert_price_below,
    alertNewProduct:     alert_new_product,
    deltaMode:           delta_mode,
});

log.info(`Delta: ${allItems.length} items to save, ${alerts.length} alerts triggered`);

// ─── 3. Save to dataset ───────────────────────────────────────────────────────
for (const item of allItems) {
    await dataset.pushData(item);
}
log.info(`Saved ${allItems.length} items to dataset`);

// ─── 4. Telegram alerts ───────────────────────────────────────────────────────
if (telegram_bot_token && telegram_chat_id && alerts.length > 0) {
    log.info(`Sending ${alerts.length} Telegram alerts...`);
    const runUrl = `https://console.apify.com/storage/datasets/${dataset.id}`;
    await sendTelegramAlerts({
        botToken: telegram_bot_token,
        chatId:   telegram_chat_id,
        alerts,
        runUrl,
    });
} else if (alerts.length > 0) {
    log.info(`${alerts.length} alerts triggered but no Telegram configured. Set telegram_bot_token + telegram_chat_id to receive alerts.`);
}

// ─── 5. Webhook ───────────────────────────────────────────────────────────────
if (webhook_url && allItems.length > 0) {
    try {
        await fetch(webhook_url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                timestamp:     new Date().toISOString(),
                total_scraped: products.length,
                items_saved:   allItems.length,
                alerts_count:  alerts.length,
                alerts,
                items:         allItems,
            }),
            timeout: 15000,
        });
        log.info('Webhook delivered');
    } catch (err) {
        log.warning('Webhook failed', { error: err.message });
    }
}

// ─── Summary ──────────────────────────────────────────────────────────────────
log.info(`✅ Done.
  Products scraped : ${products.length}
  Items saved      : ${allItems.length}
  Alerts triggered : ${alerts.length}
  Telegram sent    : ${telegram_bot_token && telegram_chat_id ? 'yes' : 'no (not configured)'}
`);

await Actor.exit();
