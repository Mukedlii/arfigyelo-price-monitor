/**
 * Scraper: arfigyelo.gvh.hu
 *
 * Free/cheap approach: hit the JSON endpoints directly (no Playwright).
 * Confirmed endpoints (2026-03-03):
 *   - GET https://arfigyelo.gvh.hu/api/categories
 *   - GET https://arfigyelo.gvh.hu/api/products-by-category/<categoryId>
 *   - GET https://arfigyelo.gvh.hu/api/shops
 *   - GET https://arfigyelo.gvh.hu/api/chain-stores
 */

import { log } from 'apify';
import fetch from 'node-fetch';
import { removeDiacritics } from '../utils/helpers.js';

const BASE_URL = 'https://arfigyelo.gvh.hu';

export async function scrapeArfigyelo({ categories = [], keywords = [], retailers = [], maxItems = 500 }) {
    // Load categories (id + name)
    const catsRaw = await fetchJson(`${BASE_URL}/api/categories`);
    const cats = flattenCategories(catsRaw);
    if (cats.length === 0) {
        log.warning('Árfigyelő: categories endpoint returned no data');
        return [];
    }

    // Normalize category filter: accept slug fragments OR numeric ids
    const wanted = categories.map(String).map(s => s.trim()).filter(Boolean);
    const categoriesToFetch = wanted.length === 0
        ? cats
        : cats.filter(c => {
            const id = String(c.id ?? '');
            const name = String(c.name ?? '');
            const path = String(c.path ?? '');
            const slug = toSlug(name);
            return wanted.some(w => w === id || path.includes(w) || slug.includes(toSlug(w)) || name.toLowerCase().includes(w.toLowerCase()));
        });

    const out = [];

    for (const c of categoriesToFetch) {
        if (maxItems > 0 && out.length >= maxItems) break;

        const catId = c.id;
        if (!catId) continue;

        const payload = await fetchJson(`${BASE_URL}/api/products-by-category/${catId}`);
        const items = Array.isArray(payload) ? payload : (payload?.products ?? []);
        if (!Array.isArray(items) || items.length === 0) continue;

        for (const raw of items) {
            const norms = normalizeProductsFromRow(raw, c.name);
            for (const norm of norms) {
                out.push(norm);
                if (maxItems > 0 && out.length >= maxItems) break;
            }
            if (maxItems > 0 && out.length >= maxItems) break;
        }

        await sleep(120);
    }

    const filteredByKw = keywords.length > 0 ? out.filter(p => matchesKeywords(p, keywords)) : out;

    const filteredByRetailer = retailers.length > 0
        ? filteredByKw.filter(p => retailers.includes(p.retailer))
        : filteredByKw;

    log.info(`Árfigyelő: ${filteredByRetailer.length} products after filtering`);
    return filteredByRetailer.slice(0, maxItems || 999999);
}

async function fetchJson(url) {
    try {
        const r = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ApifyBot/1.0; +https://apify.com/bots)',
                'Accept': 'application/json',
                'Accept-Language': 'hu-HU,hu;q=0.9',
                'Referer': BASE_URL,
                'Origin': BASE_URL,
            },
        });
        if (!r.ok) {
            log.debug(`HTTP ${r.status} for ${url}`);
            return null;
        }
        return await r.json();
    } catch (e) {
        log.debug(`Fetch failed for ${url}: ${e?.message || String(e)}`);
        return null;
    }
}

function flattenCategories(catsRaw) {
    // API returns a 3-level tree, but products endpoint uses the middle level ids (e.g. 2010, 2046...)
    // We treat depth=1 nodes (children of the top categories) as queryable categories.
    const roots = Array.isArray(catsRaw) ? catsRaw : (catsRaw?.categories ?? []);
    const out = [];

    const walk = (node, depth) => {
        if (!node || typeof node !== 'object') return;
        const kids = Array.isArray(node.categoryNodes) ? node.categoryNodes : [];

        if (depth === 1 && node.id) {
            out.push({ id: node.id, name: node.name ?? null, path: node.path ?? null });
        }

        for (const k of kids) walk(k, depth + 1);
    };

    for (const r of roots) walk(r, 0);
    return out;
}

function toSlug(s) {
    return removeDiacritics(String(s).toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ─── Normalization ────────────────────────────────────────────────────────────

const RETAILER_MAP = {
    auchan: 'Auchan',
    tesco: 'Tesco',
    lidl: 'Lidl',
    aldi: 'Aldi',
    spar: 'Spar',
    penny: 'Penny',
    'cba': 'CBA',
};

function normalizeProductsFromRow(raw, categoryHint = null) {
    if (!raw || typeof raw !== 'object') return [];

    const name = raw.name ?? raw.productName ?? raw.termekNev ?? raw.nev ?? raw.title ?? null;
    if (!name || String(name).length < 2) return [];

    const productId = raw.id ?? raw.productId ?? null;
    const unit = raw.unitTitle ?? raw.unit ?? raw.egyseg ?? null;
    const category = raw.category ?? raw.categoryName ?? raw.kategoria ?? categoryHint ?? null;

    // Árfigyelő payload contains per-retailer prices under pricesOfChainStores.
    const chains = Array.isArray(raw.pricesOfChainStores) ? raw.pricesOfChainStores : [];
    if (chains.length === 0) return [];

    const out = [];
    for (const chain of chains) {
        const retailerLabel = chain?.name ?? null;
        const retailerKey = retailerLabel ? String(retailerLabel).toLowerCase() : null;

        const prices = Array.isArray(chain?.prices) ? chain.prices : [];
        if (prices.length === 0) continue;

        const normal = prices.find(p => String(p.type).toUpperCase() === 'NORMAL') ?? prices[0];
        const loyalty = prices.find(p => String(p.type).toUpperCase() !== 'NORMAL') ?? null;

        const priceCurrent = parsePrice(normal?.amount);
        const priceUnit = parsePrice(normal?.unitAmount);
        const priceLoyalty = parsePrice(loyalty?.amount);

        out.push({
            id: generateId(name, retailerKey, productId),
            product_id: productId,
            name: String(name).trim(),
            retailer: retailerKey,
            retailer_label: retailerLabel,
            category,
            price_current: priceCurrent,
            price_previous: null, // computed via KV-store deltas
            price_loyalty: priceLoyalty,
            price_unit: priceUnit,
            unit,
            price_drop_pct: null, // computed via KV-store deltas
            ean: raw.ean ?? raw.barcode ?? productId,
            url: `${BASE_URL}/termek/${productId ?? ''}`,
            scraped_at: new Date().toISOString(),
        });
    }

    return out;
}

function parsePrice(val) {
    if (val == null) return null;
    if (typeof val === 'number') return val;
    const cleaned = String(val).replace(/[^\d.]/g, '');
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
}

function generateId(name, retailer, productId) {
    const raw = `arfigyelo-${productId ?? name}-${retailer ?? ''}`;
    return Buffer.from(raw).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
}

function matchesKeywords(product, keywords) {
    const text = removeDiacritics(`${product.name} ${product.category ?? ''}`.toLowerCase());
    return keywords.some(kw => text.includes(removeDiacritics(kw.toLowerCase())));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
