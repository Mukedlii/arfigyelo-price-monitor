export function removeDiacritics(str) {
    return String(str ?? '')
        .replace(/[áÁ]/g, 'a').replace(/[éÉ]/g, 'e')
        .replace(/[íÍ]/g, 'i').replace(/[óÓőŐ]/g, 'o')
        .replace(/[úÚűŰ]/g, 'u').replace(/[öÖ]/g, 'o');
}

export function normalizeText(str) {
    return String(str ?? '').replace(/\s+/g, ' ').trim();
}
