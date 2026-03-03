/**
 * Scraper: arfigyelo.gvh.hu
 *
 * Strategy:
 *   The site is a React SPA. It calls internal REST API endpoints like:
 *     GET /api/products?categoryId=...&page=...
 *     GET /api/categories
 *     GET /api/prices?productId=...
 *
 *   Approach A (preferred, fast): intercept XHR/fetch calls with Playwright
 *     → capture the JSON responses directly, no HTML parsing needed
 *
 *   Approach B (fallback): parse rendered DOM after JS execution
 *
 *   Both approaches are implemented below with automatic fallback.
 */

import { PlaywrightCrawler, log } from 'crawlee';
import { removeDiacritics } from '../utils/helpers.js';

const BASE_URL = 'https://arfigyelo.gvh.hu';

// Known internal API base paths to try (discovered via browser DevTools pattern)
const API_CANDIDATES = [
    '/api',
    '/api/v1',
    '/api/v2',
    '/backend/api',
];

export async function scrapeArfigyelo({ categories = [], keywords = [], retailers = [], maxItems = 500 }) {
    const results = [];
    let apiBase = null;
    let categoriesData = [];

    log.info('Starting Árfigyelő scrape via API interception...');

    // Phase 1: Discover API base and fetch categories
    const interceptedRequests = [];

    const discoveryCrawler = new PlaywrightCrawler({
        maxRequestsPerCrawl: 3,
        requestHandlerTimeoutSecs: 30,
        launchContext: {
            launchOptions: {
                headless: true,
            },
        },
        async requestHandler({ page, request }) {
            // Intercept all API responses
            page.on('response', async (response) => {
                const url = response.url();
                if (url.includes('/api/') && response.headers()['content-type']?.includes('json')) {
                    try {
                        const json = await response.json();
                        interceptedRequests.push({ url, json });
                        log.debug(`Intercepted API call: ${url}`);
                    } catch { /* ignore */ }
                }
            });

            // Navigate to main page — this triggers category/product API calls
            await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });

            // Also navigate to a category page to trigger product API calls
            await page.waitForTimeout(2000);

            // Try clicking first category link
            try {
                const categoryLinks = await page.$$('a[href*="kategoria"], a[href*="category"], a[href*="termek"]');
                if (categoryLinks.length > 0) {
                    await categoryLinks[0].click();
                    await page.waitForTimeout(2000);
                }
            } catch { /* ignore */ }
        },
    });

    try {
        await discoveryCrawler.run([BASE_URL]);
    } catch (err) {
        log.warning('Discovery crawler error (non-fatal)', { error: err.message });
    }

    // Analyze intercepted requests to find API base and categories
    for (const { url, json } of interceptedRequests) {
        log.info(`Found API response: ${url}`);

        // Detect categories endpoint
        if ((url.includes('categor') || url.includes('kategori')) && Array.isArray(json)) {
            categoriesData = json;
            // Extract API base from the URL
            const match = url.match(/^(https?:\/\/[^\/]+)(\/[^?]*\/)/);
            if (match) apiBase = match[1] + match[2].split('/').slice(0, -1).join('/');
        } else if (json?.categories && Array.isArray(json.categories)) {
            categoriesData = json.categories;
        }

        // Detect products endpoint
        if ((url.includes('product') || url.includes('termek')) && (Array.isArray(json) || json?.products)) {
            const products = Array.isArray(json) ? json : json.products ?? [];
            for (const product of products) {
                const normalized = normalizeProduct(product);
                if (normalized) results.push(normalized);
            }
        }
    }

    log.info(`Interception phase: ${results.length} products captured, ${categoriesData.length} categories found`);

    // Phase 2: If we found API endpoints, directly call them for each category
    if (categoriesData.length > 0 || apiBase) {
        const fetchedProducts = await fetchViaDirectAPI(apiBase, categoriesData, categories, retailers, maxItems - results.length);
        results.push(...fetchedProducts);
    }

    // Phase 3: If still nothing, fallback to DOM parsing
    if (results.length === 0) {
        log.info('Falling back to DOM-based scraping...');
        const domProducts = await scrapeDOMFallback(categories, keywords, maxItems);
        results.push(...domProducts);
    }

    // Apply keyword filter
    const filtered = keywords.length > 0
        ? results.filter(p => matchesKeywords(p, keywords))
        : results;

    // Apply retailer filter
    const retailerFiltered = retailers.length > 0
        ? filtered.filter(p => retailers.some(r => p.retailer?.toLowerCase().includes(r)))
        : filtered;

    log.info(`Árfigyelő: ${retailerFiltered.length} products after filtering`);
    return retailerFiltered.slice(0, maxItems || 999999);
}

