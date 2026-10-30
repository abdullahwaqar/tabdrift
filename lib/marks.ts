/**
 * Marks: Tabdrift's own bookmarks, kept in extension storage. No bookmarks
 * permission, nothing shared with Firefox's bookmark menus, and fast to toggle
 * from the overlay (Ctrl+B) or from any page (Alt+Shift+B).
 */
import { duplicateKey } from "./utils";

export interface Mark {
    /** duplicateKey() of the address, so tracking junk and #fragments don't create a second mark. */
    key: string;
    url: string;
    title: string;
    favIconUrl?: string;
    createdAt: number;
    /** Last time it was opened from Tabdrift. */
    lastOpened?: number;
    openCount: number;
}

const STORAGE_KEY = "local:marks";
/** Favicons can be large data: URLs. Past this they're dropped rather than bloating storage. */
const MAX_FAVICON_CHARS = 8_000;
const MAX_MARKS = 5_000;

export function markKey(url: string): string {
    return duplicateKey(url);
}

/** Only real pages can be marked. */
export function canMark(url: string | undefined): url is string {
    return !!url && /^(https?|file|ftp):/i.test(url);
}

export async function getMarks(): Promise<Mark[]> {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    const list = stored[STORAGE_KEY];
    return Array.isArray(list) ? (list as Mark[]).filter((m) => m && typeof m.url === "string" && typeof m.key === "string") : [];
}

async function save(marks: Mark[]): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEY]: marks.slice(0, MAX_MARKS) });
}

export function onMarksChanged(callback: (marks: Mark[]) => void) {
    browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[STORAGE_KEY]) {
            const next = changes[STORAGE_KEY].newValue;
            callback(Array.isArray(next) ? (next as Mark[]) : []);
        }
    });
}

function makeMark(page: { url: string; title?: string; favIconUrl?: string }): Mark {
    const fav = page.favIconUrl && page.favIconUrl.length <= MAX_FAVICON_CHARS ? page.favIconUrl : undefined;
    return { key: markKey(page.url), url: page.url, title: page.title?.trim() || page.url, favIconUrl: fav, createdAt: Date.now(), openCount: 0 };
}

/** Marks the page, or unmarks it if it's already marked. Returns true when it ends up marked. */
export async function toggleMark(page: { url: string; title?: string; favIconUrl?: string }): Promise<boolean> {
    const marks = await getMarks();
    const key = markKey(page.url);
    const at = marks.findIndex((m) => m.key === key);
    if (at !== -1) {
        marks.splice(at, 1);
        await save(marks);
        return false;
    }
    await save([makeMark(page), ...marks]);
    return true;
}

export async function removeMark(key: string): Promise<void> {
    const marks = await getMarks();
    await save(marks.filter((m) => m.key !== key));
}

/** Counts an open, so marks you use often rank higher. */
export async function noteOpened(key: string): Promise<void> {
    const marks = await getMarks();
    const mark = marks.find((m) => m.key === key);
    if (!mark) {
        return;
    }
    mark.openCount = (mark.openCount ?? 0) + 1;
    mark.lastOpened = Date.now();
    await save(marks);
}

/** For the settings page: a plain JSON file you can keep or move to another profile. */
export async function exportMarks(): Promise<string> {
    const marks = await getMarks();
    return JSON.stringify(
        {
            app: "tabdrift",
            kind: "marks",
            version: 1,
            marks: marks.map(({ url, title, createdAt, openCount, lastOpened }) => ({ url, title, createdAt, openCount, lastOpened })),
        },
        null,
        2,
    );
}

/** Adds the marks from an export (or a plain list of {url, title}). Existing marks are kept. Returns how many were new. */
export async function importMarks(json: string): Promise<number> {
    const data = JSON.parse(json) as unknown;
    const list = Array.isArray(data) ? data : Array.isArray((data as { marks?: unknown })?.marks) ? (data as { marks: unknown[] }).marks : null;
    if (!list) {
        throw new Error("That file doesn't look like a Tabdrift marks export");
    }
    const marks = await getMarks();
    const seen = new Set(marks.map((m) => m.key));
    let added = 0;
    for (const raw of list) {
        const entry = raw as Partial<Mark>;
        if (!canMark(entry.url)) {
            continue;
        }
        const mark = makeMark({ url: entry.url, title: entry.title });
        if (seen.has(mark.key)) {
            continue;
        }
        mark.createdAt = typeof entry.createdAt === "number" ? entry.createdAt : mark.createdAt;
        mark.openCount = typeof entry.openCount === "number" ? entry.openCount : 0;
        mark.lastOpened = typeof entry.lastOpened === "number" ? entry.lastOpened : undefined;
        marks.push(mark);
        seen.add(mark.key);
        added++;
    }
    await save(marks);
    return added;
}
