import { Backdrop } from "../../lib/newtab/backdrop";
import { Clock } from "../../lib/newtab/clock";
import { Customize } from "../../lib/newtab/customize";
import { h, ICONS } from "../../lib/newtab/dom";
import { Lists } from "../../lib/newtab/lists";
import type { NewTabSettings } from "../../lib/newtab/settings";
import { getNewTabSettings, onNewTabSettingsChanged, saveNewTabSettings, withDefaults } from "../../lib/newtab/settings";
import { Shortcuts } from "../../lib/newtab/shortcuts";
import { FocusTimer } from "../../lib/newtab/timer";
import { Weather } from "../../lib/newtab/weather";
import { mountPalette } from "../../lib/palette";
import { COMMAND_NAME, getSettings, onSettingsChanged } from "../../lib/settings";

const SAVE_DELAY_MS = 300;

/** Marks a tab as the relaunched copy from {@link relaunchForFocus}, so it doesn't relaunch again. */
const FOCUS_PARAM = "tabdrift-focus";

async function relaunchForFocus(): Promise<boolean> {
    if (new URLSearchParams(location.search).has(FOCUS_PARAM)) {
        return false;
    }
    try {
        const current = await browser.tabs.getCurrent();
        if (!current || current.id === undefined) {
            return false;
        }
        const url = `${location.origin}${location.pathname}?${FOCUS_PARAM}=1`;
        await browser.tabs.create({
            url,
            index: current.index,
            windowId: current.windowId,
            // Keeps the replacement tab in the same container as the one it's standing in for.
            ...((current as { cookieStoreId?: string }).cookieStoreId ? { cookieStoreId: (current as { cookieStoreId?: string }).cookieStoreId } : {}),
            active: true,
        });
        await browser.tabs.remove(current.id);
        // Keeps the marker URL from cluttering history and address bar suggestions; it's an implementation detail.
        void browser.history.deleteUrl({ url }).catch(() => {});
        return true;
    } catch (err) {
        console.error("[tabdrift] couldn't relaunch the new tab for focus:", err);
        return false;
    }
}

