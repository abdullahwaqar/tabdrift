export type OverlayPosition = "top" | "center" | "bottom";

export interface TabSearchSettings {
    shortcut: string; // WebExtensions commands.update() format, e.g. "Alt+D"
    position: OverlayPosition;
    accent: string; // hex color
}

export const COMMAND_NAME = "_execute_action";

export const DEFAULT_SETTINGS: TabSearchSettings = {
    shortcut: "Alt+Shift+K",
    position: "center",
    accent: "#3b82f6",
};

const STORAGE_KEY = "local:tabSearchSettings";

export async function getSettings(): Promise<TabSearchSettings> {
    const result = await browser.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY] as Partial<TabSearchSettings> | undefined;
    return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings: TabSearchSettings): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEY]: settings });
}

export function onSettingsChanged(callback: (settings: TabSearchSettings) => void) {
    browser.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[STORAGE_KEY]) {
            return;
        }
        const next = changes[STORAGE_KEY].newValue as Partial<TabSearchSettings> | undefined;
        callback({ ...DEFAULT_SETTINGS, ...next });
    });
}

/**
 * Turns a KeyboardEvent into a WebExtensions commands.update() shortcut
 * string, e.g. "Alt+D" or "Ctrl+Shift+K". Returns null if the combo isn't
 * a valid/acceptable shortcut (needs Ctrl or Alt, plus one real key).
 */
export function eventToShortcut(e: KeyboardEvent): string | null {
    const key = e.key;
    if (["Control", "Alt", "Shift", "Meta"].includes(key)) {
        return null;
    }

    const parts: string[] = [];
    if (e.ctrlKey) {
        parts.push("Ctrl");
    }
    if (e.altKey) {
        parts.push("Alt");
    }
    if (e.shiftKey) {
        parts.push("Shift");
    }

    // Firefox requires at least Ctrl or Alt as the "primary" modifier.
    if (!e.ctrlKey && !e.altKey) {
        return null;
    }

    const mainKey = normalizeKey(key);
    if (!mainKey) {
        return null;
    }

    parts.push(mainKey);
    return parts.join("+");
}

function normalizeKey(key: string): string | null {
    if (/^[a-zA-Z]$/.test(key)) {
        return key.toUpperCase();
    }
    if (/^[0-9]$/.test(key)) {
        return key;
    }
    if (/^F([1-9]|1[0-2])$/.test(key)) {
        return key;
    }

    const named: Record<string, string> = {
        " ": "Space",
        Comma: "Comma",
        Period: "Period",
        ArrowUp: "Up",
        ArrowDown: "Down",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        Home: "Home",
        End: "End",
        PageUp: "PageUp",
        PageDown: "PageDown",
        Insert: "Insert",
        Delete: "Delete",
    };
    return named[key] ?? null;
}
