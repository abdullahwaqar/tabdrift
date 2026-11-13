/**
 * Search providers: "yt lofi" searches YouTube, "wiki esp32" searches Wikipedia.
 * A bonus on top of tab search, so a provider only answers when you type its key,
 * a space and a query at the start. Pure: no browser APIs.
 */
import { SEARCH_ENGINES } from "./search";

export interface SearchProvider {
    /** Stable id. Built-ins use a name ("youtube"), your own ones "custom-..." */
    id: string;
    name: string;
    /** Type one of these, a space, then the query. Lower case, no spaces. */
    keys: string[];
    /** Search address with {q} (or %s, as in browser keyword searches) where the query goes. */
    url: string;
}

export const BUILTIN_PROVIDERS: SearchProvider[] = [
    { id: "youtube", name: "YouTube", keys: ["yt"], url: "https://www.youtube.com/results?search_query={q}" },
    { id: "youtube-music", name: "YouTube Music", keys: ["ytm"], url: "https://music.youtube.com/search?q={q}" },
    // index.php?search= jumps straight to the article when the title matches exactly.
    { id: "wikipedia", name: "Wikipedia", keys: ["wiki"], url: "https://en.wikipedia.org/w/index.php?search={q}" },
    { id: "github", name: "GitHub", keys: ["gh"], url: "https://github.com/search?q={q}" },
    { id: "mdn", name: "MDN", keys: ["mdn"], url: "https://developer.mozilla.org/en-US/search?q={q}" },
    { id: "npm", name: "npm", keys: ["npm"], url: "https://www.npmjs.com/search?q={q}" },
    { id: "maps", name: "Google Maps", keys: ["maps"], url: "https://www.google.com/maps/search/{q}" },
];

/** The engine keys (g, b, d, n) keep working exactly as before, so providers can't take them. */
const RESERVED_KEYS = new Set(SEARCH_ENGINES.map((e) => e.key));

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,15}$/;
const PLACEHOLDER_RE = /\{q\}|%s/g;

export type KeyProblem = "empty" | "format" | "reserved";

/** Why a key can't be used, or null when it's fine. Scope symbols (% * ^ >) and "!" fail the format check. */
export function keyProblem(key: string): KeyProblem | null {
    const k = key.trim().toLowerCase();
    if (!k) {
        return "empty";
    }
    if (!KEY_RE.test(k)) {
        return "format";
    }
    if (RESERVED_KEYS.has(k)) {
        return "reserved";
    }
    return null;
}

/** True when the address is http(s) and has a {q} or %s for the query. */
export function isValidTemplate(url: string): boolean {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed) || !trimmed.match(PLACEHOLDER_RE)) {
        return false;
    }
    try {
        new URL(trimmed.replace(PLACEHOLDER_RE, "x"));
        return true;
    } catch {
        return false;
    }
}

export function providerUrl(provider: SearchProvider, query: string): string {
    const encoded = encodeURIComponent(query);
    return provider.url.trim().replace(PLACEHOLDER_RE, () => encoded);
}

/**
 * Your own providers first, so they win a key clash with a built-in one.
 * Entries with no usable key or address are dropped rather than breaking search.
 */
export function activeProviders(custom: SearchProvider[], builtinsOn: boolean): SearchProvider[] {
    const list = [...custom, ...(builtinsOn ? BUILTIN_PROVIDERS : [])];
    return list
        .map((p) => ({ ...p, keys: p.keys.map((k) => k.trim().toLowerCase()).filter((k) => keyProblem(k) === null) }))
        .filter((p) => p.keys.length > 0 && isValidTemplate(p.url));
}

export interface ProviderSearch {
    provider: SearchProvider;
    /** The key you typed, for the row's badge. */
    key: string;
    query: string;
    url: string;
}

/** "yt lofi beats" gives YouTube and "lofi beats". A key on its own, or a key at the end, gives null. */
export function parseProviderKey(text: string, providers: SearchProvider[]): ProviderSearch | null {
    const match = text.trim().match(/^(\S+)\s+([\s\S]+)$/);
    if (!match) {
        return null;
    }
    const key = (match[1] ?? "").toLowerCase();
    const query = (match[2] ?? "").trim();
    const provider = providers.find((p) => p.keys.includes(key));
    if (!provider || !query) {
        return null;
    }
    return { provider, key, query, url: providerUrl(provider, query) };
}
