/**
 * Price delta tracker using Apify Key-Value Store.
 *
 * Stores last known prices per product ID.
 * On each run, compares current prices to previous ones.
 * Returns: which products are new, which dropped in price.
 */

import { log } from 'apify';

const KV_KEY = 'PRICE_HISTORY';

export async function computePriceDeltas(products, kvStore, {
    priceDropPct = 0,
    priceBelowThreshold = 0,
    alertNewProduct = false,
    deltaMode = true,
}) {
    // Load previous price history
    let history = {};
    try {
        const stored = await kvStore.getValue(KV_KEY);
        if (stored && typeof stored === 'object') history = stored;
    } catch (err) {
        log.warning('Could not load price history', { error: err.message });
    }

    const alerts    = [];
    const allItems  = [];
    const newHistory = { ...history };

    for (const product of products) {
        const id = product.id;
        const prev = history[id];
        const currentPrice = product.price_current;

        // Track in new history
        if (currentPrice != null) {
            newHistory[id] = {
                price: currentPrice,
                name:  product.name,
                seen:  new Date().toISOString(),
            };
        }

        let isNew      = !prev;
        let priceDrop  = null;
        let priceDropPctActual = null;

        if (prev && currentPrice != null && prev.price != null && prev.price > currentPrice) {
            priceDrop = prev.price - currentPrice;
            priceDropPctActual = Math.round((priceDrop / prev.price) * 100);
            product.price_previous = product.price_previous ?? prev.price;
            product.price_drop_pct = product.price_drop_pct ?? priceDropPctActual;
        }

        // Determine which items to include in output
        if (!deltaMode) {
            allItems.push(product);
        } else {
            // In delta mode: only include changed or new items
            if (isNew || priceDrop != null) {
                allItems.push(product);
            }
        }

        // Build alerts
        // 1. Price drop alert
        if (priceDropPct > 0 && priceDropPctActual != null && priceDropPctActual >= priceDropPct) {
            alerts.push({
                ...product,
                alert_type:      'price_drop',
                price_drop_pct:  priceDropPctActual,
                price_drop_abs:  priceDrop,
            });
        }

        // 2. Price below threshold alert
        if (priceBelowThreshold > 0 && currentPrice != null && currentPrice < priceBelowThreshold) {
            alerts.push({
                ...product,
                alert_type:       'price_below',
                alert_threshold:  priceBelowThreshold,
            });
        }

        // 3. New product alert
        if (alertNewProduct && isNew) {
            alerts.push({
                ...product,
                alert_type: 'new_product',
            });
        }
    }

    // Persist updated history (cap at 20k entries to avoid KV size limits)
    const entries = Object.entries(newHistory);
    const capped  = Object.fromEntries(
        entries
            .sort((a, b) => (b[1].seen > a[1].seen ? 1 : -1))
            .slice(0, 20000)
    );

    try {
        await kvStore.setValue(KV_KEY, capped);
        log.info(`Price history: ${Object.keys(capped).length} products tracked`);
    } catch (err) {
        log.warning('Could not save price history', { error: err.message });
    }

    return { allItems, alerts };
}
