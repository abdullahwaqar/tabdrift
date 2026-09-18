import Fuse from "fuse.js";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { copyText } from "../lib/clipboard";
import type { TabSearchSettings } from "../lib/settings";
import { getSettings, onSettingsChanged } from "../lib/settings";
import type { UtilAction } from "../lib/utils";
import { buildUtilities, duplicateKey } from "../lib/utils";

interface TabInfo {
    id: number;
    title?: string;
    url?: string;
    favIconUrl?: string;
    pinned?: boolean;
    active?: boolean;
    lastAccessed?: number;
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
    url?: string;
    lastVisitTime: number;
}

type ResultRow =
    | { kind: "util"; data: UtilAction }
    | { kind: "action"; data: ActionRow }
    | { kind: "tab"; data: TabInfo }
    | { kind: "history"; data: HistoryInfo };

const HISTORY_DEBOUNCE_MS = 120;
const HISTORY_LIMIT = 6;
const TOAST_MS = 1800;
const TOAST_MAX_CHARS = 56;
const HINT_FLASH_MS = 2600;
const IS_MAC = /mac/i.test(navigator.platform);
const GUARDED_KEY_EVENTS = ["keydown", "keypress", "keyup"] as const;
const GUARDED_FOCUS_EVENTS = ["focusin", "focus"] as const;
const REFOCUS_LIMIT = 10;
const REFOCUS_WINDOW_MS = 1000;

