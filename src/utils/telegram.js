/**
 * Telegram alert utility
 * Sends formatted price alert messages via Telegram Bot API.
 */

import fetch from 'node-fetch';
import { log } from 'apify';

const TELEGRAM_API = 'https://api.telegram.org/bot';

/**
 * Send ONE summary message to Telegram.
 * Store-friendly: avoid spamming chats with many messages.
 */
export async function sendTelegramAlerts({ botToken, chatId, alerts, runUrl = null }) {
    if (!botToken || !chatId || alerts.length === 0) return;

    // Group by alert type for cleaner messages
    const drops    = alerts.filter(a => a.alert_type === 'price_drop');
    const below    = alerts.filter(a => a.alert_type === 'price_below');
    const newProds = alerts.filter(a => a.alert_type === 'new_product');

    const sections = [];

    if (drops.length > 0) {
        sections.push(`📉 *Áresések (${drops.length} termék):*\n` + drops.slice(0, 15).map(formatDropAlert).join('\n'));
    }
    if (below.length > 0) {
        sections.push(`🎯 *Célár alatt (${below.length} termék):*\n` + below.slice(0, 15).map(formatBelowAlert).join('\n'));
    }
    if (newProds.length > 0) {
        sections.push(`🆕 *Új termékek (${newProds.length} db):*\n` + newProds.slice(0, 10).map(formatNewAlert).join('\n'));
    }

    if (sections.length === 0) return;

    const header = `🇭🇺 *Árfigyelő értesítő*\n${new Date().toLocaleDateString('hu-HU')}\n\n`;
    const footer = runUrl ? `\n\n[📊 Teljes adatset](${runUrl})` : '';
    const body   = sections.join('\n\n');

    // Telegram max 4096 chars. We hard-trim to keep it single message.
    const msg = (header + body + footer).slice(0, 3950) + ((header + body + footer).length > 3950 ? "\n\n…(túl hosszú, vágva)" : "");

    const ok = await sendMessage(botToken, chatId, msg);
    if (ok) log.info(`Telegram: 1 summary message sent to chat ${chatId}`);
}


function formatDropAlert(alert) {
    const drop = alert.price_drop_pct ? ` (-${alert.price_drop_pct}%)` : '';
    const prev = alert.price_previous ? ` ~~${alert.price_previous} Ft~~` : '';
    return `• *${escapeMarkdown(alert.name)}* @ ${alert.retailer_label ?? alert.retailer}\n  ${alert.price_current} Ft${prev}${drop}`;
}

function formatBelowAlert(alert) {
    return `• *${escapeMarkdown(alert.name)}* @ ${alert.retailer_label ?? alert.retailer}\n  ${alert.price_current} Ft (célár: ${alert.alert_threshold} Ft)`;
}

function formatNewAlert(alert) {
    return `• *${escapeMarkdown(alert.name)}* @ ${alert.retailer_label ?? alert.retailer} — ${alert.price_current ?? '?'} Ft`;
}

async function sendMessage(botToken, chatId, text) {
    try {
        const url = `${TELEGRAM_API}${botToken}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id:    chatId,
                text,
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            }),
            timeout: 10000,
        });

        if (!res.ok) {
            const err = await res.text();
            log.warning('Telegram send failed', { status: res.status, body: err });
            return false;
        }
        return true;
    } catch (err) {
        log.warning('Telegram request error', { error: err.message });
        return false;
    }
}

function splitMessage(text, maxLen) {
    const chunks = [];
    let current = '';
    for (const line of text.split('\n')) {
        if ((current + '\n' + line).length > maxLen) {
            if (current) chunks.push(current.trim());
            current = line;
        } else {
            current += (current ? '\n' : '') + line;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

function escapeMarkdown(text) {
    return String(text ?? '').replace(/[_*[\]()~`>#+=|{}.!-]/g, c => `\\${c}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
