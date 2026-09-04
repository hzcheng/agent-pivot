'use strict';

// Plain CSS colors only: hex, named colors, numeric rgb()/hsl() functions, or
// a var() reference to another custom property. Anything else (url(), quotes,
// semicolons, markup) is dropped so the value stays a single safe token.
const CSS_COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,32}|rgba?\([\d.,%\s/]+\)|hsla?\([\d.,%\s/]+\)|var\(\s*--[a-zA-Z0-9_-]+(\s*,\s*[a-zA-Z0-9#()%.,\s-]+)?\s*\))$/;

export function sanitizeCssColor(value: string | undefined | null): string {
    const color = (value || '').trim();
    if (!color || color.length > 96) {
        return '';
    }
    return CSS_COLOR_PATTERN.test(color) ? color : '';
}
