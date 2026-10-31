import { defineBackground } from "wxt/utils/define-background";
import { copyText } from "../lib/clipboard";
import type { TabCommandId, TabCommandReply } from "../lib/commands";
import { canMark, toggleMark } from "../lib/marks";
import type { Prepared, Ranked } from "../lib/match";
import { displayUrl, historyBoost, hostOf, plainWords, prepare, rankPrepared } from "../lib/match";
import { getNewTabSettings } from "../lib/newtab/settings";
import type { TimerState } from "../lib/newtab/timer-state";
import { readTimer, settle, TIMER_ALARM_PREFIX, TIMER_KEY, writeTimer } from "../lib/newtab/timer-state";
import { COMMAND_NAME, getSettings } from "../lib/settings";
import { cleanUrl } from "../lib/utils";

const COPY_CLEAN_URL_COMMAND = "copy-clean-url";
const TOGGLE_MARK_COMMAND = "toggle-mark";
const MENU_COPY_CLEAN_LINK = "tabdrift-copy-clean-link";
const DEFAULT_HISTORY_RESULTS = 25;
const MAX_HISTORY_RESULTS = 300;
/** Recent pages kept around for fuzzy matching, since Firefox's own history search only finds exact words. */
const RECENT_HISTORY_POOL = 2000;
/** How often the recency part of the history scores is brought up to date. */
const BOOST_REFRESH_MS = 5 * 60_000;

