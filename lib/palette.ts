import { copyText } from "./clipboard";
import type { TabCommandId, TabCommandReply } from "./commands";
import type { Mark } from "./marks";
import { canMark, getMarks, markKey, noteOpened, onMarksChanged, toggleMark } from "./marks";
import type { Candidate, Ranked } from "./match";
import { displayUrl, historyBoost, hostOf, rank, recencyBoost } from "./match";
import { engineById, parseAddress, parseEngineKey } from "./search";
import type { TabSearchSettings } from "./settings";
import { getSettings, onSettingsChanged } from "./settings";
import type { UtilAction } from "./utils";
import { buildUtilities, cleanUrl, duplicateKey, groupBySite } from "./utils";

interface TabInfo {
    id: number;
    title?: string;
    url?: string;
    favIconUrl?: string;
    pinned?: boolean;
    active?: boolean;
    lastAccessed?: number;
    windowId?: number;
    index?: number;
    audible?: boolean;
    muted?: boolean;
    discarded?: boolean;
    /** The tab this overlay is open in. */
    current?: boolean;
}

/** A row that closes several tabs at once. */
interface ActionRow {
    id: "close-duplicates" | "close-matching";
    label: string;
    sub: string;
    tabs: TabInfo[];
    /** Needs a second Enter before anything is closed. */
    confirm: boolean;
}

interface HistoryInfo {
    id: string;
    title?: string;
    /** The exact page. For a site row, the most recently visited page on that site. */
    url?: string;
    lastVisitTime: number;
    visitCount?: number;
    /** Set when this row stands for a whole site rather than one page. */
    site?: { host: string; origin: string; count: number; pages: HistoryInfo[] };
}

/** A web search or an address to open, so the overlay can stand in for the address bar. */
interface WebRow {
    id: "search-keyed" | "search" | "go";
    /** What the row shows: the search terms or the address. */
    title: string;
    sub: string;
    badge: string;
    url: string;
}

/** Something to run: a tab action, a window command, a copy. */
interface CommandRow {
    id: string;
    title: string;
    sub: string;
    icon: string;
    /** Extra words the command can be found by. */
    keywords?: string;
    /** Needs a second Enter. */
    confirm?: boolean;
    run: (stay: boolean) => Promise<void> | void;
}

type ResultRow =
    | { kind: "web"; data: WebRow }
    | { kind: "util"; data: UtilAction }
    | { kind: "action"; data: ActionRow }
    | { kind: "cmd"; data: CommandRow }
    | { kind: "tab"; data: TabInfo }
    | { kind: "mark"; data: Mark }
    /** `child` marks a page listed under an expanded site row. */
    | { kind: "history"; data: HistoryInfo; child?: boolean };

/** Like Telescope's pickers: narrow the search to one kind of thing. The keys are the ones Firefox's address bar uses. */
type Scope = "all" | "tabs" | "marks" | "history" | "commands";

const SCOPES: { id: Scope; label: string; key: string; placeholder: string }[] = [
    { id: "all", label: "All", key: "", placeholder: "Search tabs, marks, history or the web, or paste a link..." },
    { id: "tabs", label: "Tabs", key: "%", placeholder: "Search open tabs..." },
    { id: "marks", label: "Marks", key: "*", placeholder: "Search your marks... (Ctrl+B marks a row)" },
    { id: "history", label: "History", key: "^", placeholder: "Search history..." },
    { id: "commands", label: "Commands", key: ">", placeholder: "Run a command on this tab or window..." },
];

/** A detail list that temporarily replaces the results: a link's copy options or a tab's actions. */
interface Detail {
    title: string;
    rows: ResultRow[];
    returnIndex: number;
    /** Set for a tab's action list, so it can be rebuilt after pinning, muting and so on. */
    tabId?: number;
}

const SEARCH_DEBOUNCE_MS = 120;
const SCOPED_DEBOUNCE_MS = 40;
const HISTORY_LIMIT = 6;
const HISTORY_SCOPED_LIMIT = 40;
const MARK_LIMIT = 5;
const MARK_SCOPED_LIMIT = 200;
/** You marked it on purpose, so it beats a page that merely matches as well. */
const MARK_BOOST = 1.5;
const EXPAND_LIMIT = 10;
const HISTORY_POOL_PLAIN = 25;
const HISTORY_POOL_GROUPED = 150;
const PAGE_JUMP = 8;
const TOAST_MS = 1800;
const TOAST_MAX_CHARS = 56;
const HINT_FLASH_MS = 2600;
const IS_MAC = /mac/i.test(navigator.platform);
const GUARDED_KEY_EVENTS = ["keydown", "keypress", "keyup"] as const;
const GUARDED_FOCUS_EVENTS = ["focusin", "focus"] as const;
const REFOCUS_LIMIT = 10;
const REFOCUS_WINDOW_MS = 1000;

/**
 * Where the palette runs: over a web page, in the toolbar popup on pages Firefox won't let us script,
 * or over Tabdrift's own new tab page.
 */
export type PaletteMode = "page" | "popup" | "newtab";

export interface PaletteOrigin {
    /** The tab the palette belongs to. Needed in the popup, where the background can't tell which tab we mean. */
    tabId?: number;
    url?: string;
}

export interface PaletteController {
    /** Opens the palette, with `text` already typed in. Replaces whatever was typed before. */
    show(text?: string): void;
}

// Empty tabs, where opening a result should replace the tab like the address bar does.
const BLANK_PAGES = ["about:newtab", "about:home", "about:blank", "about:privatebrowsing"];

export interface PaletteHooks {
    /** Called when the overlay opens or closes over the page. */
    onOpenChange?: (open: boolean) => void;
}

