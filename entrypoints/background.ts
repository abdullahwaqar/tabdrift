import { defineBackground } from "wxt/utils/define-background";
import { copyText } from "../lib/clipboard";
import { COMMAND_NAME, getSettings } from "../lib/settings";
import { cleanUrl } from "../lib/utils";

const COPY_CLEAN_URL_COMMAND = "copy-clean-url";
const MENU_COPY_CLEAN_LINK = "tabdrift-copy-clean-link";
const DEFAULT_HISTORY_RESULTS = 25;
const MAX_HISTORY_RESULTS = 300;

export default defineBackground(() => {
    applyStoredShortcut();

    browser.action.onClicked.addListener(async () => {
        await toggleOverlayOnActiveTab();
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
                            current: tab.id === sender.tab?.id,
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
                ? message.tabIds.filter((id: unknown): id is number => Number.isInteger(id) && id !== sender.tab?.id)
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

function isRestrictedUrl(url: string | undefined): boolean {
    if (!url) {
        return true;
    }
    return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

async function toggleOverlayOnActiveTab() {
    const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
    });
    if (!tab?.id) {
        return;
    }

    if (isRestrictedUrl(tab.url)) {
        console.warn("[tabdrift] can't run on this page (a restricted internal page):", tab.url);
        return;
    }

    await sendToTab(tab.id, { action: "showTabSearch" });
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