export default defineBackground(() => {
    applyStoredShortcut();
    syncAllPopups();
    watchHistory();
    void scheduleTimerAlarm();

    browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[TIMER_KEY]) {
            void scheduleTimerAlarm();
        }
    });
    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name.startsWith(TIMER_ALARM_PREFIX)) {
            void finishTimer(Number(alarm.name.slice(TIMER_ALARM_PREFIX.length)));
        }
    });

    // Only fires on tabs without the popup set, i.e. normal pages.
    browser.action.onClicked.addListener((tab) => {
        if (tab.id !== undefined && isRestrictedUrl(tab.url)) {
            // A page we missed. No awaits before openPopup, or Firefox no longer sees the click.
            usePopupFallback(tab.id);
            return;
        }
        void toggleOverlay(tab);
    });

    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.url !== undefined) {
            syncPopup(tabId, changeInfo.url);
        }
    });
    browser.tabs.onCreated.addListener((tab) => {
        if (tab.id !== undefined) {
            syncPopup(tab.id, tab.url);
        }
    });

    browser.runtime.onInstalled.addListener(() => {
        browser.contextMenus.removeAll().then(() => {
            browser.contextMenus.create({ id: MENU_COPY_CLEAN_LINK, title: "Copy clean link", contexts: ["link"] });
        });
    });

    browser.contextMenus.onClicked.addListener(async (info, tab) => {
        if (info.menuItemId === MENU_COPY_CLEAN_LINK && info.linkUrl) {
            await copyCleanLink(info.linkUrl, tab);
        }
    });

    browser.commands.onCommand.addListener(async (name) => {
        if (name !== COPY_CLEAN_URL_COMMAND && name !== TOGGLE_MARK_COMMAND) {
            return;
        }
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) {
            return;
        }
        if (name === COPY_CLEAN_URL_COMMAND) {
            await copyCleanLink(tab.url, tab);
        } else {
            await toggleMarkFor(tab);
        }
    });

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // The page the overlay is on, or for the popup, the tab it was opened over.
        const originTabId: number | undefined = sender.tab?.id ?? (Number.isInteger(message?.fromTabId) ? message.fromTabId : undefined);

        if (message?.action === "getTabs") {
            // The overlay just opened: get history ready while you start typing.
            void recentPages().catch(() => {});
            browser.tabs
                .query({})
                .then((all) =>
                    sendResponse(
                        all.map((tab) => ({
                            id: tab.id,
                            title: tab.title,
                            url: tab.url,
                            favIconUrl: tab.favIconUrl,
                            pinned: tab.pinned,
                            active: tab.active,
                            lastAccessed: tab.lastAccessed,
                            windowId: tab.windowId,
                            index: tab.index,
                            audible: tab.audible,
                            muted: tab.mutedInfo?.muted === true,
                            discarded: tab.discarded,
                            // The tab the overlay is open in. It can't be closed from its own overlay.
                            current: tab.id === originTabId,
                        })),
                    ),
                )
                .catch((err) => {
                    console.error("[tabdrift] getTabs failed:", err);
                    sendResponse([]);
                });
            return true;
        }

        if (message?.action === "closeTabs") {
            const ids: number[] = Array.isArray(message.tabIds)
                ? message.tabIds.filter((id: unknown): id is number => Number.isInteger(id) && id !== originTabId)
                : [];
            if (ids.length === 0) {
                sendResponse({ success: false });
                return;
            }
            browser.tabs
                .remove(ids)
                .then(() => sendResponse({ success: true, closed: ids.length }))
                .catch((err) => {
                    console.error("[tabdrift] closeTabs failed:", err);
                    sendResponse({ success: false });
                });
            return true;
        }

        if (message?.action === "switchTab") {
            browser.tabs
                .get(message.tabId)
                .then(async (tab) => {
                    await browser.tabs.update(message.tabId, { active: true });
                    await browser.windows.update(tab.windowId, { focused: true });
                    // Switching away from the new tab page closes it, so switching doesn't leave empty tabs behind.
                    if (message.closeOrigin === true && originTabId !== undefined && originTabId !== message.tabId) {
                        await browser.tabs.remove(originTabId);
                    }
                    sendResponse({ success: true });
                })
                .catch((err) => {
                    console.error("[tabdrift] switchTab failed:", err);
                    sendResponse({ success: false });
                });
            return true;
        }

        if (message?.action === "searchHistory") {
            const query = typeof message.query === "string" ? message.query : "";
            // Grouping by site needs a deeper pool, or one busy site fills every slot.
            const requested = Number.isInteger(message.maxResults) ? message.maxResults : DEFAULT_HISTORY_RESULTS;
            const maxResults = Math.max(1, Math.min(requested, MAX_HISTORY_RESULTS));
            searchHistory(query, maxResults, message.deep === true)
                .then(sendResponse)
                .catch((err) => {
                    console.error("[tabdrift] history search failed:", err);
                    sendResponse({ items: [], complete: true });
                });
            return true;
        }

        if (message?.action === "tabCommand") {
            const command = typeof message.command === "string" ? message.command : "";
            const tabId = Number.isInteger(message.tabId) ? (message.tabId as number) : originTabId;
            runTabCommand(command, tabId, originTabId)
                .then(sendResponse)
                .catch((err) => {
                    console.error(`[tabdrift] ${command} failed:`, err);
                    sendResponse({ success: false, message: "That didn't work on this tab" });
                });
            return true;
        }

        if (message?.action === "openHistoryUrl") {
            // Load it in the tab the overlay is open in, like typing in the address bar.
            if (message.inCurrentTab === true && originTabId !== undefined) {
                browser.tabs
                    .update(originTabId, { url: message.url })
                    .then(() => sendResponse({ success: true }))
                    .catch((err) => {
                        console.error("[tabdrift] openHistoryUrl in current tab failed:", err);
                        sendResponse({ success: false });
                    });
                return true;
            }
            // A background open leaves the current tab and window alone, so the overlay stays where it is.
            const background = message.background === true;
            browser.tabs
                .create({ url: message.url, active: !background })
                .then((tab) => {
                    if (!background && tab.windowId !== undefined) {
                        return browser.windows.update(tab.windowId, { focused: true });
                    }
                })
                .then(() => sendResponse({ success: true }))
                .catch((err) => {
                    console.error("[tabdrift] openHistoryUrl failed:", err);
                    sendResponse({ success: false });
                });
            return true;
        }

        if (message?.action === "openOptions") {
            browser.runtime.openOptionsPage();
        }

        if (message?.action === "applyShortcut") {
            applyStoredShortcut();
        }
    });
});

async function applyStoredShortcut() {
    const settings = await getSettings();
    try {
        const commands = browser.commands as unknown as {
            update: (details: { name: string; shortcut: string }) => Promise<void>;
        };
        await commands.update({
            name: COMMAND_NAME,
            shortcut: settings.shortcut,
        });
    } catch (err) {
        console.error("[tabdrift] failed to apply shortcut", err);
    }
}