/** "5 min ago", "3 days ago". */
function ago(timestamp: number | undefined): string {
    if (!timestamp) {
        return "";
    }
    const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
    if (seconds < 60) {
        return "just now";
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours} h ago`;
    }
    const days = Math.round(hours / 24);
    if (days < 45) {
        return `${days} day${days === 1 ? "" : "s"} ago`;
    }
    return new Date(timestamp).toLocaleDateString();
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function escapeMarkdown(text: string): string {
    return text.replace(/([[\]\\])/g, "\\$1");
}

/** Writes `text` into `el`, wrapping the matched characters in <mark>. */
function setHighlighted(el: HTMLElement, text: string, positions?: number[]) {
    el.textContent = "";
    if (!positions || positions.length === 0) {
        el.textContent = text;
        return;
    }
    const hit = new Set(positions);
    let run = "";
    let marked = false;
    const flush = () => {
        if (!run) {
            return;
        }
        if (marked) {
            const mark = document.createElement("mark");
            mark.textContent = run;
            el.appendChild(mark);
        } else {
            el.appendChild(document.createTextNode(run));
        }
        run = "";
    };
    for (let i = 0; i < text.length; i++) {
        const m = hit.has(i);
        if (m !== marked) {
            flush();
            marked = m;
        }
        run += text[i];
    }
    flush();
}

export function mountPalette(mode: PaletteMode, origin: PaletteOrigin = {}, hooks: PaletteHooks = {}): PaletteController {
    const inPopup = mode === "popup";
    const onNewTab = mode === "newtab";
    /** In a blank tab, Enter loads the result right here instead of opening yet another tab. */
    const loadHere = onNewTab || (inPopup && BLANK_PAGES.some((p) => (origin.url ?? "").startsWith(p)));
    let closeTimer: ReturnType<typeof setTimeout> | null = null;

    /** Messages to the background. From the popup it can't tell which tab we mean, so we say. */
    function send<T = unknown>(message: Record<string, unknown>): Promise<T> {
        const withOrigin = origin.tabId !== undefined ? { ...message, fromTabId: origin.tabId } : message;
        return browser.runtime.sendMessage(withOrigin) as Promise<T>;
    }

    let host: HTMLDivElement | null = null;
    let shadow: ShadowRoot | null = null;
    let settings: TabSearchSettings | null = null;

    let scope: Scope = "all";
    let tabs: TabInfo[] = [];
    let filtered: TabInfo[] = [];
    let historyResults: HistoryInfo[] = [];
    /** Every mark, kept in step with storage. */
    let marks: Mark[] = [];
    let markedKeys = new Set<string>();
    let markResults: Mark[] = [];
    let commandRows: CommandRow[] = [];
    let utilities: UtilAction[] = [];
    let webRows: WebRow[] = [];
    /** Where the query matched each result, for highlighting. Rebuilt on every search. */
    let hits = new WeakMap<object, { t: number[]; s: number[]; score: number }>();
    /** Web rows go above everything else and take the highlight. Otherwise they sit under the open tabs. */
    let webFirst = false;
    let detail: Detail | null = null;
    /** Host of the site row whose pages are listed underneath it. One at a time. */
    let expandedHost: string | null = null;
    let actions: ActionRow[] = [];
    /** The row waiting for a second Enter. */
    let armedId: string | null = null;
    let closedCount = 0;
    let openedCount = 0;
    let hintFlash: string | null = null;
    let hintFlashTimer: ReturnType<typeof setTimeout> | null = null;
    let selectedIndex = 0;
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    let searchRequestId = 0;

    let input: HTMLInputElement | null = null;
    let resultsEl: HTMLDivElement | null = null;
    let previewEl: HTMLElement | null = null;
    let scopesEl: HTMLDivElement | null = null;
    let cardEl: HTMLDivElement | null = null;
    let hintEl: HTMLSpanElement | null = null;

    let rowEls: HTMLElement[] = [];
    let overlayActive = false;
    let bodyWasInert = false;
    let refocusTimes: number[] = [];
    let previouslyFocused: HTMLElement | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    let toastEl: HTMLDivElement | null = null;
    let toastHost: HTMLDivElement | null = null;
    let toastTimer: ReturnType<typeof setTimeout> | null = null;

    // Marked or unmarked somewhere else (another tab's overlay, Alt+Shift+B): keep the list honest.
    onMarksChanged((next) => {
        const before = markedKeys;
        setMarks(next);
        const same = before.size === markedKeys.size && [...before].every((k) => markedKeys.has(k));
        if (!overlayActive || detail || same) {
            return;
        }
        const keep = selectedIndex;
        refresh(input?.value ?? "");
        selectedIndex = Math.max(0, Math.min(keep, getRows().length - 1));
        renderResults();
    });

    onSettingsChanged((next) => {
        settings = next;
        if (cardEl) {
            applyAppearance();
        }
    });

    function ensureOverlay() {
        if (host) {
            return;
        }

        host = document.createElement("div");
        host.id = "tabdrift-overlay-host";
        if (inPopup) {
            document.body.appendChild(host);
        } else {
            host.style.cssText = "position: fixed; inset: 0; z-index: 2147483647;";
            document.documentElement.appendChild(host);
        }

        shadow = host.attachShadow({ mode: "closed" });
        shadow.innerHTML = STYLES + MARKUP;
        if (inPopup) {
            (shadow.getElementById("wrapper") as HTMLDivElement).dataset.mode = "popup";
            (shadow.getElementById("scrim") as HTMLDivElement).style.display = "none";
            // No page to guard in a popup, so keys are handled directly.
            window.addEventListener("keydown", handleKeydown);
        }

        cardEl = shadow.getElementById("card") as HTMLDivElement;
        input = shadow.getElementById("search-input") as HTMLInputElement;
        resultsEl = shadow.getElementById("results") as HTMLDivElement;
        previewEl = shadow.getElementById("preview") as HTMLElement;
        scopesEl = shadow.getElementById("scopes") as HTMLDivElement;
        hintEl = shadow.getElementById("hint") as HTMLSpanElement;
        const scrim = shadow.getElementById("scrim") as HTMLDivElement;
        const settingsBtn = shadow.getElementById("settings-btn") as HTMLButtonElement;

        settingsBtn.addEventListener("click", () => {
            send({ action: "openOptions" });
            if (inPopup) {
                hideOverlay();
            }
        });
        input.addEventListener("input", () => {
            takeScopePrefix();
            refresh(input?.value ?? "");
        });
        input.addEventListener("paste", () => setTimeout(maybeQuickCopy, 0));
        scrim.addEventListener("click", hideOverlay);

        for (const s of SCOPES) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "scope";
            btn.dataset.scope = s.id;
            btn.tabIndex = -1;
            btn.append(s.label);
            if (s.key) {
                const key = document.createElement("kbd");
                key.textContent = s.key;
                btn.append(key);
            }
            btn.addEventListener("mousedown", (e) => e.preventDefault());
            btn.addEventListener("click", () => setScope(s.id));
            scopesEl.appendChild(btn);
        }
        const tip = document.createElement("span");
        tip.className = "scope-tip";
        tip.textContent = "Tab to switch";
        scopesEl.appendChild(tip);
    }

    function guardKey(e: KeyboardEvent) {
        e.stopImmediatePropagation();
        // Changing focus during keydown sends the typed character to the new target.
        if (input && shadow?.activeElement !== input) {
            input.focus();
        }
        if (e.type === "keydown") {
            handleKeydown(e);
        }
    }

    function canRefocus(): boolean {
        const now = performance.now();
        refocusTimes = refocusTimes.filter((t) => now - t < REFOCUS_WINDOW_MS);
        if (refocusTimes.length >= REFOCUS_LIMIT) {
            return false;
        }
        refocusTimes.push(now);
        return true;
    }

    function guardFocus(e: Event) {
        if (host && e.composedPath().includes(host)) {
            return;
        }
        e.stopImmediatePropagation();
        if (canRefocus()) {
            input?.focus();
        }
    }

    function setPageInert(on: boolean) {
        const body = document.body;
        if (!body || !("inert" in body)) {
            return;
        }
        if (on) {
            bodyWasInert = body.inert;
            body.inert = true;
        } else {
            body.inert = bodyWasInert;
        }
    }

    function addGuards() {
        for (const type of GUARDED_KEY_EVENTS) {
            window.addEventListener(type, guardKey as EventListener, true);
        }
        for (const type of GUARDED_FOCUS_EVENTS) {
            window.addEventListener(type, guardFocus, true);
        }
    }

    function removeGuards() {
        for (const type of GUARDED_KEY_EVENTS) {
            window.removeEventListener(type, guardKey as EventListener, true);
        }
        for (const type of GUARDED_FOCUS_EVENTS) {
            window.removeEventListener(type, guardFocus, true);
        }
    }

    function applyAppearance() {
        if (!shadow || !settings) {
            return;
        }
        const wrapper = shadow.getElementById("wrapper") as HTMLDivElement;
        wrapper.dataset.position = settings.position;
        wrapper.dataset.width = settings.width;
        wrapper.dataset.preview = settings.showPreview && settings.width !== "compact" ? "on" : "off";
        wrapper.style.setProperty("--accent", settings.accent);
    }

    async function showOverlay(initialText = "") {
        ensureOverlay();
        settings = await getSettings();
        applyAppearance();

        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        if (!overlayActive && inPopup) {
            overlayActive = true;
        } else if (!overlayActive) {
            const active = document.activeElement;
            previouslyFocused = active instanceof HTMLElement && active !== document.body && active !== host ? active : null;
            overlayActive = true;
            refocusTimes = [];
            setPageInert(true);
            addGuards();
            hooks.onOpenChange?.(true);
        }

        if (host) {
            host.style.display = "block";
        }
        shadow?.getElementById("scrim")?.classList.add("open");
        cardEl?.classList.add("open");

        // Take focus straight away, before the tab list has even loaded.
        scope = "all";
        if (input) {
            input.value = initialText;
            takeScopePrefix();
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        }
        renderScopes();

        tabs = await send({ action: "getTabs" });
        closedCount = 0;
        openedCount = 0;
        hintFlash = null;
        historyResults = [];
        setMarks(await getMarks().catch(() => []));
        refresh(input?.value ?? "");
    }

    function hideOverlay() {
        if (inPopup) {
            // Deferred a tick so a message sent right after still goes out.
            closeTimer = setTimeout(() => window.close(), 0);
            return;
        }
        if (!host) {
            return;
        }
        if (searchTimer) {
            clearTimeout(searchTimer);
            searchTimer = null;
        }
        searchRequestId++;

        overlayActive = false;
        removeGuards();
        setPageInert(false);
        hooks.onOpenChange?.(false);
        // Hand focus back to whatever had it before, e.g. the chat box.
        const returnTo = previouslyFocused;
        previouslyFocused = null;
        if (returnTo?.isConnected) {
            returnTo.focus({ preventScroll: true });
        }

        shadow?.getElementById("scrim")?.classList.remove("open");
        cardEl?.classList.remove("open");
        hideTimer = setTimeout(() => {
            hideTimer = null;
            if (host) {
                host.style.display = "none";
            }
        }, 120);
    }

    /** "* rust" switches to marks and leaves "rust" in the box, like Firefox's address bar. */
    function takeScopePrefix() {
        if (!input) {
            return;
        }
        const m = input.value.match(/^([%*^>])\s/);
        const target = m ? SCOPES.find((s) => s.key === m[1]) : undefined;
        if (!target) {
            return;
        }
        scope = target.id;
        input.value = input.value.slice(2);
        renderScopes();
    }

    function setScope(next: Scope) {
        if (next === scope) {
            input?.focus();
            return;
        }
        scope = next;
        renderScopes();
        input?.focus();
        refresh(input?.value ?? "");
    }

    function cycleScope(step: number) {
        const at = SCOPES.findIndex((s) => s.id === scope);
        const next = SCOPES[(at + step + SCOPES.length) % SCOPES.length];
        if (next) {
            setScope(next.id);
        }
    }

    function renderScopes() {
        if (!scopesEl || !input) {
            return;
        }
        for (const btn of scopesEl.querySelectorAll<HTMLButtonElement>(".scope")) {
            btn.classList.toggle("on", btn.dataset.scope === scope);
        }
        input.placeholder = SCOPES.find((s) => s.id === scope)?.placeholder ?? "";
    }

    /** Open tabs, most recently used first, without the tab the overlay is in. */
    function recentTabs(): TabInfo[] {
        return tabs.filter((t) => !t.current).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    }

    function remember<T extends object>(ranked: Ranked<T>[]): T[] {
        for (const r of ranked) {
            hits.set(r.item, { t: r.titlePos, s: r.subPos, score: r.score });
        }
        return ranked.map((r) => r.item);
    }

    /**
     * Marks go above your tabs when their best match is better, so "search google" lands on the marked
     * Search Console instead of whatever Google tab happens to be open.
     */
    function marksLead(): boolean {
        const topMark = markResults[0];
        if (!topMark || !input?.value.trim()) {
            return false;
        }
        const topTab = filtered[0];
        return !topTab || (hits.get(topMark)?.score ?? 0) > (hits.get(topTab)?.score ?? 0);
    }

    function rankTabs(q: string): TabInfo[] {
        const now = Date.now();
        const candidates: Candidate<TabInfo>[] = tabs.map((t) => ({
            item: t,
            title: t.title || "",
            sub: displayUrl(t.url),
            host: hostOf(t.url),
            boost: recencyBoost(t.lastAccessed, now) * 0.5 + (isMarked(t.url) ? MARK_BOOST / 2 : 0),
        }));
        return remember(rank(candidates, q));
    }

    /** Tabs showing a page that is already open elsewhere. One copy of each page is kept. */
    function findDuplicateTabs(): TabInfo[] {
        const groups = new Map<string, TabInfo[]>();
        for (const tab of tabs) {
            if (!tab.url) {
                continue;
            }
            const key = duplicateKey(tab.url);
            groups.set(key, [...(groups.get(key) ?? []), tab]);
        }

        const extras: TabInfo[] = [];
        for (const group of groups.values()) {
            if (group.length < 2) {
                continue;
            }
            const byRecent = [...group].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
            const keeper = byRecent.find((t) => t.current) ?? byRecent.find((t) => t.pinned) ?? byRecent.find((t) => t.active) ?? byRecent[0];
            for (const tab of group) {
                if (tab !== keeper && !tab.pinned && !tab.current) {
                    extras.push(tab);
                }
            }
        }
        return extras;
    }

    function computeActions(q: string): ActionRow[] {
        if (!q) {
            const extras = findDuplicateTabs();
            if (extras.length === 0) {
                return [];
            }
            return [
                {
                    id: "close-duplicates",
                    label: `Close ${plural(extras.length, "duplicate tab")}`,
                    sub: "Keeps one copy of each page",
                    tabs: extras,
                    confirm: false,
                },
            ];
        }

        const closable = filtered.filter((t) => !t.current && !t.pinned);
        if (closable.length < 2) {
            return [];
        }
        const skipped = filtered.length - closable.length;
        return [
            {
                id: "close-matching",
                label: `Close all ${closable.length} matching tabs`,
                sub: skipped > 0 ? "Pinned tabs and this tab stay. Press Enter twice" : "Press Enter twice to confirm",
                tabs: closable,
                confirm: true,
            },
        ];
    }

    /** Action rows sit above the results but are never the preselected row, so Enter still switches tabs. */
    function defaultIndex(): number {
        const first = getRows().findIndex((r) => r.kind !== "action");
        return first === -1 ? 0 : first;
    }

    function clearResults() {
        armedId = null;
        detail = null;
        expandedHost = null;
        hits = new WeakMap();
        filtered = [];
        actions = [];
        historyResults = [];
        markResults = [];
        commandRows = [];
        utilities = [];
        webRows = [];
        webFirst = false;
    }

    function refresh(query: string) {
        const q = query.trim();
        clearResults();

        if (scope === "tabs") {
            filtered = q ? rankTabs(q) : recentTabs();
            actions = computeActions(q);
        } else if (scope === "commands") {
            const all = buildCommands();
            commandRows = q
                ? remember(
                      rank(
                          all.map((c) => ({ item: c, title: c.title, sub: c.sub, extra: c.keywords })),
                          q,
                      ),
                  )
                : all;
        } else if (scope === "marks") {
            markResults = rankMarks(q, true).slice(0, MARK_SCOPED_LIMIT);
        } else if (scope === "all") {
            if (!q) {
                const listing = settings?.listOnOpen ?? true;
                filtered = listing ? recentTabs() : [];
                actions = listing ? computeActions("") : [];
            } else {
                filtered = rankTabs(q);
                // A marked page that's already open shows up as its tab, with a star.
                markResults = rankMarks(q, false).slice(0, MARK_LIMIT);
                utilities = buildUtilities(q, tabs);
                actions = computeActions(q);
                planWebRows(q);
            }
        }
        // History fills in when its search answers.

        selectedIndex = defaultIndex();
        renderResults();
        queueSearch(q);
    }

    /**
     * Search and "go to" rows. They jump to the top when the intent is clear:
     * an engine key ("g ..." or "... g"), a full link, or nothing else matched.
     */
    function planWebRows(q: string) {
        const engine = engineById(settings?.searchEngine);
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
            webRows = [
                {
                    id: "search-keyed",
                    title: keyed.query,
                    sub: `Search with ${keyed.engine.name}`,
                    badge: keyed.engine.key,
                    url: keyed.engine.searchUrl(keyed.query),
                },
                plain,
            ];
            webFirst = true;
            return;
        }

        const address = parseAddress(q);
        if (address) {
            const go: WebRow = { id: "go", title: address.url, sub: "Open in a new tab", badge: "go", url: address.url };
            webRows = address.explicit ? [go] : [go, plain];
            webFirst = address.explicit || (filtered.length === 0 && utilities.length === 0);
            return;
        }

        webRows = [plain];
        webFirst = filtered.length === 0 && utilities.length === 0 && markResults.length === 0;
    }

    /** History lives in the background script, so it arrives a moment after the tabs. */
    function queueSearch(query: string) {
        if (searchTimer) {
            clearTimeout(searchTimer);
        }
        const forScope = scope;
        const requestId = ++searchRequestId;
        if (!(forScope === "history" || (forScope === "all" && !!query))) {
            return;
        }

        searchTimer = setTimeout(
            async () => {
                const scoped = forScope !== "all";
                const grouped = settings?.groupHistory ?? true;
                const rawHistory = (await send({
                    action: "searchHistory",
                    query,
                    maxResults: grouped ? HISTORY_POOL_GROUPED : scoped ? HISTORY_SCOPED_LIMIT : HISTORY_POOL_PLAIN,
                })) as HistoryInfo[];
                // Bail if the input or scope changed (or the overlay closed) while this was in flight.
                if (requestId !== searchRequestId || scope !== forScope || (input?.value.trim() ?? "") !== query) {
                    return;
                }

                // Pages already open (or marked) show up higher in the combined list. In a scope, they stay.
                let pages = (rawHistory ?? []).filter((h) => h.url && (scoped || (!openTabFor(h.url) && !isMarked(h.url))));
                if (query) {
                    const now = Date.now();
                    pages = remember(
                        rank(
                            pages.map((h) => ({
                                item: h,
                                title: h.title || "",
                                sub: displayUrl(h.url),
                                host: hostOf(h.url),
                                boost: historyBoost(h.lastVisitTime, h.visitCount, now),
                            })),
                            query,
                        ),
                    );
                }
                const limit = scoped ? HISTORY_SCOPED_LIMIT : HISTORY_LIMIT;
                historyResults = grouped ? collapseToSites(pages, limit) : pages.slice(0, limit);

                if (scoped) {
                    selectedIndex = Math.min(selectedIndex, Math.max(0, getRows().length - 1));
                }
                renderResults();
            },
            forScope === "all" ? SEARCH_DEBOUNCE_MS : SCOPED_DEBOUNCE_MS,
        );
    }

    function setMarks(next: Mark[]) {
        marks = next;
        markedKeys = new Set(next.map((m) => m.key));
    }

    function isMarked(url: string | undefined): boolean {
        return canMark(url) && markedKeys.has(markKey(url));
    }

    /** Most used and most recently opened first. With a query, best match first. */
    function rankMarks(q: string, includeOpen: boolean): Mark[] {
        const now = Date.now();
        const pool = includeOpen ? marks : marks.filter((m) => !openTabFor(m.url));
        const boost = (m: Mark) => historyBoost(m.lastOpened ?? m.createdAt, m.openCount, now);
        if (!q) {
            return [...pool].sort((a, b) => boost(b) - boost(a));
        }
        return remember(
            rank(
                pool.map((m) => ({ item: m, title: m.title, sub: displayUrl(m.url), host: hostOf(m.url), boost: boost(m) + MARK_BOOST })),
                q,
            ),
        );
    }

    /** The page behind a row, for marking with Ctrl+B. */
    function rowPage(row: ResultRow): { url: string; title?: string; favIconUrl?: string } | null {
        if (row.kind === "tab") {
            return canMark(row.data.url) ? { url: row.data.url, title: row.data.title, favIconUrl: row.data.favIconUrl } : null;
        }
        if (row.kind === "mark") {
            return { url: row.data.url, title: row.data.title };
        }
        if (row.kind === "history") {
            const url = row.data.site && !row.child ? `${row.data.site.origin}/` : row.data.url;
            const title = row.data.site && !row.child ? row.data.site.host : row.data.title;
            return canMark(url) ? { url, title, favIconUrl: tabs.find((t) => hostOf(t.url) === hostOf(url))?.favIconUrl } : null;
        }
        if (row.kind === "web" && row.data.id === "go") {
            return { url: row.data.url, title: displayUrl(row.data.url) };
        }
        return null;
    }

    /** Ctrl+B: mark or unmark the highlighted row, and stay where you are. */
    async function toggleRowMark(row: ResultRow | undefined) {
        const page = row ? rowPage(row) : null;
        if (!page) {
            flashHint("Nothing to mark on this row");
            return;
        }
        const keep = selectedIndex;
        const marked = await toggleMark(page);
        setMarks(await getMarks());
        const name = page.title || page.url;
        const short = name.length > 48 ? `${name.slice(0, 47)}\u2026` : name;
        flashHint(marked ? `\u2605 Marked \u201c${short}\u201d \u2022 find it under *` : `Unmarked \u201c${short}\u201d`);
        if (detail) {
            await reloadTabs();
            return;
        }
        // Rebuild without moving: in the marks scope the row disappears, elsewhere it gains or loses its star.
        refresh(input?.value ?? "");
        selectedIndex = Math.max(0, Math.min(keep, getRows().length - 1));
        renderResults();
    }

    /** One row per site. The row keeps the latest exact page, so Shift+Enter can still open it. */
    function collapseToSites(ranked: HistoryInfo[], limit: number): HistoryInfo[] {
        return groupBySite(ranked)
            .slice(0, limit)
            .map((group) => ({
                ...group.latest,
                site: group.origin
                    ? {
                          host: group.host,
                          origin: group.origin,
                          count: group.count,
                          pages: [...group.items].sort((a, b) => b.lastVisitTime - a.lastVisitTime),
                      }
                    : undefined,
            }));
    }

    function openTabFor(url: string | undefined): TabInfo | undefined {
        if (!url) {
            return undefined;
        }
        const key = duplicateKey(url);
        return tabs.find((t) => !t.current && t.url && duplicateKey(t.url) === key);
    }

    function openDetail(url: string | undefined, label: string) {
        const options = url ? buildUtilities(url, tabs) : [];
        if (options.length === 0) {
            flashHint("No copy options for that link");
            return;
        }
        detail = { title: `Utilities · ${label}`, rows: options.map((data): ResultRow => ({ kind: "util", data })), returnIndex: selectedIndex };
        armedId = null;
        selectedIndex = 0;
        renderResults();
    }

    function openTabDetail(tab: TabInfo) {
        detail = {
            title: `Tab · ${(tab.title || hostLabel(tab.url) || "Untitled").slice(0, 48)}`,
            rows: tabActionRows(tab, true).map((data): ResultRow => ({ kind: "cmd", data })),
            returnIndex: selectedIndex,
            tabId: tab.id,
        };
        armedId = null;
        selectedIndex = 0;
        renderResults();
    }

    function closeDetail() {
        const back = detail?.returnIndex ?? defaultIndex();
        detail = null;
        armedId = null;
        selectedIndex = Math.min(back, Math.max(0, getRows().length - 1));
        renderResults();
    }

    /** Lists the pages behind a site row, right under it. */
    function expandSite(entry: HistoryInfo) {
        if (!entry.site) {
            return;
        }
        expandedHost = entry.site.host;
        renderResults();
    }

    /** Hides the expanded pages and puts the highlight back on their site row. */
    function collapseSite() {
        const host = expandedHost;
        expandedHost = null;
        const rows = getRows();
        const at = rows.findIndex((r) => r.kind === "history" && r.data.site?.host === host);
        if (at !== -1) {
            selectedIndex = at;
        }
        renderResults();
    }

    function hostLabel(url: string | undefined): string {
        try {
            return new URL(url ?? "").host.replace(/^www\./i, "");
        } catch {
            return url ?? "";
        }
    }

    /** Runs a tab or window command in the background. Commands that move you elsewhere close the overlay first. */
    async function tabCommand(command: TabCommandId, tabId: number, closes = false) {
        if (closes) {
            hideOverlay();
        }
        const reply = (await send({ action: "tabCommand", command, tabId })) as TabCommandReply | undefined;
        if (closes) {
            if (reply && !reply.success && reply.message) {
                showToast(reply.message);
            }
            return;
        }
        flashHint(reply?.message ?? (reply?.success ? "✓ Done" : "That didn't work"));
        await reloadTabs();
    }

    /** Fetches the tab list again after a change and redraws without losing your place. */
    async function reloadTabs() {
        const keep = selectedIndex;
        const openDetailFor = detail?.tabId;
        const title = detail?.title;
        const returnIndex = detail?.returnIndex ?? defaultIndex();
        tabs = await send({ action: "getTabs" });
        if (openDetailFor !== undefined) {
            const tab = tabs.find((t) => t.id === openDetailFor);
            if (tab) {
                detail = {
                    title: title ?? "Tab",
                    rows: tabActionRows(tab, true).map((data): ResultRow => ({ kind: "cmd", data })),
                    returnIndex,
                    tabId: tab.id,
                };
            } else {
                refresh(input?.value ?? "");
            }
        } else {
            refresh(input?.value ?? "");
        }
        selectedIndex = Math.max(0, Math.min(keep, getRows().length - 1));
        renderResults();
    }

    async function copyAndClose(value: string, shown: string) {
        const ok = await copyText(value);
        hideOverlay();
        const short = shown.length > TOAST_MAX_CHARS ? `${shown.slice(0, TOAST_MAX_CHARS - 1)}…` : shown;
        showToast(ok ? `Copied ${short}` : "Couldn't copy to the clipboard");
    }

    /** What you can do with one tab. `inList` adds switching and closing, which only make sense for a tab picked from the list. */
    function tabActionRows(tab: TabInfo, inList: boolean): CommandRow[] {
        const rows: CommandRow[] = [];
        const isHere = !!tab.current;
        const noun = inList ? "tab" : "this tab";
        const host = hostOf(tab.url);
        const clean = tab.url ? cleanUrl(tab.url).url : "";

        if (inList && !isHere) {
            rows.push({ id: "tab-switch", title: "Switch to this tab", sub: displayUrl(tab.url), icon: ARROW_ICON, run: () => switchToTab(tab.id) });
        }
        rows.push({
            id: "tab-pin",
            title: tab.pinned ? `Unpin ${noun}` : `Pin ${noun}`,
            sub: tab.pinned ? "Moves it back among the other tabs" : "Keeps it at the left edge and safe from bulk closing",
            icon: PIN_ICON,
            keywords: "pin unpin",
            run: () => tabCommand("pin", tab.id),
        });
        rows.push({
            id: "tab-mute",
            title: tab.muted ? `Unmute ${noun}` : `Mute ${noun}`,
            sub: tab.audible ? "Playing sound right now" : "Silences it, even if it starts playing later",
            icon: tab.muted ? SOUND_ICON : MUTE_ICON,
            keywords: "sound audio volume silence",
            run: () => tabCommand("mute", tab.id),
        });
        rows.push({
            id: "tab-reload",
            title: `Reload ${noun}`,
            sub: inList ? "Shift+Enter skips the cache" : "Loads the page again",
            icon: RELOAD_ICON,
            keywords: "refresh",
            run: () => tabCommand("reload", tab.id, isHere),
        });
        if (!inList) {
            rows.push({
                id: "tab-hard-reload",
                title: "Hard reload, skip the cache",
                sub: "Fetches everything again",
                icon: RELOAD_ICON,
                keywords: "refresh bypass cache force",
                run: () => tabCommand("hard-reload", tab.id, true),
            });
        }
        rows.push({
            id: "tab-duplicate",
            title: `Duplicate ${noun}`,
            sub: "Opens a copy next to it",
            icon: COPY_ICON,
            keywords: "clone copy",
            run: () => tabCommand("duplicate", tab.id, true),
        });
        rows.push({
            id: "tab-window",
            title: `Move ${noun} to a new window`,
            sub: "Pops it out on its own",
            icon: WINDOW_ICON,
            keywords: "detach split",
            run: () => tabCommand("new-window", tab.id, true),
        });
        if (!tab.active && !tab.discarded) {
            rows.push({
                id: "tab-discard",
                title: `Unload ${noun}`,
                sub: "Frees its memory. It reloads when you switch back",
                icon: MOON_ICON,
                keywords: "discard sleep suspend memory",
                run: () => tabCommand("discard", tab.id),
            });
        }
        if (canMark(tab.url)) {
            const page = { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl };
            const marked = isMarked(tab.url);
            rows.push({
                id: "tab-mark",
                title: marked ? "Unmark this page" : "Mark this page",
                sub: marked ? "Removes it from your marks" : `Keeps it under * in Tabdrift. Ctrl+B does this from any row`,
                icon: STAR_ICON,
                keywords: "bookmark save favorite star unmark",
                run: () => toggleRowMark({ kind: "tab", data: { ...tab, ...page } }),
            });
        }
        if (clean) {
            rows.push({
                id: "tab-copy-link",
                title: "Copy clean link",
                sub: displayUrl(clean),
                icon: LINK_ICON,
                keywords: "url yank",
                run: () => copyAndClose(clean, displayUrl(clean)),
            });
            const md = `[${escapeMarkdown(tab.title || host || clean)}](${clean})`;
            rows.push({
                id: "tab-copy-md",
                title: "Copy as Markdown link",
                sub: md,
                icon: LINK_ICON,
                keywords: "markdown md yank",
                run: () => copyAndClose(md, md),
            });
        }
        if (tab.title) {
            const title = tab.title;
            rows.push({
                id: "tab-copy-title",
                title: "Copy page title",
                sub: title,
                icon: COPY_ICON,
                keywords: "name yank",
                run: () => copyAndClose(title, title),
            });
        }
        if (host) {
            const count = tabs.filter((t) => hostOf(t.url) === host && !t.pinned && !t.current).length;
            if (count > 0) {
                rows.push({
                    id: "tab-close-site",
                    title: `Close every ${host} tab`,
                    sub: `${plural(count, "tab")}. Pinned tabs and this tab stay. Press Enter twice`,
                    icon: TRASH_ICON,
                    keywords: "close site domain",
                    confirm: true,
                    run: () => tabCommand("close-site", tab.id, false),
                });
            }
        }
        if (inList && !isHere) {
            rows.push({
                id: "tab-close",
                title: "Close tab",
                sub: `Or press ${closeKeyLabel()} on it in the list`,
                icon: CLOSE_ICON,
                run: async () => {
                    detail = null;
                    await closeTabs([tab]);
                },
            });
        }
        return rows;
    }

    /** The ">" scope: actions for the tab you're on, then for the window and all tabs. */
    function buildCommands(): CommandRow[] {
        const here = tabs.find((t) => t.current);
        const rows: CommandRow[] = [];
        if (here) {
            rows.push(...tabActionRows(here, false));
        }

        const windowTabs = here ? tabs.filter((t) => t.windowId === here.windowId) : [];
        const windows = new Set(tabs.map((t) => t.windowId)).size;
        const dupes = findDuplicateTabs();
        if (dupes.length > 0) {
            rows.push({
                id: "win-dupes",
                title: `Close ${plural(dupes.length, "duplicate tab")}`,
                sub: "Keeps one copy of each page",
                icon: TRASH_ICON,
                keywords: "duplicates dedupe clean",
                run: () => closeTabs(dupes),
            });
        }
        if (here) {
            const id = here.id;
            rows.push(
                {
                    id: "win-close-others",
                    title: "Close other tabs in this window",
                    sub: "Pinned tabs stay. Press Enter twice",
                    icon: TRASH_ICON,
                    keywords: "close all others",
                    confirm: true,
                    run: () => tabCommand("close-others", id),
                },
                {
                    id: "win-close-right",
                    title: "Close tabs to the right",
                    sub: "Pinned tabs stay. Press Enter twice",
                    icon: TRASH_ICON,
                    keywords: "close after",
                    confirm: true,
                    run: () => tabCommand("close-right", id),
                },
                {
                    id: "win-close-left",
                    title: "Close tabs to the left",
                    sub: "Pinned tabs stay. Press Enter twice",
                    icon: TRASH_ICON,
                    keywords: "close before",
                    confirm: true,
                    run: () => tabCommand("close-left", id),
                },
                {
                    id: "win-sort",
                    title: "Sort tabs in this window by site",
                    sub: "Groups tabs from the same site together. Pinned tabs stay put",
                    icon: SORT_ICON,
                    keywords: "order arrange group domain",
                    run: () => tabCommand("sort-window", id),
                },
            );
            if (windows > 1) {
                rows.push({
                    id: "win-merge",
                    title: `Merge all ${windows} windows into this one`,
                    sub: "Moves every tab here",
                    icon: WINDOW_ICON,
                    keywords: "combine gather windows",
                    run: () => tabCommand("merge-windows", id),
                });
            }
            rows.push(
                {
                    id: "win-discard",
                    title: "Unload all inactive tabs",
                    sub: "Frees memory. Tabs playing sound are left alone",
                    icon: MOON_ICON,
                    keywords: "discard sleep suspend memory ram",
                    run: () => tabCommand("discard-inactive", id),
                },
                {
                    id: "win-mute-others",
                    title: "Mute all other tabs",
                    sub: "Silences every other tab playing sound",
                    icon: MUTE_ICON,
                    keywords: "sound audio silence quiet",
                    run: () => tabCommand("mute-others", id),
                },
            );
        }
        const links = windowTabs.filter((t) => t.url && /^https?:/i.test(t.url));
        if (links.length > 0) {
            const plain = links.map((t) => cleanUrl(t.url as string).url).join("\n");
            const md = links.map((t) => `- [${escapeMarkdown(t.title || hostOf(t.url))}](${cleanUrl(t.url as string).url})`).join("\n");
            rows.push(
                {
                    id: "win-copy-links",
                    title: "Copy all links in this window",
                    sub: `${plural(links.length, "link")}, one per line, without trackers`,
                    icon: LINK_ICON,
                    keywords: "urls export yank",
                    run: () => copyAndClose(plain, plural(links.length, "link")),
                },
                {
                    id: "win-copy-md",
                    title: "Copy all links in this window as Markdown",
                    sub: "A Markdown list of titles and links",
                    icon: LINK_ICON,
                    keywords: "markdown md list export yank",
                    run: () => copyAndClose(md, `${plural(links.length, "link")} as Markdown`),
                },
            );
        }
        rows.push({
            id: "open-settings",
            title: "Open Tabdrift settings",
            sub: "Width, position, colour, shortcut, export your marks",
            icon: GEAR_ICON,
            keywords: "options preferences config",
            run: () => {
                void send({ action: "openOptions" });
                hideOverlay();
            },
        });
        return rows;
    }

    function historyRows(): ResultRow[] {
        return historyResults.flatMap((data): ResultRow[] => {
            const row: ResultRow = { kind: "history", data };
            if (!data.site || data.site.host !== expandedHost) {
                return [row];
            }
            const pages = data.site.pages.slice(0, EXPAND_LIMIT).map((page): ResultRow => ({ kind: "history", data: page, child: true }));
            return [row, ...pages];
        });
    }

    function getRows(): ResultRow[] {
        if (detail) {
            return detail.rows;
        }
        const markRows = markResults.map((data): ResultRow => ({ kind: "mark", data }));
        if (scope === "tabs") {
            return [...actions.map((data): ResultRow => ({ kind: "action", data })), ...filtered.map((data): ResultRow => ({ kind: "tab", data }))];
        }
        if (scope === "marks") {
            return markRows;
        }
        if (scope === "history") {
            return historyRows();
        }
        if (scope === "commands") {
            return commandRows.map((data): ResultRow => ({ kind: "cmd", data }));
        }
        const web = webRows.map((data): ResultRow => ({ kind: "web", data }));
        return [
            ...(webFirst ? web : []),
            ...utilities.map((data): ResultRow => ({ kind: "util", data })),
            ...(marksLead() ? markRows : []),
            ...actions.map((data): ResultRow => ({ kind: "action", data })),
            ...filtered.map((data): ResultRow => ({ kind: "tab", data })),
            ...(marksLead() ? [] : markRows),
            ...(webFirst ? [] : web),
            ...historyRows(),
        ];
    }

    function sectionTitle(kind: ResultRow["kind"]): string | null {
        if (detail) {
            return detail.title;
        }
        if (kind === "web") {
            return "Web";
        }
        if (kind === "util") {
            return "Utilities";
        }
        if (kind === "action") {
            return "Clean up";
        }
        if (kind === "cmd") {
            return "Commands";
        }
        if (kind === "mark") {
            return scope === "marks" ? `Marks \u00b7 ${markResults.length}` : "Marks";
        }
        if (kind === "history") {
            if (scope === "history") {
                return input?.value.trim() ? "History" : "Recently visited";
            }
            return "From history";
        }
        if (!input?.value.trim()) {
            return `Recent tabs · ${filtered.length}`;
        }
        // Tabs only need a label when something else sits above them.
        const above = scope === "tabs" ? actions.length > 0 : utilities.length > 0 || actions.length > 0 || (webFirst && webRows.length > 0) || marksLead();
        return above ? `Open tabs · ${filtered.length}` : null;
    }

    function closeKeyLabel(): string {
        return "Ctrl+D";
    }

    /** The key that flips whether opening a link keeps the overlay open. Cmd on Mac, Ctrl elsewhere. */
    function flipKeyLabel(): string {
        return IS_MAC ? "⌘" : "Ctrl+";
    }

    function isFlipKey(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
        return IS_MAC ? e.metaKey : e.ctrlKey;
    }

    /** With the setting off the flip key keeps the overlay open, with it on the flip key closes it. */
    function shouldStayOpen(flip: boolean): boolean {
        return (settings?.keepOpenOnOpen === true) !== flip;
    }

    /** Key hints for opening a link. `label` names what Enter opens. */
    function openHints(label: string): [string, string] {
        return settings?.keepOpenOnOpen
            ? [`Enter ${label} & stay`, `${flipKeyLabel()}Enter open & close`]
            : [`Enter ${label}`, `${flipKeyLabel()}Enter keep open`];
    }

    function reopenKeyLabel(): string {
        return IS_MAC ? "⌘⇧T" : "Ctrl+Shift+T";
    }

    function updateHint(row: ResultRow | undefined) {
        if (!hintEl) {
            return;
        }
        if (hintFlash) {
            hintEl.textContent = hintFlash;
            return;
        }

        const dot = "  •  ";
        const parts = ["↑↓ navigate"];
        if (row?.kind === "web") {
            const [enter, flip] = openHints(row.data.id === "go" ? "open" : "search");
            parts.push(enter, loadHere ? "Shift+Enter new tab" : "Shift+Enter this tab", flip);
        } else if (row?.kind === "util") {
            if (row.data.action === "copy") {
                parts.push("Enter copy");
            } else {
                parts.push(...openHints("open"));
            }
        } else if (row?.kind === "action") {
            parts.push(armedId === row.data.id ? "Enter again to close them" : "Enter close");
        } else if (row?.kind === "cmd") {
            parts.push(armedId === row.data.id ? "Enter again to confirm" : "Enter run");
        } else if (row?.kind === "tab") {
            parts.push("Enter switch", "→ actions", isMarked(row.data.url) ? "Ctrl+B unmark" : "Ctrl+B mark");
            if (!row.data.current) {
                parts.push(`${closeKeyLabel()} close`);
            }
        } else if (row?.kind === "mark") {
            parts.push(...openHints(openTabFor(row.data.url) ? "switch" : "open"), "→ utilities", "Ctrl+B unmark");
        } else if (row?.kind === "history") {
            if (row.data.site) {
                const [enter, flip] = openHints("site");
                parts.push(enter, "Shift+Enter page", flip);
                parts.push(expandedHost === row.data.site.host ? "→ utilities  •  ← collapse" : "→ pages");
            } else {
                parts.push(...openHints("open"), "→ utilities");
                if (row.child) {
                    parts.push("← collapse");
                }
            }
        } else if (!detail) {
            parts.push("Tab scope");
        }
        if (detail) {
            parts.push("← back");
        }
        if (row && rowLink(row)) {
            parts.push("Ctrl+Y copy link");
        }
        parts.push("Esc close");
        hintEl.textContent = parts.join(dot);
    }

    /** Shows a message in the footer for a moment, then goes back to the key hints. */
    function flashHint(text: string) {
        hintFlash = text;
        if (hintFlashTimer) {
            clearTimeout(hintFlashTimer);
        }
        hintFlashTimer = setTimeout(() => {
            hintFlash = null;
            hintFlashTimer = null;
            updateHint(getRows()[selectedIndex]);
        }, HINT_FLASH_MS);
        updateHint(getRows()[selectedIndex]);
    }

    /** The address behind a row, for Ctrl+Y. */
    function rowLink(row: ResultRow): string | null {
        if (row.kind === "tab" || row.kind === "mark") {
            return row.data.url ?? null;
        }
        if (row.kind === "history") {
            return row.data.site && !row.child ? `${row.data.site.origin}/` : (row.data.url ?? null);
        }
        if (row.kind === "web") {
            return row.data.url;
        }
        return null;
    }

    function iconSpan(svg: string): HTMLSpanElement {
        const icon = document.createElement("span");
        icon.className = "util-icon";
        icon.innerHTML = svg;
        return icon;
    }

    /** A site's favicon if any open tab has one, otherwise the fallback icon. */
    function siteIcon(url: string | undefined, fallback: string): HTMLElement {
        const host = hostOf(url);
        const fav = host ? tabs.find((t) => t.favIconUrl && hostOf(t.url) === host)?.favIconUrl : undefined;
        if (!fav) {
            return iconSpan(fallback);
        }
        const img = document.createElement("img");
        img.className = "favicon";
        img.src = fav;
        img.addEventListener("error", () => img.replaceWith(iconSpan(fallback)));
        return img;
    }

    function badge(text: string, extra = ""): HTMLSpanElement {
        const el = document.createElement("span");
        el.className = `badge${extra ? ` ${extra}` : ""}`;
        el.textContent = text;
        return el;
    }

    function textBlock(titleText: string, subText: string, opts: { titleClass?: string; key?: object } = {}): HTMLDivElement {
        const text = document.createElement("div");
        text.className = "text";
        const pos = opts.key ? hits.get(opts.key) : undefined;

        const title = document.createElement("div");
        title.className = opts.titleClass ? `title ${opts.titleClass}` : "title";
        setHighlighted(title, titleText, pos?.t);

        const sub = document.createElement("div");
        sub.className = "url";
        setHighlighted(sub, subText, pos?.s);

        text.append(title, sub);
        return text;
    }

    function buildUtilRow(action: UtilAction): HTMLElement[] {
        return [
            iconSpan(action.action === "copy" ? COPY_ICON : OPEN_ICON),
            textBlock(action.display ?? action.value.replace(/\s*\n\s*/g, ", "), action.label, { titleClass: "mono" }),
            badge(action.action),
        ];
    }

    function buildWebRow(row: WebRow): HTMLElement[] {
        return [
            iconSpan(row.id === "go" ? GLOBE_ICON : SEARCH_ICON),
            textBlock(row.title, row.sub, { titleClass: row.id === "go" ? "mono" : "" }),
            badge(row.badge),
        ];
    }

    function buildActionRow(action: ActionRow): HTMLElement[] {
        const armed = armedId === action.id;
        return [
            iconSpan(TRASH_ICON),
            textBlock(
                armed ? `Close ${plural(action.tabs.length, "tab")}? Press Enter again` : action.label,
                armed ? `Undo with ${reopenKeyLabel()}` : action.sub,
            ),
            badge("close"),
        ];
    }

    function buildCommandRow(cmd: CommandRow): HTMLElement[] {
        const armed = armedId === cmd.id;
        return [
            iconSpan(cmd.icon),
            textBlock(armed ? `${cmd.title}? Press Enter again` : cmd.title, cmd.sub, { key: cmd }),
            badge(cmd.confirm ? "confirm" : "run"),
        ];
    }

    function windowLabels(): Map<number | undefined, number> {
        const ids = [...new Set(tabs.map((t) => t.windowId))].sort((a, b) => (a ?? 0) - (b ?? 0));
        return new Map(ids.map((id, i) => [id, i + 1]));
    }

    function buildTabRow(tab: TabInfo, windows: Map<number | undefined, number>): HTMLElement[] {
        const icon = document.createElement("img");
        icon.className = "favicon";
        icon.src = tab.favIconUrl || "";
        icon.addEventListener("error", () => (icon.style.visibility = "hidden"));
        if (!tab.favIconUrl) {
            icon.style.visibility = "hidden";
        }

        const parts: HTMLElement[] = [icon, textBlock(tab.title || "Untitled", displayUrl(tab.url), { key: tab })];
        if (tab.audible && !tab.muted) {
            parts.push(badge("♪ playing", "soft"));
        } else if (tab.muted) {
            parts.push(badge("muted", "soft"));
        }
        if (tab.discarded) {
            parts.push(badge("unloaded", "soft"));
        }
        if (windows.size > 1) {
            parts.push(badge(`win ${windows.get(tab.windowId) ?? "?"}`, "soft"));
        }
        if (isMarked(tab.url)) {
            parts.push(badge("\u2605", "star"));
        }
        if (tab.pinned || tab.current) {
            parts.push(badge(tab.current ? "this tab" : "pinned"));
        }
        if (!tab.current) {
            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className = "close-btn";
            closeBtn.title = `Close tab (${closeKeyLabel()})`;
            closeBtn.setAttribute("aria-label", "Close tab");
            closeBtn.innerHTML = CLOSE_ICON;
            closeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                void closeSingleTab(tab);
            });
            parts.push(closeBtn);
        }
        return parts;
    }

    function markIcon(mark: Mark): HTMLElement {
        if (!mark.favIconUrl) {
            return siteIcon(mark.url, STAR_ICON);
        }
        const img = document.createElement("img");
        img.className = "favicon";
        img.src = mark.favIconUrl;
        img.addEventListener("error", () => img.replaceWith(iconSpan(STAR_ICON)));
        return img;
    }

    function buildMarkRow(mark: Mark): HTMLElement[] {
        const parts: HTMLElement[] = [markIcon(mark), textBlock(mark.title || displayUrl(mark.url), displayUrl(mark.url), { key: mark })];
        if (mark.openCount > 0) {
            parts.push(badge(`opened ${mark.openCount}\u00d7`, "soft"));
        }
        parts.push(badge(openTabFor(mark.url) ? "open tab" : "\u2605", "star"));
        return parts;
    }

    function buildHistoryRow(row: Extract<ResultRow, { kind: "history" }>): HTMLElement[] {
        const site = row.data.site;
        const parts: HTMLElement[] = [
            row.child ? iconSpan(DOT_ICON) : siteIcon(row.data.url, CLOCK_ICON),
            site
                ? textBlock(site.host, `Latest: ${row.data.title || row.data.url || ""}`)
                : textBlock(row.data.title || displayUrl(row.data.url) || "Untitled", displayUrl(row.data.url), { key: row.data }),
        ];
        if (!row.child && row.data.lastVisitTime) {
            parts.push(badge(ago(row.data.lastVisitTime), "soft"));
        }
        if (site) {
            const chevron = expandedHost === site.host ? "▾" : "▸";
            parts.push(badge(`${site.count} ${site.count === 1 ? "page" : "pages"} ${chevron}`));
        } else {
            if (isMarked(row.data.url)) {
                parts.push(badge("\u2605", "star"));
            }
            parts.push(badge(row.child ? "page" : openTabFor(row.data.url) ? "open tab" : "history"));
        }
        return parts;
    }

    /** Moves the highlight without rebuilding the list, so a click can't land on a row that was just replaced. */
    function selectRow(index: number) {
        if (index === selectedIndex) {
            return;
        }
        if (armedId) {
            armedId = null;
            selectedIndex = index;
            renderResults();
            return;
        }
        rowEls[selectedIndex]?.classList.remove("selected");
        selectedIndex = index;
        rowEls[index]?.classList.add("selected");
        const row = getRows()[index];
        updateHint(row);
        renderPreview(row);
    }

    function moveSelection(step: number) {
        const count = getRows().length;
        if (count === 0) {
            return;
        }
        armedId = null;
        selectedIndex = Math.max(0, Math.min(selectedIndex + step, count - 1));
        renderResults();
    }

    function emptyMessage(): string {
        const typed = !!input?.value.trim();
        if (scope === "tabs") {
            return typed ? "No matching tabs" : "No other tabs open";
        }
        if (scope === "marks") {
            return typed ? "No matching marks" : "No marks yet. Press Ctrl+B on any row, or Alt+Shift+B on any page, to mark it";
        }
        if (scope === "history") {
            return typed ? "Nothing in your history matches" : "Loading history...";
        }
        if (scope === "commands") {
            return "No matching commands";
        }
        return typed ? "No matching tabs, marks or history" : "Search tabs or the web. Put g, b or d before or after a search to pick the engine";
    }

    function renderResults() {
        if (!resultsEl) {
            return;
        }
        resultsEl.innerHTML = "";
        rowEls = [];

        const rows = getRows();
        updateHint(rows[selectedIndex]);
        renderPreview(rows[selectedIndex]);

        if (rows.length === 0) {
            const empty = document.createElement("div");
            empty.className = "empty";
            empty.textContent = emptyMessage();
            resultsEl.appendChild(empty);
            return;
        }

        const windows = windowLabels();
        let lastKind: ResultRow["kind"] | null = null;

        rows.forEach((row, i) => {
            if (row.kind !== lastKind) {
                const title = i === 0 || !detail ? sectionTitle(row.kind) : null;
                if (title) {
                    const header = document.createElement("div");
                    header.className = "section-header";
                    header.textContent = title;
                    resultsEl?.appendChild(header);
                }
                lastKind = row.kind;
            }

            const el = document.createElement("div");
            el.className = `row${i === selectedIndex ? " selected" : ""}`;
            if ((row.kind === "action" || row.kind === "cmd") && armedId === row.data.id) {
                el.classList.add("danger");
            }
            if (row.kind === "history" && row.child) {
                el.classList.add("child");
            }
            if (row.kind === "web") {
                el.append(...buildWebRow(row.data));
            } else if (row.kind === "util") {
                el.append(...buildUtilRow(row.data));
            } else if (row.kind === "action") {
                el.append(...buildActionRow(row.data));
            } else if (row.kind === "cmd") {
                el.append(...buildCommandRow(row.data));
            } else if (row.kind === "tab") {
                el.append(...buildTabRow(row.data, windows));
            } else if (row.kind === "mark") {
                el.append(...buildMarkRow(row.data));
            } else {
                el.append(...buildHistoryRow(row));
            }

            el.addEventListener("click", (e) => activateRow(row, e.shiftKey, isFlipKey(e)));
            const capturedIndex = i;
            el.addEventListener("mouseenter", () => selectRow(capturedIndex));

            resultsEl?.appendChild(el);
            rowEls.push(el);
        });

        rowEls[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }

    function renderPreview(row: ResultRow | undefined) {
        if (!previewEl || previewEl.getClientRects().length === 0) {
            // Hidden (setting off, compact width or a narrow window). Nothing to draw.
            return;
        }
        previewEl.innerHTML = "";

        const add = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
            const el = document.createElement(tag);
            el.className = cls;
            if (text !== undefined) {
                el.textContent = text;
            }
            previewEl?.appendChild(el);
            return el;
        };
        const meta = (pairs: [string, string | undefined][]) => {
            const dl = add("dl", "p-meta");
            for (const [k, v] of pairs) {
                if (!v) {
                    continue;
                }
                const dt = document.createElement("dt");
                dt.textContent = k;
                const dd = document.createElement("dd");
                dd.textContent = v;
                dl.append(dt, dd);
            }
        };
        const urlBlock = (url: string | undefined) => {
            if (!url) {
                return;
            }
            const el = add("div", "p-url");
            const host = hostLabel(url);
            const at = host ? url.indexOf(host) : -1;
            if (at === -1) {
                el.textContent = url;
                return;
            }
            const strong = document.createElement("strong");
            strong.textContent = host;
            el.append(url.slice(0, at), strong, url.slice(at + host.length));
        };
        const list = (title: string, items: string[], more = 0) => {
            if (items.length === 0) {
                return;
            }
            add("div", "p-label", title);
            const ul = add("ul", "p-list");
            for (const item of items) {
                const li = document.createElement("li");
                li.textContent = item;
                ul.appendChild(li);
            }
            if (more > 0) {
                const li = document.createElement("li");
                li.className = "more";
                li.textContent = `+${more} more`;
                ul.appendChild(li);
            }
        };

        if (!row) {
            add("div", "p-kind", "Search syntax");
            meta([
                ["rust book", "both words, any order"],
                ["'exact", "exact text"],
                ["^git", "starts with"],
                [".pdf$", "ends with"],
                ["!jira", "leave out"],
                ["% * ^ >", "tabs, marks, history, commands"],
                ["Ctrl+B", "mark or unmark a row"],
                ["Tab", "next scope"],
                ["Ctrl+J / K", "down / up"],
            ]);
            return;
        }

        if (row.kind === "tab") {
            const t = row.data;
            const windows = windowLabels();
            add("div", "p-kind", t.current ? "This tab" : "Open tab");
            add("div", "p-title", t.title || "Untitled");
            urlBlock(t.url);
            meta([
                ["Last used", t.current ? "now" : ago(t.lastAccessed)],
                ["Window", windows.size > 1 ? `${windows.get(t.windowId)} of ${windows.size}` : undefined],
                ["Position", t.index !== undefined ? `tab ${t.index + 1}` : undefined],
                [
                    "State",
                    [
                        isMarked(t.url) && "\u2605 marked",
                        t.pinned && "pinned",
                        t.audible && !t.muted && "playing sound",
                        t.muted && "muted",
                        t.discarded && "unloaded",
                    ]
                        .filter(Boolean)
                        .join(", ") || undefined,
                ],
            ]);
            add("div", "p-tip", "→ pin, mute, move, copy, unload or close it");
        } else if (row.kind === "history") {
            const h = row.data;
            if (h.site && !row.child) {
                add("div", "p-kind", "Site from history");
                add("div", "p-title", h.site.host);
                urlBlock(`${h.site.origin}/`);
                meta([
                    ["Pages", String(h.site.count)],
                    ["Last visit", ago(h.lastVisitTime)],
                ]);
                list(
                    "Recent pages",
                    h.site.pages.slice(0, 8).map((p) => p.title || displayUrl(p.url)),
                    Math.max(0, h.site.pages.length - 8),
                );
            } else {
                add("div", "p-kind", "History");
                add("div", "p-title", h.title || "Untitled");
                urlBlock(h.url);
                meta([
                    ["Last visit", ago(h.lastVisitTime)],
                    ["Visits", h.visitCount ? String(h.visitCount) : undefined],
                    ["Open", openTabFor(h.url) ? "yes, Enter switches to it" : undefined],
                ]);
            }
        } else if (row.kind === "mark") {
            const m = row.data;
            add("div", "p-kind", "\u2605 Mark");
            add("div", "p-title", m.title || displayUrl(m.url));
            urlBlock(m.url);
            meta([
                ["Marked", ago(m.createdAt)],
                ["Opened", m.openCount > 0 ? `${plural(m.openCount, "time")}, last ${ago(m.lastOpened)}` : "not yet"],
                ["Open", openTabFor(m.url) ? "yes, Enter switches to it" : undefined],
            ]);
            add("div", "p-tip", "Ctrl+B unmarks it \u2022 \u2192 copy options");
        } else if (row.kind === "web") {
            const w = row.data;
            add("div", "p-kind", w.id === "go" ? "Open address" : w.sub);
            add("div", "p-title", w.title);
            urlBlock(w.url);
        } else if (row.kind === "util") {
            add("div", "p-kind", row.data.action === "copy" ? "Copy" : "Open");
            add("div", "p-title", row.data.label);
            add("pre", "p-pre", row.data.value);
        } else if (row.kind === "action") {
            add("div", "p-kind", "Clean up");
            add("div", "p-title", row.data.label);
            add("div", "p-sub", row.data.sub);
            list(
                "Tabs that will close",
                row.data.tabs.slice(0, 10).map((t) => t.title || displayUrl(t.url)),
                Math.max(0, row.data.tabs.length - 10),
            );
        } else if (row.kind === "cmd") {
            add("div", "p-kind", detail?.tabId !== undefined ? "Tab action" : "Command");
            add("div", "p-title", row.data.title);
            add("div", "p-sub", row.data.sub);
        }
    }

    async function activateRow(row: ResultRow, exact = false, flip = false) {
        const stay = shouldStayOpen(flip);
        if (row.kind === "web") {
            await openWeb(row.data, exact, stay);
        } else if (row.kind === "util") {
            await runUtility(row.data, stay);
        } else if (row.kind === "action") {
            await runAction(row.data);
        } else if (row.kind === "cmd") {
            await runCommand(row.data, exact, stay);
        } else if (row.kind === "tab") {
            await switchToTab(row.data.id);
        } else if (row.kind === "mark") {
            void noteOpened(row.data.key);
            await openLink(row.data.url, row.data.title, stay);
        } else {
            await openHistoryEntry(row.data, exact, stay);
        }
    }

    async function runCommand(cmd: CommandRow, shift: boolean, stay: boolean) {
        if (cmd.confirm && armedId !== cmd.id) {
            armedId = cmd.id;
            renderResults();
            return;
        }
        armedId = null;
        // Shift+Enter on "Reload" skips the cache.
        if (shift && cmd.id === "tab-reload" && detail?.tabId !== undefined) {
            await tabCommand("hard-reload", detail.tabId, !!tabs.find((t) => t.id === detail?.tabId)?.current);
            return;
        }
        await cmd.run(stay);
    }

    /** Closes tabs through the background script and keeps the overlay open for the next one. */
    async function closeTabs(list: TabInfo[], selectAfter?: number) {
        const ids = list.map((t) => t.id);
        if (ids.length === 0) {
            return;
        }
        const previousIndex = selectedIndex;
        const reply = (await send({ action: "closeTabs", tabIds: ids })) as { success?: boolean } | undefined;
        if (!reply?.success) {
            flashHint("Couldn't close that tab");
            return;
        }

        const gone = new Set(ids);
        tabs = tabs.filter((t) => !gone.has(t.id));
        closedCount += ids.length;

        const name = (list[0]?.title || "tab").slice(0, 32);
        const what = ids.length === 1 ? `“${name}”` : plural(ids.length, "tab");
        flashHint(`✓ Closed ${what} (${closedCount} so far)  •  ${reopenKeyLabel()} to undo`);

        refresh(input?.value ?? "");
        const rows = getRows();
        let next = selectAfter === undefined ? -1 : rows.findIndex((r) => r.kind === "tab" && r.data.id === selectAfter);
        if (next === -1) {
            next = Math.max(defaultIndex(), Math.min(previousIndex, rows.length - 1));
        }
        selectedIndex = Math.max(0, Math.min(next, rows.length - 1));
        renderResults();
    }

    /** Closes one tab and moves the highlight to the tab below it, ready for the next. */
    async function closeSingleTab(tab: TabInfo) {
        if (tab.current) {
            flashHint(`That's the tab you're on. Close it with ${IS_MAC ? "⌘W" : "Ctrl+W"}`);
            return;
        }
        const rows = getRows();
        const at = rows.findIndex((r) => r.kind === "tab" && r.data.id === tab.id);
        const neighbour =
            rows.slice(at + 1).find((r) => r.kind === "tab") ??
            rows
                .slice(0, Math.max(at, 0))
                .reverse()
                .find((r) => r.kind === "tab");
        await closeTabs([tab], neighbour?.kind === "tab" ? neighbour.data.id : undefined);
    }

    async function runAction(action: ActionRow) {
        if (action.confirm && armedId !== action.id) {
            armedId = action.id;
            renderResults();
            return;
        }
        armedId = null;
        await closeTabs(action.tabs);
    }

    async function runUtility(action: UtilAction, stay = false) {
        if (action.action === "open") {
            if (stay) {
                await openInBackground(action.value, action.display ?? action.value);
                return;
            }
            hideOverlay();
            await send({ action: "openHistoryUrl", url: action.value });
            return;
        }
        await copyAndClose(action.value, action.display ?? action.value.replace(/\s*\n\s*/g, ", "));
    }

    /** Ctrl+Y: copy the highlighted row's link and keep going. */
    async function yankLink() {
        const row = getRows()[selectedIndex];
        const link = row ? rowLink(row) : null;
        if (!link) {
            flashHint("No link on this row");
            return;
        }
        const ok = await copyText(link);
        flashHint(ok ? `✓ Copied ${displayUrl(link).slice(0, TOAST_MAX_CHARS)}` : "Couldn't copy to the clipboard");
    }

    /** Quick copy: paste an email or link and its main result goes straight to the clipboard. */
    function maybeQuickCopy() {
        if (!settings?.quickCopy || !input || scope !== "all") {
            return;
        }
        const [primary] = buildUtilities(input.value, tabs);
        if (primary && primary.action === "copy") {
            void runUtility(primary);
        }
    }

    function showToast(text: string) {
        if (inPopup) {
            // Keep the popup up just long enough to read the confirmation.
            if (closeTimer) {
                clearTimeout(closeTimer);
            }
            flashHint(text);
            closeTimer = setTimeout(() => window.close(), 800);
            return;
        }
        if (!toastHost) {
            toastHost = document.createElement("div");
            toastHost.id = "tabdrift-toast-host";
            toastHost.style.cssText = "position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%); z-index: 2147483647; pointer-events: none;";
            const root = toastHost.attachShadow({ mode: "closed" });
            root.innerHTML = `${TOAST_STYLES}<div id="toast" role="status"></div>`;
            toastEl = root.getElementById("toast") as HTMLDivElement;
            document.documentElement.appendChild(toastHost);
        }
        if (!toastEl) {
            return;
        }
        toastEl.style.setProperty("--accent", settings?.accent ?? "#3b82f6");
        toastEl.textContent = text;
        // Force a reflow so the fade-in replays if a toast is already showing.
        toastEl.classList.remove("show");
        void toastEl.offsetWidth;
        toastEl.classList.add("show");

        if (toastTimer) {
            clearTimeout(toastTimer);
        }
        toastTimer = setTimeout(() => toastEl?.classList.remove("show"), TOAST_MS);
    }

    /** Opens a link in a background tab and leaves the overlay, the query and the highlight as they are. */
    async function openInBackground(url: string, label: string) {
        const reply = (await send({ action: "openHistoryUrl", url, background: true })) as { success?: boolean } | undefined;
        if (!reply?.success) {
            flashHint("Couldn't open that link");
            return;
        }
        openedCount += 1;
        flashHint(`✓ Opened “${label.slice(0, 32)}” in the background (${openedCount} so far)`);
    }

    /**
     * Opens a search or address in a new tab. Shift loads it over this page instead, like the address bar.
     * In a blank tab the two swap, since there's nothing to keep.
     */
    async function openWeb(row: WebRow, shift = false, stay = false) {
        if (shift || (loadHere && !stay)) {
            const here = loadHere ? !shift : true;
            hideOverlay();
            await send({ action: "openHistoryUrl", url: row.url, inCurrentTab: here });
            return;
        }
        if (stay) {
            await openInBackground(row.url, row.title);
            return;
        }
        hideOverlay();
        await send({ action: "openHistoryUrl", url: row.url });
    }

    async function switchToTab(tabId: number) {
        hideOverlay();
        // Like the address bar: switching away from an untouched new tab closes it.
        await send({ action: "switchTab", tabId, closeOrigin: onNewTab });
    }

    /** Opens a mark or page. If it's already open in a tab, switches there instead, like Firefox's "Switch to tab". */
    async function openLink(url: string | undefined, label: string | undefined, stay: boolean) {
        if (!url) {
            return;
        }
        if (stay) {
            await openInBackground(url, label || url);
            return;
        }
        const open = openTabFor(url);
        if (open) {
            await switchToTab(open.id);
            return;
        }
        hideOverlay();
        await send({ action: "openHistoryUrl", url, inCurrentTab: loadHere });
    }

    /** A site row opens the site's front page (the site sorts out login and redirects). Pass exact to open the last page instead. */
    async function openHistoryEntry(entry: HistoryInfo, exact = false, stay = false) {
        const url = entry.site && !exact ? `${entry.site.origin}/` : entry.url;
        await openLink(url, entry.title, stay);
    }

    function caretAtEnd(): boolean {
        return !!input && input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    }

    function handleKeydown(e: KeyboardEvent) {
        // Enter while composing text (IME) confirms the composition, not the row.
        if (e.isComposing) {
            return;
        }
        const ctrlOnly = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
        if (ctrlOnly && e.code === "KeyD") {
            // Always swallow it (it's "bookmark this page" in Firefox), but only act once per key press.
            e.preventDefault();
            const row = getRows()[selectedIndex];
            if (!e.repeat && row?.kind === "tab") {
                void closeSingleTab(row.data);
            } else if (!e.repeat && row?.kind === "mark") {
                void toggleRowMark(row);
            }
        } else if (ctrlOnly && e.code === "KeyB") {
            // Firefox's bookmarks sidebar key. Here it marks the highlighted row.
            e.preventDefault();
            if (!e.repeat) {
                void toggleRowMark(getRows()[selectedIndex]);
            }
        } else if (ctrlOnly && (e.code === "KeyJ" || e.code === "KeyN")) {
            // Telescope's insert-mode keys. Ctrl+N is reserved by Firefox on web pages, but works in the popup.
            e.preventDefault();
            moveSelection(1);
        } else if (ctrlOnly && (e.code === "KeyK" || e.code === "KeyP")) {
            e.preventDefault();
            moveSelection(-1);
        } else if (ctrlOnly && e.code === "KeyY") {
            e.preventDefault();
            if (!e.repeat) {
                void yankLink();
            }
        } else if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            if (detail) {
                closeDetail();
            }
            cycleScope(e.shiftKey ? -1 : 1);
        } else if (e.key === "Backspace" && scope !== "all" && input?.value === "" && !e.repeat) {
            // Like deleting Telescope's prompt prefix: back to searching everything.
            e.preventDefault();
            setScope("all");
        } else if (e.key === "Escape") {
            e.preventDefault();
            if (detail) {
                closeDetail();
            } else {
                hideOverlay();
            }
        } else if (e.key === "Enter") {
            e.preventDefault();
            const rows = getRows();
            const target = rows[selectedIndex];
            if (target) {
                activateRow(target, e.shiftKey, isFlipKey(e));
            }
        } else if (e.key === "ArrowRight" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            // Only steals the key once the caret is at the end, where it would do nothing anyway.
            const row = getRows()[selectedIndex];
            if (!row || !caretAtEnd() || detail) {
                return;
            }
            if (row.kind === "history") {
                e.preventDefault();
                // First press lists a site's pages, the next one opens the copy options.
                if (row.data.site && !row.child && expandedHost !== row.data.site.host) {
                    expandSite(row.data);
                } else {
                    openDetail(row.data.url, row.data.site?.host ?? hostLabel(row.data.url));
                }
            } else if (row.kind === "tab") {
                e.preventDefault();
                openTabDetail(row.data);
            } else if (row.kind === "mark") {
                e.preventDefault();
                openDetail(row.data.url, hostLabel(row.data.url));
            }
        } else if (e.key === "ArrowLeft") {
            const row = getRows()[selectedIndex];
            if (detail) {
                e.preventDefault();
                closeDetail();
            } else if (expandedHost && row?.kind === "history" && (row.child || row.data.site?.host === expandedHost)) {
                e.preventDefault();
                collapseSite();
            }
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            moveSelection(1);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            moveSelection(-1);
        } else if (e.key === "PageDown") {
            e.preventDefault();
            moveSelection(PAGE_JUMP);
        } else if (e.key === "PageUp") {
            e.preventDefault();
            moveSelection(-PAGE_JUMP);
        }
    }

    const controller: PaletteController = { show: (text) => void showOverlay(text) };

    if (inPopup) {
        void showOverlay();
        return controller;
    }

    browser.runtime.onMessage.addListener((message) => {
        if (message?.action === "showTabSearch") {
            if (overlayActive) {
                hideOverlay();
            } else {
                showOverlay();
            }
        } else if (message?.action === "showToast" && typeof message.text === "string") {
            showToast(message.text);
        }
    });
    return controller;
}

const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>`;
const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm10 17-5.6-5.6"/></svg>`;
const GLOBE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>`;
const OPEN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`;

const SVG = (body: string, width = 2) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ARROW_ICON = SVG(`<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>`);
const PIN_ICON = SVG(`<path d="M9 4h6l-1 6 4 4H6l4-4-1-6Z"/><path d="M12 14v6"/>`);
const SOUND_ICON = SVG(`<path d="M4 10v4h4l5 4V6L8 10H4Z"/><path d="M16.5 9a4 4 0 0 1 0 6"/><path d="M19 6.5a8 8 0 0 1 0 11"/>`);
const MUTE_ICON = SVG(`<path d="M4 10v4h4l5 4V6L8 10H4Z"/><path d="m17 10 4 4"/><path d="m21 10-4 4"/>`);
const RELOAD_ICON = SVG(`<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>`);
const WINDOW_ICON = SVG(`<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>`);
const MOON_ICON = SVG(`<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>`);
const STAR_ICON = SVG(`<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"/>`);
const LINK_ICON = SVG(`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`);
const SORT_ICON = SVG(`<path d="M4 6h10"/><path d="M4 12h7"/><path d="M4 18h4"/><path d="M18 5v14"/><path d="m15 16 3 3 3-3"/>`);
const GEAR_ICON = SVG(
    `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>`,
);
const CLOCK_ICON = SVG(`<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`);
const DOT_ICON = SVG(`<circle cx="12" cy="12" r="2" fill="currentColor"/>`);

const TOAST_STYLES = `
<style>
  #toast {
    --accent: #3b82f6;
    padding: 10px 16px;
    border-radius: 12px;
    background: rgba(30, 30, 34, 0.86);
    backdrop-filter: blur(20px) saturate(160%);
    -webkit-backdrop-filter: blur(20px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.5);
    color: #f1f1f3;
    font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    max-width: 80vw;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  #toast::before { content: "\\2713"; color: var(--accent); font-weight: 700; margin-right: 8px; }
  #toast.show { opacity: 1; transform: translateY(0); }
</style>
`;

const MARKUP = `
  <div id="scrim"></div>
  <div id="wrapper" data-position="center">
    <div id="card">
      <div id="input-wrap">
        <svg id="search-icon" viewBox="0 0 24 24" width="18" height="18">
          <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm10 17-5.6-5.6" />
        </svg>
        <input id="search-input" type="text" placeholder="" autocomplete="off" spellcheck="false" />
        <button id="settings-btn" title="Settings" type="button">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.14-1.4l2.03-1.58-2-3.46-2.4.96a7.5 7.5 0 0 0-2.42-1.4L14.1 3h-4.2l-.37 2.52a7.5 7.5 0 0 0-2.4 1.4l-2.42-.96-2 3.46L4.74 10.6A7.4 7.4 0 0 0 4.6 12c0 .47.05.94.14 1.4l-2.03 1.58 2 3.46 2.4-.96a7.5 7.5 0 0 0 2.42 1.4L10.9 21h4.2l.38-2.52a7.5 7.5 0 0 0 2.4-1.4l2.42.96 2-3.46-2.03-1.58c.09-.46.14-.93.14-1.4Z" />
          </svg>
        </button>
      </div>
      <div id="scopes" role="tablist" aria-label="What to search"></div>
      <div id="body">
        <div id="results"></div>
        <aside id="preview" aria-live="polite"></aside>
      </div>
      <div id="footer">
        <span id="hint"></span>
        <span id="brand">Tabdrift</span>
      </div>
    </div>
  </div>
`;

const STYLES = `
<style>
  :host, * { box-sizing: border-box; }

  #scrim {
    position: fixed;
    inset: 0;
    background: rgba(10, 10, 14, 0.35);
    backdrop-filter: blur(3px);
    opacity: 0;
    transition: opacity 0.15s ease;
    pointer-events: none;
  }
  #scrim.open { opacity: 1; pointer-events: auto; }

  #wrapper {
    --accent: #3b82f6;
    position: fixed;
    inset: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 10vh 20px;
    pointer-events: none;
  }
  #wrapper[data-position="top"] { align-items: flex-start; }
  #wrapper[data-position="bottom"] { align-items: flex-end; }

  #card {
    width: 640px;
    max-width: 94vw;
    max-height: 72vh;
    display: flex;
    flex-direction: column;
    border-radius: 16px;
    overflow: hidden;
    background: rgba(30, 30, 34, 0.72);
    backdrop-filter: blur(24px) saturate(160%);
    -webkit-backdrop-filter: blur(24px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow:
      0 24px 60px -12px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(255, 255, 255, 0.04) inset;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #f1f1f3;
    opacity: 0;
    transform: scale(0.97) translateY(-6px);
    transition: opacity 0.15s ease, transform 0.15s ease;
    pointer-events: auto;
  }
  #card.open { opacity: 1; transform: scale(1) translateY(0); }
  #wrapper[data-width="wide"] #card { width: 880px; max-height: 76vh; }
  #wrapper[data-width="full"] #card { width: min(1240px, 94vw); max-height: 82vh; }

  #input-wrap {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  #search-icon { color: var(--accent); flex-shrink: 0; }
  #search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 17px;
    color: #f8f8f8;
    letter-spacing: 0.01em;
  }
  #search-input::placeholder { color: rgba(255, 255, 255, 0.4); }

  #scopes {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .scope {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: none;
    border-radius: 999px;
    background: none;
    color: rgba(255, 255, 255, 0.5);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.1s ease, color 0.1s ease;
  }
  .scope:hover { color: rgba(255, 255, 255, 0.85); background: rgba(255, 255, 255, 0.06); }
  .scope.on { color: #fff; background: color-mix(in srgb, var(--accent) 34%, transparent); }
  .scope kbd {
    font: 600 10.5px/1 ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;
    padding: 2px 5px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    color: inherit;
    opacity: 0.8;
  }
  .scope-tip { margin-left: auto; padding-left: 12px; font-size: 11px; color: rgba(255, 255, 255, 0.3); white-space: nowrap; }

  #body { display: flex; min-height: 0; flex: 1; }
  #results {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    max-height: 50vh;
  }
  #wrapper[data-width="wide"] #results { max-height: 58vh; }
  #wrapper[data-width="full"] #results { max-height: 66vh; }
  /* With the preview pane the card keeps one height, so it doesn't jump around as you type. */
  #wrapper[data-preview="on"][data-width="wide"] #body { flex: none; height: 54vh; }
  #wrapper[data-preview="on"][data-width="full"] #body { flex: none; height: 62vh; }
  #wrapper[data-mode="popup"][data-preview="on"] #body { height: auto; }
  #wrapper[data-preview="on"] #results { max-height: none; }

  mark {
    background: none;
    color: color-mix(in srgb, var(--accent) 55%, #fff);
    font-weight: 700;
  }
  .url mark { color: color-mix(in srgb, var(--accent) 70%, #fff); font-weight: 600; }

  /* Preview pane, like Telescope's: details of the highlighted row. */
  #preview {
    display: none;
    flex-direction: column;
    gap: 10px;
    width: 36%;
    flex-shrink: 0;
    padding: 16px 18px;
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.12);
    overflow-y: auto;
    font-size: 12.5px;
    color: rgba(255, 255, 255, 0.75);
  }
  #wrapper[data-preview="on"] #preview { display: flex; }
  @media (max-width: 960px) {
    #wrapper:not([data-mode="popup"]) #preview { display: none !important; }
  }
  .p-kind { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--accent); }
  .p-title { font-size: 15px; font-weight: 600; line-height: 1.35; color: #f6f6f8; overflow-wrap: anywhere; }
  .p-sub { line-height: 1.45; color: rgba(255, 255, 255, 0.6); overflow-wrap: anywhere; }
  .p-url {
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Liberation Mono", monospace;
    font-size: 11.5px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.5);
    overflow-wrap: anywhere;
    max-height: 7.5em;
    overflow: hidden;
  }
  .p-url strong { color: rgba(255, 255, 255, 0.9); font-weight: 600; }
  .p-meta { display: grid; grid-template-columns: max-content 1fr; gap: 5px 14px; margin: 2px 0 0; }
  .p-meta dt { color: rgba(255, 255, 255, 0.38); font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 11.5px; }
  .p-meta dd { margin: 0; color: rgba(255, 255, 255, 0.78); overflow-wrap: anywhere; }
  .p-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: rgba(255, 255, 255, 0.35); margin-top: 4px; }
  .p-list { margin: 0; padding: 0 0 0 14px; display: flex; flex-direction: column; gap: 3px; }
  .p-list li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .p-list li.more { list-style: none; margin-left: -14px; color: rgba(255, 255, 255, 0.4); }
  .p-pre {
    margin: 0;
    padding: 10px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.25);
    font: 11.5px/1.5 ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 40vh;
    overflow: auto;
  }
  .p-tip { margin-top: auto; padding-top: 8px; font-size: 11.5px; color: rgba(255, 255, 255, 0.38); }
  #results::-webkit-scrollbar { width: 8px; }
  #results::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
    border-radius: 8px;
  }

  .empty {
    padding: 48px 20px;
    text-align: center;
    color: rgba(255, 255, 255, 0.45);
    font-size: 14px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 20px;
    cursor: pointer;
    transition: background 0.08s ease;
  }
  .row:hover { background: rgba(255, 255, 255, 0.05); }
  .row.child { padding-left: 42px; }
  .row.child .title { font-size: 13px; }
  .row.selected { background: color-mix(in srgb, var(--accent) 28%, transparent); }

  .section-header {
    padding: 8px 20px 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: rgba(255, 255, 255, 0.35);
  }

  .badge {
    flex-shrink: 0;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10.5px;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.5);
  }

  .badge.soft { background: none; color: rgba(255, 255, 255, 0.38); padding: 2px 2px; }
  .badge.star { background: rgba(250, 204, 21, 0.14); color: #fcd34d; }
  .row.child .util-icon { color: rgba(255, 255, 255, 0.3); }

  .favicon { width: 18px; height: 18px; flex-shrink: 0; border-radius: 3px; }

  .util-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
  }
  .util-icon svg { width: 16px; height: 16px; }
  .row.danger { background: rgba(239, 68, 68, 0.22); }
  .row.danger .util-icon { color: #f87171; }
  .row.danger .title { color: #fecaca; }

  .close-btn {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s ease, background 0.1s ease, color 0.1s ease;
  }
  .close-btn svg { width: 13px; height: 13px; }
  .row:hover .close-btn, .row.selected .close-btn { opacity: 1; }
  .close-btn:hover { background: rgba(239, 68, 68, 0.28); color: #fecaca; }
  .title.mono {
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Liberation Mono", monospace;
    font-size: 13px;
  }

  .text { flex: 1; min-width: 0; }
  .title {
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .url {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.45);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
  }

  #footer {
    display: flex;
    justify-content: space-between;
    padding: 9px 20px;
    font-size: 11.5px;
    color: rgba(255, 255, 255, 0.4);
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  #hint { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #brand { color: var(--accent); font-weight: 600; flex-shrink: 0; padding-left: 12px; }

  /* Toolbar popup: the popup window is the frame, so the card fills it with no motion or blur. */
  #wrapper[data-mode="popup"] { position: static; padding: 0; display: block; }
  #wrapper[data-mode="popup"] #card {
    width: 600px;
    max-width: none;
    max-height: none;
    border: none;
    border-radius: 0;
    background: #1e1e22;
    box-shadow: none;
    opacity: 1;
    transform: none;
    transition: none;
  }
  #wrapper[data-mode="popup"][data-width="wide"] #card,
  #wrapper[data-mode="popup"][data-width="full"] #card { width: 780px; }
  #wrapper[data-mode="popup"] #results,
  #wrapper[data-mode="popup"] #preview { height: 420px; max-height: none; }

  #settings-btn {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.4);
    cursor: pointer;
    padding: 4px;
    display: flex;
    flex-shrink: 0;
    border-radius: 6px;
    transition: color 0.1s ease, background 0.1s ease;
  }
  #settings-btn:hover {
    color: var(--accent);
    background: rgba(255, 255, 255, 0.08);
  }
</style>
`;