const FUSE_OPTIONS = {
    keys: [
        { name: "title", weight: 0.6 },
        { name: "url", weight: 0.4 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
};

export default defineUnlistedScript(() => {
    const win = window as unknown as { __tabSearchInjected?: boolean };
    if (win.__tabSearchInjected) {
        return;
    }
    win.__tabSearchInjected = true;

    let host: HTMLDivElement | null = null;
    let shadow: ShadowRoot | null = null;
    let settings: TabSearchSettings | null = null;

    let tabs: TabInfo[] = [];
    let filtered: TabInfo[] = [];
    let historyResults: HistoryInfo[] = [];
    let utilities: UtilAction[] = [];
    let actions: ActionRow[] = [];
    let armedActionId: ActionRow["id"] | null = null;
    let closedCount = 0;
    let hintFlash: string | null = null;
    let hintFlashTimer: ReturnType<typeof setTimeout> | null = null;
    let selectedIndex = 0;
    let historyTimer: ReturnType<typeof setTimeout> | null = null;
    let historyRequestId = 0;

    let input: HTMLInputElement | null = null;
    let resultsEl: HTMLDivElement | null = null;
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

    onSettingsChanged((next) => {
        settings = next;
        if (cardEl) {
            applyPositionAndAccent();
        }
    });

    function ensureOverlay() {
        if (host) {
            return;
        }

        host = document.createElement("div");
        host.id = "tabdrift-overlay-host";
        host.style.cssText = "position: fixed; inset: 0; z-index: 2147483647;";
        document.documentElement.appendChild(host);

        shadow = host.attachShadow({ mode: "closed" });
        shadow.innerHTML = STYLES + MARKUP;

        cardEl = shadow.getElementById("card") as HTMLDivElement;
        input = shadow.getElementById("search-input") as HTMLInputElement;
        resultsEl = shadow.getElementById("results") as HTMLDivElement;
        hintEl = shadow.getElementById("hint") as HTMLSpanElement;
        const scrim = shadow.getElementById("scrim") as HTMLDivElement;
        const settingsBtn = shadow.getElementById("settings-btn") as HTMLButtonElement;

        settingsBtn.addEventListener("click", () => {
            browser.runtime.sendMessage({ action: "openOptions" });
        });
        input.addEventListener("input", () => filterTabs(input?.value ?? ""));
        input.addEventListener("paste", () => setTimeout(maybeQuickCopy, 0));
        scrim.addEventListener("click", hideOverlay);
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

    function applyPositionAndAccent() {
        if (!shadow || !settings) {
            return;
        }
        const wrapper = shadow.getElementById("wrapper") as HTMLDivElement;
        wrapper.dataset.position = settings.position;
        wrapper.style.setProperty("--accent", settings.accent);
    }

    async function showOverlay() {
        ensureOverlay();
        settings = await getSettings();
        applyPositionAndAccent();

        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        if (!overlayActive) {
            const active = document.activeElement;
            previouslyFocused = active instanceof HTMLElement && active !== document.body && active !== host ? active : null;
            overlayActive = true;
            refocusTimes = [];
            setPageInert(true);
            addGuards();
        }

        if (host) {
            host.style.display = "block";
        }
        shadow?.getElementById("scrim")?.classList.add("open");
        cardEl?.classList.add("open");

        // Take focus straight away, before the tab list has even loaded.
        if (input) {
            input.value = "";
            input.focus();
        }

        tabs = await browser.runtime.sendMessage({ action: "getTabs" });
        closedCount = 0;
        hintFlash = null;
        historyResults = [];
        filterTabs(input?.value ?? "");
    }

    function hideOverlay() {
        if (!host) {
            return;
        }
        if (historyTimer) {
            clearTimeout(historyTimer);
            historyTimer = null;
        }
        historyRequestId++;

        overlayActive = false;
        removeGuards();
        setPageInert(false);
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

    /** Open tabs, most recently used first, without the tab the overlay is in. */
    function recentTabs(): TabInfo[] {
        return tabs.filter((t) => !t.current).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
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

    function plural(n: number, word: string): string {
        return `${n} ${word}${n === 1 ? "" : "s"}`;
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

    function filterTabs(query: string) {
        const q = query.trim();
        armedActionId = null;

        if (!q) {
            const listing = settings?.listOnOpen ?? true;
            filtered = listing ? recentTabs() : [];
            actions = listing ? computeActions("") : [];
            historyResults = [];
            utilities = [];
            selectedIndex = defaultIndex();
            renderResults();
            return;
        }

        const tabFuse = new Fuse(tabs, FUSE_OPTIONS);
        filtered = tabFuse.search(q).map((r) => r.item);
        utilities = buildUtilities(q, tabs);
        actions = computeActions(q);
        selectedIndex = defaultIndex();
        renderResults();
        queueHistorySearch(q);
    }

    function queueHistorySearch(query: string) {
        if (historyTimer) {
            clearTimeout(historyTimer);
        }
        const requestId = ++historyRequestId;
        historyTimer = setTimeout(async () => {
            const raw = (await browser.runtime.sendMessage({ action: "searchHistory", query })) as HistoryInfo[];
            // Bail if the input changed (or overlay closed) while this was in flight.
            if (requestId !== historyRequestId || input?.value.trim() !== query) {
                return;
            }

            const openUrls = new Set(tabs.map((t) => t.url));
            const candidates = raw.filter((h) => h.url && !openUrls.has(h.url));

            const historyFuse = new Fuse(candidates, FUSE_OPTIONS);
            historyResults = historyFuse
                .search(query)
                .slice(0, HISTORY_LIMIT)
                .map((r) => r.item);

            renderResults();
        }, HISTORY_DEBOUNCE_MS);
    }

    function getRows(): ResultRow[] {
        return [
            ...utilities.map((data): ResultRow => ({ kind: "util", data })),
            ...actions.map((data): ResultRow => ({ kind: "action", data })),
            ...filtered.map((data): ResultRow => ({ kind: "tab", data })),
            ...historyResults.map((data): ResultRow => ({ kind: "history", data })),
        ];
    }

    function sectionTitle(kind: ResultRow["kind"]): string | null {
        if (kind === "util") {
            return "Utilities";
        }
        if (kind === "action") {
            return "Clean up";
        }
        if (kind === "history") {
            return "From history";
        }
        if (!input?.value.trim()) {
            return `Recent tabs \u00b7 ${filtered.length}`;
        }
        // Tabs only need a label when something else sits above them.
        return utilities.length > 0 || actions.length > 0 ? `Open tabs \u00b7 ${filtered.length}` : null;
    }

    function closeKeyLabel(): string {
        return "Ctrl+D";
    }

    function reopenKeyLabel(): string {
        return IS_MAC ? "\u2318\u21e7T" : "Ctrl+Shift+T";
    }

    function updateHint(row: ResultRow | undefined) {
        if (!hintEl) {
            return;
        }
        if (hintFlash) {
            hintEl.textContent = hintFlash;
            return;
        }

        const dot = " \u00a0\u2022\u00a0 ";
        const parts = ["\u2191\u2193 navigate"];
        if (row?.kind === "util") {
            parts.push(`Enter ${row.data.action === "copy" ? "copy" : "open"}`);
        } else if (row?.kind === "action") {
            parts.push(armedActionId === row.data.id ? "Enter again to close them" : "Enter close");
        } else if (row?.kind === "tab") {
            parts.push("Enter switch");
            if (!row.data.current) {
                parts.push(`${closeKeyLabel()} close tab`);
            }
        } else if (row?.kind === "history") {
            parts.push("Enter open");
        } else {
            parts.push("Enter switch");
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

    function buildUtilRow(action: UtilAction): HTMLElement[] {
        const icon = document.createElement("span");
        icon.className = "util-icon";
        icon.innerHTML = action.action === "copy" ? COPY_ICON : OPEN_ICON;

        const text = document.createElement("div");
        text.className = "text";

        const title = document.createElement("div");
        title.className = "title mono";
        title.textContent = action.display ?? action.value.replace(/\s*\n\s*/g, ", ");

        const label = document.createElement("div");
        label.className = "url";
        label.textContent = action.label;

        text.append(title, label);

        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = action.action;

        return [icon, text, badge];
    }

    function buildActionRow(action: ActionRow): HTMLElement[] {
        const armed = armedActionId === action.id;

        const icon = document.createElement("span");
        icon.className = "util-icon";
        icon.innerHTML = TRASH_ICON;

        const text = document.createElement("div");
        text.className = "text";

        const title = document.createElement("div");
        title.className = "title";
        title.textContent = armed ? `Close ${plural(action.tabs.length, "tab")}? Press Enter again` : action.label;

        const sub = document.createElement("div");
        sub.className = "url";
        sub.textContent = armed ? `Undo with ${reopenKeyLabel()}` : action.sub;

        text.append(title, sub);

        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "close";

        return [icon, text, badge];
    }

    function buildEntryRow(row: Exclude<ResultRow, { kind: "util" | "action" }>): HTMLElement[] {
        const icon = document.createElement("img");
        icon.className = "favicon";
        icon.src = row.kind === "tab" ? row.data.favIconUrl || "" : "";
        icon.addEventListener("error", () => (icon.style.visibility = "hidden"));
        if (row.kind === "history") {
            icon.style.visibility = "hidden";
        }

        const text = document.createElement("div");
        text.className = "text";

        const title = document.createElement("div");
        title.className = "title";
        title.textContent = row.data.title || "Untitled";

        const url = document.createElement("div");
        url.className = "url";
        url.textContent = row.data.url || "";

        text.append(title, url);
        const parts: HTMLElement[] = [icon, text];

        if (row.kind === "history") {
            const badge = document.createElement("span");
            badge.className = "badge";
            badge.textContent = "history";
            parts.push(badge);
        }

        if (row.kind === "tab") {
            if (row.data.pinned || row.data.current) {
                const badge = document.createElement("span");
                badge.className = "badge";
                badge.textContent = row.data.current ? "this tab" : "pinned";
                parts.push(badge);
            }
            if (!row.data.current) {
                const closeBtn = document.createElement("button");
                closeBtn.type = "button";
                closeBtn.className = "close-btn";
                closeBtn.title = `Close tab (${closeKeyLabel()})`;
                closeBtn.setAttribute("aria-label", "Close tab");
                closeBtn.innerHTML = CLOSE_ICON;
                closeBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    void closeSingleTab(row.data);
                });
                parts.push(closeBtn);
            }
        }
        return parts;
    }

    /** Moves the highlight without rebuilding the list, so a click can't land on a row that was just replaced. */
    function selectRow(index: number) {
        if (index === selectedIndex) {
            return;
        }
        if (armedActionId) {
            armedActionId = null;
            renderResults();
        }
        rowEls[selectedIndex]?.classList.remove("selected");
        selectedIndex = index;
        rowEls[index]?.classList.add("selected");
        updateHint(getRows()[index]);
    }

    function renderResults() {
        if (!resultsEl) {
            return;
        }
        resultsEl.innerHTML = "";
        rowEls = [];

        const rows = getRows();
        updateHint(rows[selectedIndex]);

        if (rows.length === 0) {
            const empty = document.createElement("div");
            empty.className = "empty";
            empty.textContent = input?.value.trim() ? "No matching tabs or history" : "Start typing, or paste an email or link";
            resultsEl.appendChild(empty);
            return;
        }

        rowEls = [];
        let lastKind: ResultRow["kind"] | null = null;

        rows.forEach((row, i) => {
            if (row.kind !== lastKind) {
                const title = sectionTitle(row.kind);
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
            if (row.kind === "action" && armedActionId === row.data.id) {
                el.classList.add("danger");
            }
            if (row.kind === "util") {
                el.append(...buildUtilRow(row.data));
            } else if (row.kind === "action") {
                el.append(...buildActionRow(row.data));
            } else {
                el.append(...buildEntryRow(row));
            }

            el.addEventListener("click", () => activateRow(row));
            const capturedIndex = i;
            el.addEventListener("mouseenter", () => selectRow(capturedIndex));

            resultsEl?.appendChild(el);
            rowEls.push(el);
        });

        rowEls[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }

    async function activateRow(row: ResultRow) {
        if (row.kind === "util") {
            await runUtility(row.data);
        } else if (row.kind === "action") {
            await runAction(row.data);
        } else if (row.kind === "tab") {
            await switchToTab(row.data.id);
        } else {
            await openHistoryEntry(row.data.url);
        }
    }

    /** Closes tabs through the background script and keeps the overlay open for the next one. */
    async function closeTabs(list: TabInfo[], selectAfter?: number) {
        const ids = list.map((t) => t.id);
        if (ids.length === 0) {
            return;
        }
        const previousIndex = selectedIndex;
        const reply = (await browser.runtime.sendMessage({ action: "closeTabs", tabIds: ids })) as { success?: boolean } | undefined;
        if (!reply?.success) {
            flashHint("Couldn't close that tab");
            return;
        }

        const gone = new Set(ids);
        tabs = tabs.filter((t) => !gone.has(t.id));
        closedCount += ids.length;

        const name = (list[0]?.title || "tab").slice(0, 32);
        const what = ids.length === 1 ? `\u201c${name}\u201d` : plural(ids.length, "tab");
        flashHint(`\u2713 Closed ${what} (${closedCount} so far) \u00a0\u2022\u00a0 ${reopenKeyLabel()} to undo`);

        filterTabs(input?.value ?? "");
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
            flashHint(`That's the tab you're on. Close it with ${IS_MAC ? "\u2318W" : "Ctrl+W"}`);
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
        if (action.confirm && armedActionId !== action.id) {
            armedActionId = action.id;
            renderResults();
            return;
        }
        armedActionId = null;
        await closeTabs(action.tabs);
    }

    async function runUtility(action: UtilAction) {
        if (action.action === "open") {
            hideOverlay();
            await browser.runtime.sendMessage({ action: "openHistoryUrl", url: action.value });
            return;
        }

        const ok = await copyText(action.value);
        hideOverlay();
        const shown = action.display ?? action.value.replace(/\s*\n\s*/g, ", ");
        const short = shown.length > TOAST_MAX_CHARS ? `${shown.slice(0, TOAST_MAX_CHARS - 1)}\u2026` : shown;
        showToast(ok ? `Copied ${short}` : "Couldn't copy to the clipboard");
    }

    /** Quick copy: paste an email or link and its main result goes straight to the clipboard. */
    function maybeQuickCopy() {
        if (!settings?.quickCopy || !input) {
            return;
        }
        const [primary] = buildUtilities(input.value, tabs);
        if (primary && primary.action === "copy") {
            void runUtility(primary);
        }
    }

    function showToast(text: string) {
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

    async function switchToTab(tabId: number) {
        hideOverlay();
        await browser.runtime.sendMessage({ action: "switchTab", tabId });
    }

    async function openHistoryEntry(url: string | undefined) {
        if (!url) {
            return;
        }
        hideOverlay();
        await browser.runtime.sendMessage({ action: "openHistoryUrl", url });
    }

    function handleKeydown(e: KeyboardEvent) {
        // Enter while composing text (IME) confirms the composition, not the row.
        if (e.isComposing) {
            return;
        }
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === "KeyD") {
            // Always swallow it (it's "bookmark this page" in Firefox), but only act once per key press.
            e.preventDefault();
            const row = getRows()[selectedIndex];
            if (!e.repeat && row?.kind === "tab") {
                void closeSingleTab(row.data);
            }
        } else if (e.key === "Escape") {
            e.preventDefault();
            hideOverlay();
        } else if (e.key === "Enter") {
            e.preventDefault();
            const rows = getRows();
            const target = rows[selectedIndex];
            if (target) {
                activateRow(target);
            }
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            armedActionId = null;
            selectedIndex = Math.min(selectedIndex + 1, getRows().length - 1);
            renderResults();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            armedActionId = null;
            selectedIndex = Math.max(selectedIndex - 1, 0);
            renderResults();
        }
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
});

const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>`;
const OPEN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`;

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
        <input id="search-input" type="text" placeholder="Search tabs, or paste an email or link..." autocomplete="off" spellcheck="false" />
        <button id="settings-btn" title="Settings" type="button">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.14-1.4l2.03-1.58-2-3.46-2.4.96a7.5 7.5 0 0 0-2.42-1.4L14.1 3h-4.2l-.37 2.52a7.5 7.5 0 0 0-2.4 1.4l-2.42-.96-2 3.46L4.74 10.6A7.4 7.4 0 0 0 4.6 12c0 .47.05.94.14 1.4l-2.03 1.58 2 3.46 2.4-.96a7.5 7.5 0 0 0 2.42 1.4L10.9 21h4.2l.38-2.52a7.5 7.5 0 0 0 2.4-1.4l2.42.96 2-3.46-2.03-1.58c.09-.46.14-.93.14-1.4Z" />
          </svg>
        </button>
      </div>
      <div id="results"></div>
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
    max-width: 92vw;
    max-height: 70vh;
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

  #results {
    overflow-y: auto;
    max-height: 50vh;
  }
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
    font-size: 10.5px;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.5);
  }

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
  #brand { color: var(--accent); font-weight: 600; }

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
