import { defineBackground } from "wxt/utils/define-background";
import { copyText } from "../lib/clipboard";
import type { TabCommandId, TabCommandReply } from "../lib/commands";
import { canMark, toggleMark } from "../lib/marks";
import { displayUrl, historyBoost, hostOf, plainWords, rank } from "../lib/match";
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
const RECENT_HISTORY_TTL_MS = 60_000;

export default defineBackground(() => {
    applyStoredShortcut();
    syncAllPopups();
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
            searchHistory(query, maxResults)
                .then(sendResponse)
                .catch((err) => {
                    console.error("[tabdrift] history search failed:", err);
                    sendResponse([]);
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

let recentHistory: { at: number; items: HistoryItem[] } | null = null;

async function recentPages(): Promise<HistoryItem[]> {
    if (recentHistory && Date.now() - recentHistory.at < RECENT_HISTORY_TTL_MS) {
        return recentHistory.items;
    }
    const items = await browser.history.search({ text: "", maxResults: RECENT_HISTORY_POOL, startTime: 0 });
    recentHistory = { at: Date.now(), items };
    return items;
}

function historyRow(item: HistoryItem) {
    return {
        id: item.id,
        title: item.title || item.url,
        url: item.url,
        lastVisitTime: item.lastVisitTime ?? 0,
        visitCount: item.visitCount ?? 0,
    };
}

/**
 * Firefox's history search only finds pages containing every word as typed,
 * so "ghtd" finds nothing. Its results are merged with your recent pages and
 * the lot is ranked with the same fuzzy matcher the overlay uses.
 */
async function searchHistory(query: string, maxResults: number) {
    if (!query.trim()) {
        const recent = await recentPages();
        return recent
            .filter((item) => !!item.url)
            .slice(0, maxResults)
            .map(historyRow);
    }

    const words = plainWords(query);
    const [direct, recent] = await Promise.all([
        words ? browser.history.search({ text: words, maxResults: MAX_HISTORY_RESULTS, startTime: 0 }) : Promise.resolve([]),
        recentPages(),
    ]);
    const pool = new Map<string, HistoryItem>();
    for (const item of [...direct, ...recent]) {
        if (item.url && !pool.has(item.url)) {
            pool.set(item.url, item);
        }
    }

    const now = Date.now();
    const ranked = rank(
        [...pool.values()].map((item) => ({
            item,
            title: item.title || "",
            sub: displayUrl(item.url),
            host: hostOf(item.url),
            boost: historyBoost(item.lastVisitTime, item.visitCount, now),
        })),
        query,
        maxResults,
    );
    return ranked.map((r) => historyRow(r.item));
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