async function main() {
    if (await relaunchForFocus()) {
        return;
    }

    if (location.search) {
        history.replaceState(null, "", location.pathname);
    }

    const backdropEl = document.getElementById("backdrop") as HTMLDivElement;
    const topbar = document.getElementById("topbar") as HTMLDivElement;
    const center = document.getElementById("center") as HTMLElement;
    const widgets = document.getElementById("widgets") as HTMLDivElement;

    let settings: NewTabSettings = await getNewTabSettings();
    const backdrop = new Backdrop(backdropEl);
    let appliedBackground = "";

    // The palette runs in this page. It needs this tab's id to know which tab "here" is.
    const thisTab = await browser.tabs.getCurrent().catch(() => undefined);
    const palette = mountPalette("newtab", { tabId: thisTab?.id, url: location.href });

    // Every write echoes back through storage.onChanged, in this page too. Echoes of our own writes are
    // skipped by content, so a slider being dragged never jumps back to an older value.
    const ownWrites: string[] = [];
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    function writeNow() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        ownWrites.push(JSON.stringify(settings));
        void saveNewTabSettings(settings).catch((err) => console.error("[tabdrift] couldn't save new tab settings:", err));
    }

    function set(next: NewTabSettings, immediate = true) {
        settings = withDefaults(next as unknown as Record<string, object>);
        render();
        if (immediate) {
            writeNow();
        } else {
            if (saveTimer) {
                clearTimeout(saveTimer);
            }
            saveTimer = setTimeout(writeNow, SAVE_DELAY_MS);
        }
    }

    // Don't lose a pending slider change if the tab closes right after.
    window.addEventListener("pagehide", () => {
        if (saveTimer) {
            writeNow();
        }
    });

    onNewTabSettingsChanged((next) => {
        const json = JSON.stringify(next);
        const at = ownWrites.indexOf(json);
        if (at !== -1) {
            ownWrites.splice(0, at + 1);
            return;
        }
        if (saveTimer) {
            // A local change is waiting to be saved. It's newer, so it wins.
            return;
        }
        settings = next;
        render();
        customize.sync();
    });

    const clock = new Clock(settings.clock);

    const customizeBtn = h("button", {
        class: "icon-btn customize-btn",
        html: ICONS.sliders,
        attrs: { type: "button", "aria-label": "Customize this page", title: "Customize", "aria-expanded": "false", "aria-controls": "drawer" },
    });

    const customize = new Customize({
        get: () => settings,
        set,
        gradientNote: () => {
            if (backdrop.gradientUnavailable) {
                return "This browser can't draw the gradient (WebGL 2 is off or unavailable), so the base color shows instead.";
            }
            if (backdrop.motionReduced && settings.background.gradient.speed > 0) {
                return "Your system asks for reduced motion, so the gradient holds still.";
            }
            return null;
        },
        openTabdriftSettings: () => void browser.runtime.openOptionsPage(),
    });
    customize.el.id = "drawer";
    customizeBtn.addEventListener("click", () => customize.toggle(customizeBtn));

    const weather = new Weather(settings.weather, () => customize.openAtWeather(customizeBtn));
    // Date and weather share a line under the clock. It stays when the clock is off, so the weather does too.
    const dateRow = h("div", { class: "date-row" }, clock.dateEl, weather.el);

    // The search box hands off to the palette as soon as you type, click or paste.
    const searchInput = h("input", {
        class: "search-input",
        attrs: {
            type: "text",
            placeholder: "Search tabs, history or the web",
            "aria-label": "Search tabs, history or the web",
            autocomplete: "off",
            spellcheck: "false",
        },
    });
    const searchKeys = h("span", { class: "search-keys", attrs: { "aria-hidden": "true" } });
    const search = h(
        "div",
        { class: "search glass" },
        h("span", { class: "search-icon", html: ICONS.search, attrs: { "aria-hidden": "true" } }),
        searchInput,
        searchKeys,
    );

    let composing = false;
    const handOff = () => {
        const text = searchInput.value;
        searchInput.value = "";
        palette.show(text);
    };
    searchInput.addEventListener("compositionstart", () => {
        composing = true;
    });
    searchInput.addEventListener("compositionend", () => {
        composing = false;
        handOff();
    });
    searchInput.addEventListener("input", () => {
        if (!composing && searchInput.value) {
            handOff();
        }
    });
    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault();
            handOff();
        }
    });
    search.addEventListener("click", () => handOff());

    const shortcuts = new Shortcuts(settings.shortcuts, (next) => set({ ...settings, shortcuts: next }));
    const lists = new Lists();
    const timer = new FocusTimer(settings.timer);

    topbar.append(customizeBtn);
    center.append(clock.el, dateRow, search, shortcuts.el);
    widgets.append(lists.el, timer.el);
    document.body.append(customize.el);

    const applyAccent = (accent: string) => document.documentElement.style.setProperty("--accent", accent);
    applyAccent((await getSettings()).accent);
    onSettingsChanged((s) => applyAccent(s.accent));

    // The key that's actually bound right now, which can differ from the stored one if changed in about:addons.
    const commands = await browser.commands.getAll().catch(() => []);
    const shortcut = commands.find((c) => c.name === COMMAND_NAME)?.shortcut;
    if (shortcut) {
        for (const [i, part] of shortcut.split("+").entries()) {
            if (i > 0) {
                searchKeys.append(h("span", { class: "key-join", text: "+" }));
            }
            searchKeys.append(h("kbd", { text: part }));
        }
    }

    function render() {
        const bgKey = JSON.stringify(settings.background);
        if (bgKey !== appliedBackground) {
            appliedBackground = bgKey;
            void backdrop.apply(settings.background).then(() => {
                if (customize.isOpen) {
                    customize.sync();
                }
            });
        }
        clock.update(settings.clock);
        search.hidden = !settings.search.show;
        shortcuts.update(settings.shortcuts);
        weather.update(settings.weather);
        lists.setVisible(settings.lists.show);
        timer.setHourCycle(settings.clock.hourCycle);
        timer.update(settings.timer);
        widgets.hidden = !settings.lists.show && !settings.timer.show;
        dateRow.hidden = clock.dateEl.hidden && weather.el.hidden;
    }

    render();
    document.body.classList.add("ready");

    if (settings.search.show) {
        searchInput.focus();
    }

    // With the page itself focused (not a field or button), typing goes straight into the palette.
    document.addEventListener("keydown", (e) => {
        if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) {
            return;
        }
        const target = e.target as HTMLElement;
        if (target !== document.body && target !== document.documentElement) {
            return;
        }
        if (e.key.length === 1 && e.key !== " ") {
            e.preventDefault();
            palette.show(e.key === "/" ? "" : e.key);
        }
    });
}

main().catch((err) => {
    console.error("[tabdrift] new tab failed to start:", err);
    document.body.classList.add("ready");
});