async function fetchViaDirectAPI(apiBase, categoriesData, categoryFilter, retailers, maxItems) {
    const results = [];
    const fetch = (await import('node-fetch')).default;

    const headers = {
        'User-Agent': 'Mozilla/5.0 (compatible; ApifyBot/1.0; +https://apify.com/bots)',
        'Accept': 'application/json',
        'Accept-Language': 'hu-HU,hu;q=0.9',
        'Referer': BASE_URL,
        'Origin': BASE_URL,
    };

    // Build category list to fetch
    const categoriesToFetch = categoryFilter.length > 0
        ? categoriesData.filter(c =>
            categoryFilter.some(slug =>
                c.slug?.includes(slug) || c.name?.toLowerCase().includes(slug) || String(c.id) === slug
            ))
        : categoriesData;

    // If no categories discovered yet, try known API patterns
    const apiBasesToTry = apiBase ? [apiBase] : API_CANDIDATES.map(p => `${BASE_URL}${p}`);

    for (const base of apiBasesToTry) {
        if (results.length >= maxItems && maxItems > 0) break;

        // Try fetching categories from this base
        for (const catEndpoint of ['categories', 'kategoriák', 'category-list']) {
            try {
                const r = await fetch(`${base}/${catEndpoint}`, { headers, timeout: 10000 });
                if (r.ok) {
                    const data = await r.json();
                    const cats = Array.isArray(data) ? data : data.categories ?? data.data ?? [];
                    if (cats.length > 0) {
                        categoriesToFetch.push(...cats);
                        log.info(`Found ${cats.length} categories at ${base}/${catEndpoint}`);
                    }
                }
            } catch { /* try next */ }
        }

        // Try fetching products
        if (categoriesToFetch.length > 0) {
            for (const cat of categoriesToFetch) {
                if (results.length >= maxItems && maxItems > 0) break;
                const catId = cat.id ?? cat.categoryId ?? cat.slug;

                for (const productEndpoint of ['products', 'termekek', 'items']) {
                    try {
                        let page = 1;
                        while (true) {
                            const url = `${base}/${productEndpoint}?categoryId=${catId}&page=${page}&pageSize=50`;
                            const r = await fetch(url, { headers, timeout: 10000 });
                            if (!r.ok) break;

                            const data = await r.json();
                            const products = Array.isArray(data) ? data
                                : data.products ?? data.items ?? data.data ?? [];

                            if (products.length === 0) break;

                            for (const p of products) {
                                const norm = normalizeProduct(p, cat.name ?? cat.slug);
                                if (norm) results.push(norm);
                            }

                            if (!data.hasMore && !data.nextPage) break;
                            page++;
                            if (page > 20) break; // safety cap
                        }
                        if (results.length > 0) break; // found working endpoint
                    } catch { /* try next */ }
                }

                await sleep(200);
            }
        }

        // Also try a flat /products endpoint without category filter
        if (results.length === 0) {
            for (const endpoint of ['products', 'termekek', 'prices', 'arak']) {
                try {
                    const r = await fetch(`${base}/${endpoint}`, { headers, timeout: 10000 });
                    if (r.ok) {
                        const data = await r.json();
                        const items = Array.isArray(data) ? data : data.products ?? data.items ?? [];
                        for (const p of items) {
                            const norm = normalizeProduct(p);
                            if (norm) results.push(norm);
                        }
                        if (results.length > 0) {
                            log.info(`Found ${results.length} products at ${base}/${endpoint}`);
                            break;
                        }
                    }
                } catch { /* try next */ }
            }
        }

        if (results.length > 0) break;
    }

    return results;
}

