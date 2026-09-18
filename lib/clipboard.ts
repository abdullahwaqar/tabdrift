/**
 * Copies text to the clipboard. Uses the async Clipboard API first and falls
 * back to a hidden textarea + execCommand for pages where that API isn't
 * available (plain http pages, some sandboxed frames). Needs the
 * "clipboardWrite" permission.
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {}

    try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.cssText = "position: fixed; top: -1000px; left: -1000px; opacity: 0;";
        (document.body ?? document.documentElement).appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
    } catch {
        return false;
    }
}
