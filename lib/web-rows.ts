/**
 * Decides which "Web" rows the overlay shows for a query (searches and addresses),
 * and whether they go above your tabs. Pure, so it can be tested without a page.
 */
import type { SearchProvider } from "./providers";
import { parseProviderKey } from "./providers";
import { engineById, parseAddress, parseEngineKey } from "./search";

/** A web search or an address to open, so the overlay can stand in for the address bar. */
export interface WebRow {
    id: "search-keyed" | "search" | "go" | "provider";
    /** What the row shows: the search terms or the address. */
    title: string;
    sub: string;
    badge: string;
    url: string;
}

/** What else the overlay found for the same query. */
export interface WebRowContext {
    engineId: string | undefined;
    hasTabs: boolean;
    hasUtilities: boolean;
    hasMarks: boolean;
    /** Search providers that are switched on. Empty when they're off. */
    providers?: SearchProvider[];
}

export interface WebPlan {
    rows: WebRow[];
    /** True when the rows go above everything else, so Enter runs the first one. */
    first: boolean;
}

/**
 * Search and "go to" rows. They jump to the top when the intent is clear:
 * an engine key ("g ..." or "... g"), a full link, or nothing else matched.
 *
 * A provider key ("yt lofi") never pushes your tabs down: its row goes on top
 * only when no tab, mark or utility matched the text.
 */
export function planWebRows(q: string, ctx: WebRowContext): WebPlan {
    const engine = engineById(ctx.engineId);
    const plain: WebRow = {
        id: "search",
        title: q,
        sub: `Search with ${engine.name}`,
        badge: engine.key,
        url: engine.searchUrl(q),
    };

    const keyed = parseEngineKey(q);
    if (keyed) {
        // "vitamin d" might not mean DuckDuckGo, so the full text stays one arrow away.
        return {
            rows: [
                {
                    id: "search-keyed",
                    title: keyed.query,
                    sub: `Search with ${keyed.engine.name}`,
                    badge: keyed.engine.key,
                    url: keyed.engine.searchUrl(keyed.query),
                },
                plain,
            ],
            first: true,
        };
    }

    const provided = ctx.providers?.length ? parseProviderKey(q, ctx.providers) : null;
    if (provided) {
        return {
            rows: [
                {
                    id: "provider",
                    title: provided.query,
                    sub: `Search ${provided.provider.name}`,
                    badge: provided.key,
                    url: provided.url,
                },
                plain,
            ],
            first: !ctx.hasTabs && !ctx.hasUtilities && !ctx.hasMarks,
        };
    }

    const address = parseAddress(q);
    if (address) {
        const go: WebRow = { id: "go", title: address.url, sub: "Open in a new tab", badge: "go", url: address.url };
        return {
            rows: address.explicit ? [go] : [go, plain],
            first: address.explicit || (!ctx.hasTabs && !ctx.hasUtilities),
        };
    }

    return { rows: [plain], first: !ctx.hasTabs && !ctx.hasUtilities && !ctx.hasMarks };
}
