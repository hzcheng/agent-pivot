import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const AI_SESSION_RUNNING_CARD_ANIMATIONS = new Set([
    'current',
    'sweep',
    'orbit',
    'halo',
    'ripple',
    'breath',
    'custom',
    'none',
]);

const AI_SESSION_RUNNING_ICON_ANIMATIONS = new Set([
    'current',
    'halo',
    'custom',
    'none',
]);

export function normalizeRunningCardAnimation(value: string | undefined): string {
    return value && AI_SESSION_RUNNING_CARD_ANIMATIONS.has(value) ? value : 'current';
}

export function normalizeRunningIconAnimation(value: string | undefined): string {
    return value && AI_SESSION_RUNNING_ICON_ANIMATIONS.has(value) ? value : 'current';
}

export interface RunningAnimationImages {
    card?: string;
    icon?: string;
}

interface RunningAnimationConfig {
    get<T>(key: string, fallback: T): T;
}

export const MAX_RUNNING_IMAGE_BYTES = 256 * 1024;

const RUNNING_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
};

const MAX_CACHE_ENTRIES = 8;
const imageCache = new Map<string, { mtimeMs: number; size: number; dataUri?: string }>();

export function clearRunningAnimationImageCache(): void {
    imageCache.clear();
}

export function resolveRunningAnimationImage(configuredPath: string | undefined): string | undefined {
    const trimmed = (configuredPath || '').trim();
    if (!trimmed) {
        return undefined;
    }
    const expanded = trimmed === '~'
        ? os.homedir()
        : trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith('~/')
            ? path.join(os.homedir(), trimmed.slice(2))
            : trimmed;
    let stat: fs.Stats;
    try {
        stat = fs.statSync(expanded);
    } catch (_error) {
        return undefined;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RUNNING_IMAGE_BYTES) {
        return undefined;
    }
    const mime = RUNNING_IMAGE_MIME_BY_EXTENSION[path.extname(expanded).toLowerCase()];
    if (!mime) {
        return undefined;
    }
    const cached = imageCache.get(expanded);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.dataUri;
    }
    let dataUri: string;
    try {
        dataUri = `data:${mime};base64,${fs.readFileSync(expanded).toString('base64')}`;
    } catch (_error) {
        return undefined;
    }
    if (imageCache.size >= MAX_CACHE_ENTRIES && !imageCache.has(expanded)) {
        const oldest = imageCache.keys().next();
        if (!oldest.done) {
            imageCache.delete(oldest.value);
        }
    }
    imageCache.set(expanded, { mtimeMs: stat.mtimeMs, size: stat.size, dataUri });
    return dataUri;
}

export function readRunningAnimationImages(config: RunningAnimationConfig): RunningAnimationImages {
    return {
        card: resolveRunningAnimationImage(config.get<string>('aiSessionRunningCardCustomImage', '')),
        icon: resolveRunningAnimationImage(config.get<string>('aiSessionRunningIconCustomImage', '')),
    };
}

export function getEffectiveRunningCardAnimation(config: RunningAnimationConfig): string {
    const normalized = normalizeRunningCardAnimation(
        config.get<string>('aiSessionRunningCardAnimation', 'current')
    );
    return normalized === 'custom'
        && !resolveRunningAnimationImage(config.get<string>('aiSessionRunningCardCustomImage', ''))
        ? 'current'
        : normalized;
}

export function getEffectiveRunningIconAnimation(config: RunningAnimationConfig): string {
    const normalized = normalizeRunningIconAnimation(
        config.get<string>('aiSessionRunningIconAnimation', 'current')
    );
    return normalized === 'custom'
        && !resolveRunningAnimationImage(config.get<string>('aiSessionRunningIconCustomImage', ''))
        ? 'current'
        : normalized;
}
