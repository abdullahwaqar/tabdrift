/**
 * Web search and "go to address" helpers for the overlay, so it can stand in
 * for the address bar. Pure: no browser APIs.
 */
import { parseUrlInput } from "./utils";

export type SearchEngineId = "google" | "bing" | "duckduckgo";

export interface SearchEngine {
    id: SearchEngineId;
    name: string;
    /** Type this before or after a query to search with this engine, e.g. "g cats" or "cats g". */
    key: string;
    searchUrl: (query: string) => string;
}

export const SEARCH_ENGINES: SearchEngine[] = [
    { id: "google", name: "Google", key: "g", searchUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
    { id: "bing", name: "Bing", key: "b", searchUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
    { id: "duckduckgo", name: "DuckDuckGo", key: "d", searchUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
];

export const DEFAULT_ENGINE_ID: SearchEngineId = "google";

export function engineById(id: string | undefined): SearchEngine {
    return SEARCH_ENGINES.find((e) => e.id === id) ?? (SEARCH_ENGINES.find((e) => e.id === DEFAULT_ENGINE_ID) as SearchEngine);
}

function engineByKey(key: string): SearchEngine | undefined {
    const lower = key.toLowerCase();
    return SEARCH_ENGINES.find((e) => e.key === lower);
}

export interface KeyedSearch {
    engine: SearchEngine;
    query: string;
}

/**
 * Picks an engine from a one-letter key at the start or end of the text:
 * "g esp32 pinout" and "esp32 pinout g" both mean Google. A key at the start
 * wins over one at the end ("g plan b" searches Google for "plan b").
 * Returns null when there is no key, or when the key is all there is.
 */
export function parseEngineKey(text: string): KeyedSearch | null {
    const trimmed = text.trim();

    const prefix = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
    if (prefix) {
        const engine = engineByKey(prefix[1] ?? "");
        if (engine) {
            return { engine, query: (prefix[2] ?? "").trim() };
        }
    }

    const suffix = trimmed.match(/^([\s\S]+?)\s+(\S+)$/);
    if (suffix) {
        const engine = engineByKey(suffix[2] ?? "");
        if (engine) {
            return { engine, query: (suffix[1] ?? "").trim() };
        }
    }
    return null;
}

// Endings that are far more often file names than websites people type ("README.md", "main.ts").
const FILE_EXTENSIONS = new Set([
    "md",
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "json",
    "html",
    "htm",
    "css",
    "scss",
    "txt",
    "log",
    "pdf",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "svg",
    "webp",
    "yml",
    "yaml",
    "toml",
    "lock",
    "csv",
    "xlsx",
    "docx",
    "pptx",
    "zip",
    "tar",
    "gz",
    "exe",
    "dll",
    "py",
    "rb",
    "cpp",
    "hpp",
    "java",
    "kt",
    "swift",
]);

const BARE_HOST_RE = /^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24}))\.?(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const LOCAL_RE = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#]\S*)?$/i;

export interface Address {
    url: string;
    /** Typed with http(s):// or www., so it's clearly meant as an address. */
    explicit: boolean;
}

/**
 * Text that looks like something you'd type in the address bar: a full link,
 * "github.com/user/repo", "localhost:5173" or "192.168.1.1". Returns null for
 * anything with spaces, and for bare file names like "README.md".
 */
export function parseAddress(text: string): Address | null {
    const trimmed = text.trim();
    if (!trimmed || /\s/.test(trimmed) || trimmed.includes("@")) {
        return null;
    }

    const full = parseUrlInput(trimmed);
    if (full) {
        return { url: full.href, explicit: true };
    }

    if (LOCAL_RE.test(trimmed)) {
        return toAddress(`http://${trimmed}`);
    }

    const match = trimmed.match(BARE_HOST_RE);
    if (!match) {
        return null;
    }
    const tld = (match[2] ?? "").toLowerCase();
    const hasMore = trimmed.length > (match[1] ?? "").length;
    if (FILE_EXTENSIONS.has(tld) && !hasMore) {
        return null;
    }
    return toAddress(`https://${trimmed}`);
}

function toAddress(candidate: string): Address | null {
    try {
        return { url: new URL(candidate).href, explicit: false };
    } catch {
        return null;
    }
}
