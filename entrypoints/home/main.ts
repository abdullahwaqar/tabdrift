import { Backdrop } from "../../lib/newtab/backdrop";
import { Clock } from "../../lib/newtab/clock";
import { Customize } from "../../lib/newtab/customize";
import { h, ICONS } from "../../lib/newtab/dom";
import { Lists } from "../../lib/newtab/lists";
import type { NewTabSettings } from "../../lib/newtab/settings";
import {
    cacheAccent,
    cacheSettings,
    getNewTabSettings,
    onNewTabSettingsChanged,
    readCachedAccent,
    readCachedSettings,
    saveNewTabSettings,
    withDefaults,
} from "../../lib/newtab/settings";
import { Shortcuts } from "../../lib/newtab/shortcuts";
import { FocusTimer } from "../../lib/newtab/timer";
import { Weather } from "../../lib/newtab/weather";
import type { PaletteOrigin } from "../../lib/palette";
import { mountPalette } from "../../lib/palette";
import { COMMAND_NAME, getSettings, onSettingsChanged } from "../../lib/settings";

const SAVE_DELAY_MS = 300;

function main() {
    const backdropEl = document.getElementById("backdrop") as HTMLDivElement;
    const topbar = document.getElementById("topbar") as HTMLDivElement;
    const center = document.getElementById("center") as HTMLElement;
    const widgets = document.getElementById("widgets") as HTMLDivElement;

    // Nothing below waits on the browser before drawing. storage.local can only be read asynchronously,
    // so the last known settings are also kept in localStorage, which is synchronous. The page is drawn
    // from those in the first frame, then corrected if storage.local turns out to say something else.
    let settings: NewTabSettings = readCachedSettings() ?? withDefaults(undefined);
    let changedHere = false;
    const backdrop = new Backdrop(backdropEl);
    let appliedBackground = "";

    // The palette runs in this page. Which tab "here" is only matters once it is used, so it fills in later.
    const origin: PaletteOrigin = { url: location.href };
    // The search overlay blurs the whole page, so the gradient underneath doesn't need to move meanwhile.
    const palette = mountPalette("newtab", origin, { onOpenChange: (open) => backdrop.hold(open) });
    void browser.tabs
        .getCurrent()
        .then((tab) => {
            origin.tabId = tab?.id;
        })
        .catch(() => {});

    /* Saving */

    // Every write echoes back through storage.onChanged, in this page too. Echoes of our own writes are
    // skipped by content, so a slider being dragged never jumps back to an older value.
    const ownWrites: string[] = [];
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    function writeNow() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        cacheSettings(settings);
        ownWrites.push(JSON.stringify(settings));
        void saveNewTabSettings(settings).catch((err) => console.error("[tabdrift] couldn't save new tab settings:", err));
    }

    function set(next: NewTabSettings, immediate = true) {
        changedHere = true;
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
        cacheSettings(next);
        if (saveTimer) {
            // A local change is waiting to be saved. It's newer, so it wins.
            return;
        }
        settings = next;
        render();
        customize.sync();
    });

    void getNewTabSettings()
        .then((stored) => {
            cacheSettings(stored);
            if (changedHere || JSON.stringify(stored) === JSON.stringify(settings)) {
                return;
            }
            settings = stored;
            render();
            customize.sync();
        })
        .catch((err) => console.error("[tabdrift] couldn't read new tab settings:", err));

    /* Pieces */

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
                return "This browser can't draw the animated gradient (WebGL 2 is off or unavailable), so a still version shows instead.";
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

    /* Accent color and the palette shortcut, filled in as the browser answers */

    const applyAccent = (accent: string) => document.documentElement.style.setProperty("--accent", accent);
    const cachedAccent = readCachedAccent();
    if (cachedAccent) {
        applyAccent(cachedAccent);
    }
    const useAccent = (accent: string) => {
        applyAccent(accent);
        cacheAccent(accent);
    };
    void getSettings()
        .then((s) => useAccent(s.accent))
        .catch(() => {});
    onSettingsChanged((s) => useAccent(s.accent));

    // The key that's actually bound right now, which can differ from the stored one if changed in about:addons.
    void browser.commands
        .getAll()
        .then((commands) => {
            const shortcut = commands.find((c) => c.name === COMMAND_NAME)?.shortcut;
            if (!shortcut) {
                return;
            }
            for (const [i, part] of shortcut.split("+").entries()) {
                if (i > 0) {
                    searchKeys.append(h("span", { class: "key-join", text: "+" }));
                }
                searchKeys.append(h("kbd", { text: part }));
            }
        })
        .catch(() => {});

    /* Render */

    function render() {
        const bgKey = JSON.stringify(settings.background);
        if (bgKey !== appliedBackground) {
            appliedBackground = bgKey;
            void backdrop.apply(settings.background).then(() => {
                console.debug(`[tabdrift] new tab background ready ${Math.round(performance.now())} ms after load`);
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
    if (settings.search.show) {
        searchInput.focus();
    }
    console.debug(`[tabdrift] new tab drawn ${Math.round(performance.now())} ms after load`);

    /* Keyboard */

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

try {
    main();
} catch (err) {
    console.error("[tabdrift] new tab failed to start:", err);
}
