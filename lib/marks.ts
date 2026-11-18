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
export const MAX_MARKS = 5_000;

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

/* -------------------------------------------------------------------------- */
/* Pure edits. Each takes the current list and returns the next one.          */
/* -------------------------------------------------------------------------- */

export type ToggleResult = "marked" | "unmarked" | "full";

export interface ImportResult {
    /** Marks actually saved. */
    added: number;
    /** New marks that didn't fit under the MAX_MARKS cap and were left out. */
    skipped: number;
}

interface Edit<T> {
    /** Null when nothing changed and nothing needs writing. */
    next: Mark[] | null;
    result: T;
}

export function applyToggle(marks: Mark[], page: { url: string; title?: string; favIconUrl?: string }): Edit<ToggleResult> {
    const key = markKey(page.url);
    if (marks.some((m) => m.key === key)) {
        return { next: marks.filter((m) => m.key !== key), result: "unmarked" };
    }
    if (marks.length >= MAX_MARKS) {
        // Adding would push the oldest mark off the end without telling anyone.
        return { next: null, result: "full" };
    }
    return { next: [makeMark(page), ...marks], result: "marked" };
}

export function applyRemove(marks: Mark[], key: string): Edit<void> {
    const next = marks.filter((m) => m.key !== key);
    return { next: next.length === marks.length ? null : next, result: undefined };
}

export function applyOpened(marks: Mark[], key: string, now = Date.now()): Edit<void> {
    let found = false;
    const next = marks.map((m) => {
        if (m.key !== key) {
            return m;
        }
        found = true;
        return { ...m, openCount: (m.openCount ?? 0) + 1, lastOpened: now };
    });
    return { next: found ? next : null, result: undefined };
}

/** Parses an export (or a plain list of {url, title}). Throws if it isn't one. */
export function parseImport(json: string): unknown[] {
    const data = JSON.parse(json) as unknown;
    const list = Array.isArray(data) ? data : Array.isArray((data as { marks?: unknown })?.marks) ? (data as { marks: unknown[] }).marks : null;
    if (!list) {
        throw new Error("That file doesn't look like a Tabdrift marks export");
    }
    return list;
}

export function applyImport(marks: Mark[], list: unknown[]): Edit<ImportResult> {
    const next = [...marks];
    const seen = new Set(marks.map((m) => m.key));
    let added = 0;
    let skipped = 0;
    for (const raw of list) {
        const entry = (raw ?? {}) as Partial<Mark>;
        if (!canMark(entry.url)) {
            continue;
        }
        const mark = makeMark({ url: entry.url, title: entry.title });
        if (seen.has(mark.key)) {
            continue;
        }
        seen.add(mark.key);
        if (next.length >= MAX_MARKS) {
            skipped++;
            continue;
        }
        mark.createdAt = typeof entry.createdAt === "number" ? entry.createdAt : mark.createdAt;
        mark.openCount = typeof entry.openCount === "number" ? entry.openCount : 0;
        mark.lastOpened = typeof entry.lastOpened === "number" ? entry.lastOpened : undefined;
        next.push(mark);
        added++;
    }
    return { next: added > 0 ? next : null, result: { added, skipped } };
}

/* -------------------------------------------------------------------------- */
/* The one writer.                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every read-modify-write of the marks list runs here, one after another.
 * Without this, two edits that overlap (Alt+Shift+B while the overlay counts an
 * open, or an import) each read the same list and the second save wipes out
 * the first. Only the background script calls these; other pages go through
 * the message API below so there is a single queue for the whole extension.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(edit: (marks: Mark[]) => Edit<T>): Promise<T> {
    const run = queue.then(async () => {
        const { next, result } = edit(await getMarks());
        if (next) {
            await save(next);
        }
        return result;
    });
    // Keep the chain alive after a failure; the caller still sees the error.
    queue = run.catch(() => {});
    return run;
}

export const markStore = {
    toggle: (page: { url: string; title?: string; favIconUrl?: string }) => serialized((m) => applyToggle(m, page)),
    remove: (key: string) => serialized((m) => applyRemove(m, key)),
    opened: (key: string) => serialized((m) => applyOpened(m, key)),
    import: (list: unknown[]) => serialized((m) => applyImport(m, list)),
};

/* -------------------------------------------------------------------------- */
/* Message API for the overlay, popup and settings page.                      */
/* -------------------------------------------------------------------------- */

export const MARKS_MESSAGE = "marks";

type MarkRequest =
    | { op: "toggle"; page: { url: string; title?: string; favIconUrl?: string } }
    | { op: "remove"; key: string }
    | { op: "opened"; key: string }
    | { op: "import"; list: unknown[] };

type MarkResponse = { ok: true; result: unknown } | { ok: false; error: string };

/** Background side: runs one request on the queue. */
export async function handleMarkRequest(request: unknown): Promise<MarkResponse> {
    const r = request as Partial<MarkRequest> & { op?: string };
    try {
        if (r.op === "toggle" && r.page && typeof r.page.url === "string") {
            return { ok: true, result: await markStore.toggle(r.page) };
        }
        if ((r.op === "remove" || r.op === "opened") && typeof r.key === "string") {
            return { ok: true, result: await markStore[r.op](r.key) };
        }
        if (r.op === "import" && Array.isArray(r.list)) {
            return { ok: true, result: await markStore.import(r.list) };
        }
        return { ok: false, error: "Unknown marks request" };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

async function request<T>(body: MarkRequest): Promise<T> {
    const response = (await browser.runtime.sendMessage({ action: MARKS_MESSAGE, ...body })) as MarkResponse | undefined;
    if (!response) {
        throw new Error("Tabdrift's background script didn't answer");
    }
    if (!response.ok) {
        throw new Error(response.error);
    }
    return response.result as T;
}

/** Marks the page, or unmarks it if it's already marked. "full" means the cap was hit and nothing changed. */
export function toggleMark(page: { url: string; title?: string; favIconUrl?: string }): Promise<ToggleResult> {
    return request<ToggleResult>({ op: "toggle", page: { url: page.url, title: page.title, favIconUrl: page.favIconUrl } });
}

export function removeMark(key: string): Promise<void> {
    return request<void>({ op: "remove", key });
}

/** Counts an open, so marks you use often rank higher. */
export function noteOpened(key: string): Promise<void> {
    return request<void>({ op: "opened", key });
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

/** Adds the marks from an export. Existing marks are kept. Reports how many were saved and how many didn't fit. */
export function importMarks(json: string): Promise<ImportResult> {
    return request<ImportResult>({ op: "import", list: parseImport(json) });
}