async function scrapeDOMFallback(categories, keywords, maxItems) {
    const results = [];
    const { PlaywrightCrawler } = await import('crawlee');

    const pagesToVisit = categories.length > 0
        ? categories.map(c => `${BASE_URL}/kategoria/${c}`)
        : [BASE_URL];

    const crawler = new PlaywrightCrawler({
        maxRequestsPerCrawl: Math.min(pagesToVisit.length + 2, 10),
        requestHandlerTimeoutSecs: 45,
        launchContext: { launchOptions: { headless: true } },
        async requestHandler({ page }) {
            await page.waitForTimeout(3000); // wait for React to render

            // Try multiple selector patterns for product cards
            const selectors = [
                '[class*="product"]',
                '[class*="termek"]',
                '[class*="item"]',
                '[data-product]',
                'article',
            ];

            for (const sel of selectors) {
                const cards = await page.$$(sel);
                if (cards.length < 3) continue;

                log.info(`DOM fallback: found ${cards.length} cards with selector "${sel}"`);

                for (const card of cards.slice(0, maxItems || 500)) {
                    try {
                        const text = await card.innerText();
                        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

                        // Heuristic: first line = name, look for price pattern
                        const name = lines[0] ?? '';
                        const priceMatch = text.match(/(\d[\d\s]*)\s*(?:Ft|HUF|forint)/i);
                        const price = priceMatch ? parseInt(priceMatch[1].replace(/\s/g, ''), 10) : null;

                        if (!name || name.length < 3) continue;

                        results.push({
                            id: generateId(name, null, null),
                            name,
                            retailer: null,
                            retailer_label: null,
                            category: null,
                            price_current: price,
                            price_previous: null,
                            price_loyalty: null,
                            price_unit: null,
                            unit: null,
                            price_drop_pct: null,
                            url: BASE_URL,
                            scraped_at: new Date().toISOString(),
                        });
                    } catch { /* skip card */ }
                }

                if (results.length > 0) break;
            }
        },
    });

    try {
        await crawler.run(pagesToVisit);
    } catch (err) {
        log.warning('DOM fallback crawler error', { error: err.message });
    }

    return results;
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

function normalizeProduct(raw, categoryHint = null) {
    if (!raw || typeof raw !== 'object') return null;

    // Try to extract name from various possible field names
    const name = raw.name ?? raw.productName ?? raw.termekNev ?? raw.nev ?? raw.title ?? null;
    if (!name || String(name).length < 2) return null;

    const priceCurrent  = parsePrice(raw.price ?? raw.currentPrice ?? raw.dailyPrice ?? raw.napi_ar ?? raw.ar);
    const pricePrevious = parsePrice(raw.previousPrice ?? raw.prevPrice ?? raw.korabbiAr ?? raw.regi_ar);
    const priceLoyalty  = parsePrice(raw.loyaltyPrice ?? raw.clubPrice ?? raw.torzsvasarloi_ar);

    const retailerRaw = raw.retailer ?? raw.chain ?? raw.kereskedő ?? raw.bolt ?? raw.store ?? null;
    const retailerKey = String(retailerRaw ?? '').toLowerCase();
    const retailerLabel = RETAILER_MAP[retailerKey] ?? retailerRaw ?? null;

    const priceDrop = priceCurrent && pricePrevious && pricePrevious > priceCurrent
        ? Math.round(((pricePrevious - priceCurrent) / pricePrevious) * 100)
        : null;

    return {
        id: generateId(name, retailerKey, raw.id ?? raw.productId),
        product_id: raw.id ?? raw.productId ?? null,
        name: String(name).trim(),
        retailer: retailerKey || null,
        retailer_label: retailerLabel,
        category: raw.category ?? raw.categoryName ?? raw.kategoria ?? categoryHint ?? null,
        price_current: priceCurrent,
        price_previous: pricePrevious,
        price_loyalty: priceLoyalty,
        price_unit: raw.unitPrice ?? raw.egysegar ?? null,
        unit: raw.unit ?? raw.egyseg ?? null,
        price_drop_pct: priceDrop,
        ean: raw.ean ?? raw.barcode ?? null,
        url: raw.url ?? raw.link ?? `${BASE_URL}/termek/${raw.id ?? ''}`,
        scraped_at: new Date().toISOString(),
    };
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
