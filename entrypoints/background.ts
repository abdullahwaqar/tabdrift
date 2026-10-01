import { defineBackground } from "wxt/utils/define-background";
import { copyText } from "../lib/clipboard";
import { getNewTabSettings } from "../lib/newtab/settings";
import type { TimerState } from "../lib/newtab/timer-state";
import { readTimer, settle, TIMER_ALARM_PREFIX, TIMER_KEY, writeTimer } from "../lib/newtab/timer-state";
import { COMMAND_NAME, getSettings } from "../lib/settings";
import { cleanUrl } from "../lib/utils";

const COPY_CLEAN_URL_COMMAND = "copy-clean-url";
const MENU_COPY_CLEAN_LINK = "tabdrift-copy-clean-link";
const DEFAULT_HISTORY_RESULTS = 25;
const MAX_HISTORY_RESULTS = 300;

export default defineBackground(() => {
    applyStoredShortcut();
    syncAllPopups();
    void scheduleTimerAlarm();

    browser.history.onVisited.addListener((item) => {
        if (item.url && isOwnNewTab(item.url)) {
            void browser.history.deleteUrl({ url: item.url }).catch(() => {});
        }
    });

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
        if (name !== COPY_CLEAN_URL_COMMAND) {
            return;
        }
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) {
            await copyCleanLink(tab.url, tab);
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
            browser.history
                .search({ text: query, maxResults, startTime: 0 })
                .then((items) => {
                    const results = items
                        .filter((item) => !!item.url)
                        .sort((a, b) => (b.lastVisitTime ?? 0) - (a.lastVisitTime ?? 0))
                        .map((item) => ({
                            id: item.id,
                            title: item.title || item.url,
                            url: item.url,
                            lastVisitTime: item.lastVisitTime ?? 0,
                        }));
                    sendResponse(results);
                })
                .catch((err) => {
                    console.error("[tabdrift] history search failed:", err);
                    sendResponse([]);
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
const NEWTAB_PAGE = "/home.html";

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