const RESTRICTED_URL_PREFIXES = ["about:", "moz-extension:", "resource:", "chrome:", "view-source:"];

// Firefox's default extensions.webextensions.restrictedDomains: no content scripts allowed.
const RESTRICTED_HOSTS = new Set([
    "accounts-static.cdn.mozilla.net",
    "accounts.firefox.com",
    "addons.cdn.mozilla.net",
    "addons.mozilla.org",
    "api.accounts.firefox.com",
    "content.cdn.mozilla.net",
    "discovery.addons.mozilla.org",
    "install.mozilla.org",
    "oauth.accounts.firefox.com",
    "profile.accounts.firefox.com",
    "support.mozilla.org",
    "sync.services.mozilla.com",
]);

const POPUP_PAGE = "/palette.html";
const NEWTAB_PAGE = "/newtab.html";

/** Tabdrift's own new tab page. It runs the palette itself, so it needs neither the popup nor injection. */
function isOwnNewTab(url: string | undefined): boolean {
    return !!url && url.split(/[?#]/)[0] === browser.runtime.getURL(NEWTAB_PAGE);
}

function isRestrictedUrl(url: string | undefined): boolean {
    if (isOwnNewTab(url)) {
        return false;
    }
    if (!url) {
        return true;
    }
    if (RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
        return true;
    }
    try {
        return RESTRICTED_HOSTS.has(new URL(url).hostname);
    } catch {
        return false;
    }
}

/**
 * Locked pages get the palette as a toolbar popup, so the button and the
 * shortcut open it there directly. Every other page keeps the overlay.
 */
function syncPopup(tabId: number, url: string | undefined) {
    browser.action.setPopup({ tabId, popup: isRestrictedUrl(url) ? POPUP_PAGE : "" }).catch(() => {});
}

async function syncAllPopups() {
    try {
        for (const tab of await browser.tabs.query({})) {
            if (tab.id !== undefined) {
                syncPopup(tab.id, tab.url);
            }
        }
    } catch (err) {
        console.error("[tabdrift] popup sync failed:", err);
    }
}

/** Sets the popup for this tab and tries to open it now. If Firefox refuses, the next press opens it. */
function usePopupFallback(tabId: number) {
    browser.action.setPopup({ tabId, popup: POPUP_PAGE }).catch(() => {});
    const action = browser.action as unknown as { openPopup?: () => Promise<void> };
    action.openPopup?.().catch(() => flashBadge(tabId, false));
}

async function toggleOverlay(tab: { id?: number; url?: string }) {
    if (tab.id === undefined) {
        return;
    }
    if (isOwnNewTab(tab.url)) {
        // Extension pages in a tab get tabs.sendMessage too. Nothing to inject.
        await browser.tabs.sendMessage(tab.id, { action: "showTabSearch" }).catch((err) => {
            console.error("[tabdrift] new tab page didn't answer:", err);
        });
        return;
    }
    const ok = await sendToTab(tab.id, { action: "showTabSearch" });
    if (!ok) {
        // Some pages refuse scripts without matching our list (the PDF viewer, for one).
        usePopupFallback(tab.id);
    }
}

/**
 * Sends a message to the overlay script in a tab, injecting the script first
 * if it isn't there yet. Returns false if the tab can't be scripted.
 */
async function sendToTab(tabId: number, message: { action: string; text?: string }): Promise<boolean> {
    try {
        await browser.tabs.sendMessage(tabId, message);
        return true;
    } catch {}

    try {
        await browser.scripting.executeScript({
            target: { tabId },
            files: ["/tabdrift-overlay.js"],
        });
        await browser.tabs.sendMessage(tabId, message);
        return true;
    } catch (err) {
        console.error("[tabdrift] could not inject overlay script:", err);
        return false;
    }
}

async function copyCleanLink(rawUrl: string, tab?: { id?: number; url?: string }) {
    const { url, removed } = cleanUrl(rawUrl);
    const ok = url !== "" && (await copyText(url));

    const trackers = new Set(removed).size;
    let text = "Couldn't copy the link";
    if (ok) {
        if (url === rawUrl.trim()) {
            text = "Copied link (already clean)";
        } else if (trackers > 0) {
            text = `Copied clean link (${trackers} tracker${trackers === 1 ? "" : "s"} removed)`;
        } else {
            text = "Copied clean link";
        }
    }

    // The badge works on every page, including the ones we can't inject into.
    flashBadge(tab?.id, ok);
    if (tab?.id !== undefined && !isRestrictedUrl(tab.url)) {
        await sendToTab(tab.id, { action: "showToast", text });
    }
}

function flashBadge(tabId: number | undefined, ok: boolean) {
    try {
        browser.action.setBadgeBackgroundColor({ color: ok ? "#16a34a" : "#dc2626", tabId });
        browser.action.setBadgeText({ text: ok ? "\u2713" : "!", tabId });
        setTimeout(() => browser.action.setBadgeText({ text: "", tabId }), 1500);
    } catch (err) {
        console.error("[tabdrift] badge update failed:", err);
    }
}

/** One alarm per running session, named after its deadline, so a stale alarm can never end a newer session. */
async function scheduleTimerAlarm() {
    try {
        const state = await readTimer();
        const wanted = state.status === "running" && state.endsAt !== null ? `${TIMER_ALARM_PREFIX}${state.endsAt}` : null;
        // A new tab may settle a session a moment before its alarm fires. Keep that alarm: it sends the notification.
        const justEnded = state.lastCompleted ? `${TIMER_ALARM_PREFIX}${state.lastCompleted.endsAt}` : null;
        for (const alarm of await browser.alarms.getAll()) {
            if (alarm.name.startsWith(TIMER_ALARM_PREFIX) && alarm.name !== wanted && alarm.name !== justEnded) {
                await browser.alarms.clear(alarm.name);
            }
        }
        if (!wanted || state.endsAt === null) {
            return;
        }
        if (state.endsAt <= Date.now()) {
            // Ran out while the browser was closed. Settle quietly; a notification now would be old news.
            await writeTimer(settle(state));
            return;
        }
        if (!(await browser.alarms.get(wanted))) {
            browser.alarms.create(wanted, { when: state.endsAt });
        }
    } catch (err) {
        console.error("[tabdrift] timer alarm failed:", err);
    }
}

async function finishTimer(endsAt: number) {
    const state = await readTimer();
    let ended: TimerState["lastCompleted"] = null;
    if (state.status === "running" && state.endsAt === endsAt) {
        const next = settle(state, Math.max(Date.now(), endsAt));
        await writeTimer(next);
        ended = next.lastCompleted;
    } else if (state.lastCompleted?.endsAt === endsAt) {
        // An open new tab got there first. The session still ended, so the notification still goes out.
        ended = state.lastCompleted;
    }
    if (!ended) {
        return;
    }

    const settings = await getNewTabSettings();
    if (!settings.timer.notify || !(await browser.permissions.contains({ permissions: ["notifications"] }))) {
        return;
    }
    const focusDone = ended.phase === "focus";
    await browser.notifications.create(`tabdrift-timer-done-${endsAt}`, {
        type: "basic",
        iconUrl: browser.runtime.getURL("/icons/icon-128.png"),
        title: focusDone ? "Focus session done" : "Break's over",
        message: focusDone ? `Take a ${settings.timer.breakMinutes} minute break.` : `Ready for another ${settings.timer.focusMinutes} minutes?`,
    });
}

type HistoryItem = Browser.history.HistoryItem;

/** A history row as the overlay gets it, with the match positions so it can highlight without re-ranking. */
interface HistoryRow {
    id: string;
    title: string | undefined;
    url: string | undefined;
    lastVisitTime: number;
    visitCount: number;
    score?: number;
    titlePos?: number[];
    subPos?: number[];
}

/* -------------------------------------------------------------------------- */
/* Recent pages, prepared once                                                */
/* -------------------------------------------------------------------------- */

/**
 * Your most recent pages, ready for the fuzzy matcher, newest first. Loaded
 * once, then kept current from history events instead of being re-read, so a
 * keystroke never waits on the history database for these.
 */
let recent: Prepared<HistoryItem>[] | null = null;
let recentByUrl = new Map<string, Prepared<HistoryItem>>();
let recentLoading: Promise<Prepared<HistoryItem>[]> | null = null;
let boostsAt = 0;

function prepareHistory(item: HistoryItem, now = Date.now()): Prepared<HistoryItem> {
    return prepare({
        item,
        // Untitled pages show their address as the title, so that's what gets matched and highlighted.
        title: item.title || item.url || "",
        sub: displayUrl(item.url),
        host: hostOf(item.url),
        boost: historyBoost(item.lastVisitTime, item.visitCount, now),
    });
}

function recentPages(): Promise<Prepared<HistoryItem>[]> {
    if (recent) {
        // Recency boosts drift as time passes. Re-scoring 2000 numbers is cheap; re-reading history isn't.
        const now = Date.now();
        if (now - boostsAt > BOOST_REFRESH_MS) {
            for (const p of recent) {
                p.boost = historyBoost(p.item.lastVisitTime, p.item.visitCount, now);
            }
            boostsAt = now;
        }
        return Promise.resolve(recent);
    }
    recentLoading ??= browser.history
        .search({ text: "", maxResults: RECENT_HISTORY_POOL, startTime: 0 })
        .then((items) => {
            const now = Date.now();
            recent = items.filter((item) => !!item.url).map((item) => prepareHistory(item, now));
            recentByUrl = new Map(recent.map((p) => [p.item.url as string, p]));
            boostsAt = now;
            return recent;
        })
        .finally(() => {
            recentLoading = null;
        });
    return recentLoading;
}

/** Puts a just-visited (or retitled) page at the front of the recent pool. */
function upsertRecent(item: HistoryItem) {
    if (!recent || !item.url) {
        return;
    }
    const old = recentByUrl.get(item.url);
    if (old) {
        const at = recent.indexOf(old);
        if (at !== -1) {
            recent.splice(at, 1);
        }
    } else if (recent.length >= RECENT_HISTORY_POOL) {
        const dropped = recent.pop();
        if (dropped?.item.url) {
            recentByUrl.delete(dropped.item.url);
        }
    }
    const next = prepareHistory(item);
    recent.unshift(next);
    recentByUrl.set(item.url, next);
}

function watchHistory() {
    const history = browser.history;
    history.onVisited?.addListener((item) => {
        upsertRecent(item);
        // A new visit can change what any search finds.
        lastDirect = null;
    });
    // Firefox-only, so it isn't in the shared typings.
    const titles = (history as unknown as { onTitleChanged?: { addListener(cb: (change: { url: string; title: string }) => void): void } }).onTitleChanged;
    titles?.addListener((change) => {
        const old = recentByUrl.get(change.url);
        if (old) {
            upsertRecent({ ...old.item, title: change.title });
        }
        lastDirect = null;
    });
    history.onVisitRemoved?.addListener((removed) => {
        lastDirect = null;
        if (removed.allHistory) {
            recent = null;
            recentByUrl = new Map();
            return;
        }
        if (!recent) {
            return;
        }
        const gone = new Set(removed.urls);
        recent = recent.filter((p) => !gone.has(p.item.url as string));
        for (const url of gone) {
            recentByUrl.delete(url);
        }
    });
}

/* -------------------------------------------------------------------------- */
/* Firefox's own history search, reused while you keep typing                 */
/* -------------------------------------------------------------------------- */

/** The last answer from Firefox's history search, kept so a longer query can be answered from it. */
let lastDirect: { words: string[]; items: HistoryItem[] } | null = null;

function splitWords(words: string): string[] {
    return words.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Firefox finds pages containing every word. If the last search was complete
 * (fewer hits than the limit) and every old word is part of a new word
 * ("rus" -> "rust book"), the new hits are a subset of the old ones, so they
 * can be filtered here instead of asking the database again.
 */
function directFromCache(words: string[]): HistoryItem[] | null {
    if (!lastDirect?.words.every((old) => words.some((w) => w.includes(old)))) {
        return null;
    }
    const items = lastDirect.items.filter((item) => {
        const hay = `${item.title ?? ""} ${item.url ?? ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
    });
    lastDirect = { words, items };
    return items;
}

async function directSearch(text: string, words: string[]): Promise<HistoryItem[]> {
    const items = await browser.history.search({ text, maxResults: MAX_HISTORY_RESULTS, startTime: 0 });
    // A full page of results may have left some out, so it can't stand in for a longer query.
    lastDirect = items.length < MAX_HISTORY_RESULTS ? { words, items } : null;
    return items;
}

function historyRow(r: Ranked<HistoryItem> | { item: HistoryItem }): HistoryRow {
    const item = r.item;
    const ranked = "score" in r ? r : null;
    return {
        id: item.id,
        title: item.title || item.url,
        url: item.url,
        lastVisitTime: item.lastVisitTime ?? 0,
        visitCount: item.visitCount ?? 0,
        score: ranked?.score,
        titlePos: ranked?.titlePos,
        subPos: ranked?.subPos,
    };
}

/**
 * Firefox's history search only finds pages containing every word as typed,
 * so "ghtd" finds nothing. Its results are merged with your recent pages and
 * the lot is ranked with the same fuzzy matcher the overlay uses.
 *
 * Without `deep`, this answers from memory only and says whether that was the
 * whole story (`complete`). If not, the overlay shows it and asks again with
 * `deep` for the database results.
 */
async function searchHistory(query: string, maxResults: number, deep: boolean): Promise<{ items: HistoryRow[]; complete: boolean }> {
    const pool = await recentPages();
    if (!query.trim()) {
        return { items: pool.slice(0, maxResults).map(historyRow), complete: true };
    }

    const text = plainWords(query);
    const words = splitWords(text);
    let direct: HistoryItem[] | null = words.length > 0 ? directFromCache(words) : [];
    if (direct === null && !deep) {
        return { items: rankPrepared(pool, query, maxResults).map(historyRow), complete: false };
    }
    direct ??= await directSearch(text, words);

    // Database hits first, then recent pages not already in there. Ties keep this order.
    const now = Date.now();
    const seen = new Set<string>();
    const candidates: Prepared<HistoryItem>[] = [];
    for (const item of direct) {
        if (item.url && !seen.has(item.url)) {
            seen.add(item.url);
            candidates.push(recentByUrl.get(item.url) ?? prepareHistory(item, now));
        }
    }
    for (const p of pool) {
        if (!seen.has(p.item.url as string)) {
            candidates.push(p);
        }
    }
    return { items: rankPrepared(candidates, query, maxResults).map(historyRow), complete: true };
}

/** Alt+Shift+B: mark or unmark the page you're on without opening the overlay. */
async function toggleMarkFor(tab: Browser.tabs.Tab) {
    if (!canMark(tab.url)) {
        flashBadge(tab.id, false);
        return;
    }
    const marked = await toggleMark({ url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl });
    if (tab.id !== undefined) {
        browser.action.setBadgeBackgroundColor({ color: marked ? "#ca8a04" : "#52525b", tabId: tab.id });
        browser.action.setBadgeText({ text: marked ? "\u2605" : "\u2606", tabId: tab.id });
        setTimeout(() => browser.action.setBadgeText({ text: "", tabId: tab.id }), 1500);
        if (!isRestrictedUrl(tab.url)) {
            await sendToTab(tab.id, { action: "showToast", text: marked ? "Marked. Find it under * in Tabdrift" : "Unmarked" });
        }
    }
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Tabs closed in bulk never include pinned tabs or the tab the overlay is open in. */
function closable(list: Browser.tabs.Tab[], keep: Set<number | undefined>): number[] {
    return list.filter((t) => t.id !== undefined && !t.pinned && !keep.has(t.id)).map((t) => t.id as number);
}

async function closeIds(ids: number[], what: string): Promise<TabCommandReply> {
    if (ids.length === 0) {
        return { success: true, message: `No ${what} to close` };
    }
    await browser.tabs.remove(ids);
    return { success: true, message: `✓ Closed ${plural(ids.length, "tab")}` };
}

async function runTabCommand(command: string, tabId: number | undefined, originTabId: number | undefined): Promise<TabCommandReply> {
    if (tabId === undefined) {
        return { success: false, message: "No tab to work on" };
    }
    const tab = await browser.tabs.get(tabId);
    const id = tabId;

    switch (command as TabCommandId) {
        case "pin":
            await browser.tabs.update(id, { pinned: !tab.pinned });
            return { success: true, message: tab.pinned ? "✓ Unpinned" : "✓ Pinned" };

        case "mute": {
            const muted = tab.mutedInfo?.muted === true;
            await browser.tabs.update(id, { muted: !muted });
            return { success: true, message: muted ? "✓ Unmuted" : "✓ Muted" };
        }

        case "reload":
            await browser.tabs.reload(id);
            return { success: true };

        case "hard-reload":
            await browser.tabs.reload(id, { bypassCache: true });
            return { success: true };

        case "duplicate":
            await browser.tabs.duplicate(id);
            return { success: true };

        case "new-window":
            await browser.windows.create({ tabId: id });
            return { success: true };

        case "discard":
            if (tab.active) {
                return { success: false, message: "Can't unload the tab you're looking at" };
            }
            await browser.tabs.discard(id);
            return { success: true, message: "✓ Unloaded. It reloads when you switch to it" };

        case "close-site": {
            const host = hostOf(tab.url);
            if (!host) {
                return { success: false, message: "Not a website" };
            }
            const all = await browser.tabs.query({});
            const same = all.filter((t) => hostOf(t.url) === host);
            return closeIds(closable(same, new Set([originTabId])), `${host} tabs`);
        }

        case "close-others": {
            const inWindow = await browser.tabs.query({ windowId: tab.windowId });
            return closeIds(closable(inWindow, new Set([id, originTabId])), "other tabs");
        }

        case "close-right":
        case "close-left": {
            const inWindow = await browser.tabs.query({ windowId: tab.windowId });
            const side = inWindow.filter((t) => (command === "close-right" ? t.index > tab.index : t.index < tab.index));
            return closeIds(closable(side, new Set([id, originTabId])), command === "close-right" ? "tabs to the right" : "tabs to the left");
        }

        case "sort-window": {
            const inWindow = await browser.tabs.query({ windowId: tab.windowId });
            const pinnedCount = inWindow.filter((t) => t.pinned).length;
            const sorted = inWindow
                .filter((t) => !t.pinned && t.id !== undefined)
                .sort((a, b) => {
                    const byHost = hostOf(a.url).localeCompare(hostOf(b.url));
                    return byHost !== 0 ? byHost : (a.title ?? "").localeCompare(b.title ?? "");
                });
            await browser.tabs.move(
                sorted.map((t) => t.id as number),
                { index: pinnedCount },
            );
            return { success: true, message: `✓ Sorted ${plural(sorted.length, "tab")} by site` };
        }

        case "merge-windows": {
            const all = await browser.tabs.query({});
            const ids = all.filter((t) => t.windowId !== tab.windowId && !t.incognito === !tab.incognito && t.id !== undefined).map((t) => t.id as number);
            if (ids.length === 0) {
                return { success: true, message: "Only one window open" };
            }
            await browser.tabs.move(ids, { windowId: tab.windowId, index: -1 });
            return { success: true, message: `✓ Moved ${plural(ids.length, "tab")} into this window` };
        }

        case "discard-inactive": {
            const all = await browser.tabs.query({});
            const ids = all.filter((t) => !t.active && !t.discarded && !t.audible && t.id !== undefined).map((t) => t.id as number);
            await Promise.all(ids.map((tabId) => browser.tabs.discard(tabId).catch(() => {})));
            return { success: true, message: ids.length > 0 ? `✓ Unloaded ${plural(ids.length, "tab")}` : "Nothing to unload" };
        }

        case "mute-others": {
            const all = await browser.tabs.query({ audible: true });
            const others = all.filter((t) => t.id !== id && t.id !== undefined);
            await Promise.all(others.map((t) => browser.tabs.update(t.id as number, { muted: true })));
            return { success: true, message: others.length > 0 ? `✓ Muted ${plural(others.length, "tab")}` : "No other tab is playing sound" };
        }

        default:
            return { success: false, message: "Unknown command" };
    }
}
