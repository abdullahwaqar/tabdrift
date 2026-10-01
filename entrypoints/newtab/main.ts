const HOME_PAGE = "/home.html";

async function openHome() {
    const url = browser.runtime.getURL(HOME_PAGE);
    try {
        const current = await browser.tabs.getCurrent();
        if (!current || current.id === undefined) {
            location.replace(url);
            return;
        }

        const { cookieStoreId } = current as { cookieStoreId?: string };
        await browser.tabs.create({
            url,
            index: current.index,
            windowId: current.windowId,
            active: true,
            ...(cookieStoreId ? { cookieStoreId } : {}),
        });
    } catch (err) {
        console.error("[tabdrift] couldn't open the new tab page in its own tab:", err);
        location.replace(url);
        return;
    }
    try {
        const current = await browser.tabs.getCurrent();

        if (current?.id !== undefined) {
            await browser.tabs.remove(current.id);
        }
    } catch (err) {
        console.error("[tabdrift] couldn't close the launcher tab:", err);
    }
}

void openHome();
