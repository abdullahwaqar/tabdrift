import type { MovePlace, MoveTabReply } from "./commands";

/**
 * Moves a tab next to another one, in the same window or another. Firefox silently ignores a move that
 * would put an unpinned tab among the pinned ones (or the reverse), so the index is kept on the right side.
 */
export async function moveTab(tabId: number, targetId: number, place: MovePlace, originTabId: number | undefined): Promise<MoveTabReply> {
    if (tabId === targetId) {
        return { success: true, moved: false };
    }
    const [tab, target] = await Promise.all([browser.tabs.get(tabId), browser.tabs.get(targetId)]);
    const otherWindow = tab.windowId !== target.windowId;
    if (otherWindow && tab.incognito !== target.incognito) {
        return { success: false, message: "Tabs can't move between private and normal windows" };
    }
    if (otherWindow && tabId === originTabId) {
        return { success: false, message: "Tabdrift is open on this tab. Switch to another tab to move it to a different window" };
    }

    // Positions in the target window once the moved tab has left it, which is what tabs.move() expects.
    const others = (await browser.tabs.query({ windowId: target.windowId })).filter((t) => t.id !== tabId).sort((a, b) => a.index - b.index);
    const at = others.findIndex((t) => t.id === targetId);
    if (at === -1) {
        return { success: false, message: "That tab is gone" };
    }
    const wanted = place === "after" ? at + 1 : at;
    const pinnedCount = others.filter((t) => t.pinned).length;
    const index = tab.pinned ? Math.min(wanted, pinnedCount) : Math.max(wanted, pinnedCount);
    const note = index === wanted ? undefined : tab.pinned ? "Pinned tabs stay before the others" : "Pinned tabs stay first. Unpin a tab to move past it";

    if (!otherWindow && index === tab.index) {
        return { success: true, moved: false, message: note };
    }
    await browser.tabs.move(tabId, { windowId: target.windowId, index });
    return { success: true, moved: true, message: note };
}
