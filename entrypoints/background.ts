import { defineBackground } from "wxt/utils/define-background";
import { COMMAND_NAME, getSettings } from "../lib/settings";

export default defineBackground(() => {
    applyStoredShortcut();

    browser.action.onClicked.addListener(async () => {
        await toggleOverlayOnActiveTab();
    });

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.action === "getTabs") {
            browser.tabs.query({}).then(sendResponse);
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
    const tabId = tab.id;

    if (isRestrictedUrl(tab.url)) {
        console.warn("[tabdrift] can't run on this page (a restricted internal page):", tab.url);
        return;
    }

    try {
        await browser.tabs.sendMessage(tabId, { action: "showTabSearch" });
        return;
    } catch {}

    try {
        await browser.scripting.executeScript({
            target: { tabId },
            files: ["/tabdrift-overlay.js"],
        });
        await browser.tabs.sendMessage(tabId, { action: "showTabSearch" });
    } catch (err) {
        console.error("[tabdrift] could not inject overlay script:", err);
    }
}
