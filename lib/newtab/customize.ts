import { h, ICONS } from "./dom";
import { clearBackgroundImage, MAX_IMAGE_BYTES, saveBackgroundImage } from "./image-store";
import type { BackgroundMode, GradientSettings, HourCycle, NewTabSettings, Place, TemperatureUnit } from "./settings";
import { DEFAULT_NEWTAB_SETTINGS, GRADIENT_PRESETS, GRADIENT_SHAPES, MAX_GRADIENT_COLORS, matchingPreset } from "./settings";
import { searchPlaces } from "./weather";

export interface CustomizeHost {
    get(): NewTabSettings;
    /** `immediate` saves now; otherwise the save waits for the control to settle (sliders, color pickers). */
    set(next: NewTabSettings, immediate?: boolean): void;
    /** Why the gradient can't move or can't be drawn, if it can't. */
    gradientNote(): string | null;
    openTabdriftSettings(): void;
}

type Refresh = () => void;

let fieldCounter = 0;
function fieldId(): string {
    fieldCounter += 1;
    return `field-${fieldCounter}`;
}

export class Customize {
    readonly el: HTMLElement;
    private readonly body: HTMLElement;
    private readonly host: CustomizeHost;
    private refreshers: Refresh[] = [];
    private opener: HTMLElement | null = null;
    private placeSearch: AbortController | null = null;

    constructor(host: CustomizeHost) {
        this.host = host;
        const closeBtn = h("button", { class: "icon-btn", html: ICONS.close, attrs: { type: "button", "aria-label": "Close" } });
        closeBtn.addEventListener("click", () => this.close());
        this.body = h("div", { class: "drawer-body" });
        this.el = h(
            "aside",
            { class: "drawer glass", attrs: { role: "dialog", "aria-modal": "false", "aria-labelledby": "drawer-title", hidden: true, tabindex: "-1" } },
            h("header", { class: "drawer-head" }, h("h2", { class: "drawer-title", text: "Customize", attrs: { id: "drawer-title" } }), closeBtn),
            this.body,
        );
        this.el.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                this.close();
            }
        });
        this.build();
    }

    get isOpen(): boolean {
        return !this.el.hidden;
    }

    open(opener?: HTMLElement) {
        this.opener = opener ?? null;
        this.sync();
        this.el.hidden = false;
        opener?.setAttribute("aria-expanded", "true");
        requestAnimationFrame(() => this.el.classList.add("open"));
        this.el.querySelector<HTMLElement>(".drawer-head .icon-btn")?.focus();
    }

    close() {
        if (this.el.hidden) {
            return;
        }
        this.el.classList.remove("open");
        this.opener?.setAttribute("aria-expanded", "false");
        const done = () => {
            if (!this.el.classList.contains("open")) {
                this.el.hidden = true;
            }
        };
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            done();
        } else {
            this.el.addEventListener("transitionend", done, { once: true });
            setTimeout(done, 400);
        }
        this.opener?.focus();
    }

    toggle(opener?: HTMLElement) {
        if (this.isOpen) {
            this.close();
        } else {
            this.open(opener);
        }
    }

    /** Opens the drawer scrolled to the weather settings, with the place field focused. */
    openAtWeather(opener?: HTMLElement) {
        this.open(opener);
        const field = this.el.querySelector<HTMLInputElement>(".place-input");
        field?.scrollIntoView({ block: "center" });
        field?.focus();
    }

    /** Brings every control up to date with the current settings (after a change from another tab). */
    sync() {
        for (const refresh of this.refreshers) {
            refresh();
        }
    }

    private s(): NewTabSettings {
        return this.host.get();
    }

    private update(change: (s: NewTabSettings) => NewTabSettings, immediate = true) {
        this.host.set(change(this.s()), immediate);
        this.sync();
    }

    private build() {
        this.body.append(
            this.section("Background", this.backgroundControls()),
            this.section(
                "Clock",
                this.switchControl(
                    "Show the clock",
                    (s) => s.clock.show,
                    (s, v) => ({ ...s, clock: { ...s.clock, show: v } }),
                ),
                this.segmented<HourCycle>(
                    "Hours",
                    [
                        ["auto", "Auto"],
                        ["12", "12-hour"],
                        ["24", "24-hour"],
                    ],
                    (s) => s.clock.hourCycle,
                    (s, v) => ({ ...s, clock: { ...s.clock, hourCycle: v } }),
                    (s) => !s.clock.show,
                ),
                this.switchControl(
                    "Seconds",
                    (s) => s.clock.seconds,
                    (s, v) => ({ ...s, clock: { ...s.clock, seconds: v } }),
                    (s) => !s.clock.show,
                ),
                this.switchControl(
                    "Date",
                    (s) => s.clock.date,
                    (s, v) => ({ ...s, clock: { ...s.clock, date: v } }),
                    (s) => !s.clock.show,
                ),
            ),
            this.section(
                "Search",
                this.switchControl(
                    "Show the search box",
                    (s) => s.search.show,
                    (s, v) => ({ ...s, search: { show: v } }),
                ),
                h("p", { class: "hint", text: "It opens the Tabdrift palette: tabs, history and web search in one box." }),
            ),
            this.section("Shortcuts", ...this.shortcutControls()),
            this.section("Weather", ...this.weatherControls()),
            this.section(
                "To do",
                this.switchControl(
                    "Show the to-do list",
                    (s) => s.lists.show,
                    (s, v) => ({ ...s, lists: { show: v } }),
                ),
            ),
            this.section("Focus timer", ...this.timerControls()),
            this.footer(),
        );
    }

    private section(title: string, ...children: Node[]): HTMLElement {
        return h("section", { class: "drawer-section" }, h("h3", { class: "drawer-section-title", text: title }), ...children);
    }

    private footer(): HTMLElement {
        const reset = h("button", { class: "btn", text: "Reset look and widgets", attrs: { type: "button" } });
        let armed = false;
        reset.addEventListener("click", () => {
            if (!armed) {
                armed = true;
                reset.textContent = "Click again to reset";
                reset.classList.add("danger");
                setTimeout(() => {
                    armed = false;
                    reset.textContent = "Reset look and widgets";
                    reset.classList.remove("danger");
                }, 3000);
                return;
            }
            armed = false;
            reset.textContent = "Reset look and widgets";
            reset.classList.remove("danger");
            // Your shortcuts, place and picture are yours. Everything else goes back to how it shipped.
            this.update((s) => ({
                ...structuredClone(DEFAULT_NEWTAB_SETTINGS),
                background: { ...structuredClone(DEFAULT_NEWTAB_SETTINGS.background), imageVersion: s.background.imageVersion },
                shortcuts: { ...DEFAULT_NEWTAB_SETTINGS.shortcuts, pinned: s.shortcuts.pinned, hidden: s.shortcuts.hidden },
                weather: { ...DEFAULT_NEWTAB_SETTINGS.weather, place: s.weather.place, unit: s.weather.unit },
            }));
        });

        const more = h("button", { class: "link-btn", text: "Palette and shortcut key settings", attrs: { type: "button" } });
        more.addEventListener("click", () => this.host.openTabdriftSettings());
        return h("footer", { class: "drawer-foot" }, more, reset);
    }

    private switchControl(
        label: string,
        get: (s: NewTabSettings) => boolean,
        set: (s: NewTabSettings, value: boolean) => NewTabSettings,
        disabled?: (s: NewTabSettings) => boolean,
    ): HTMLElement {
        const id = fieldId();
        const input = h("input", { attrs: { id, type: "checkbox", role: "switch" } });
        input.addEventListener("change", () => this.update((s) => set(s, input.checked)));
        const row = h(
            "div",
            { class: "control" },
            h("label", { class: "control-label", text: label, attrs: { for: id } }),
            h("span", { class: "switch" }, input),
        );
        this.refreshers.push(() => {
            input.checked = get(this.s());
            const off = disabled?.(this.s()) ?? false;
            input.disabled = off;
            row.classList.toggle("disabled", off);
        });
        return row;
    }

    private segmented<T extends string>(
        label: string,
        options: [T, string][],
        get: (s: NewTabSettings) => T,
        set: (s: NewTabSettings, value: T) => NewTabSettings,
        disabled?: (s: NewTabSettings) => boolean,
    ): HTMLElement {
        const labelId = fieldId();
        const group = h("div", { class: "segmented", attrs: { role: "radiogroup", "aria-labelledby": labelId } });
        const buttons = options.map(([value, text]) => {
            const btn = h("button", { text, attrs: { type: "button", role: "radio" }, dataset: { value } });
            btn.addEventListener("click", () => this.update((s) => set(s, value)));
            group.append(btn);
            return btn;
        });
        group.addEventListener("keydown", (e) => {
            if (!["ArrowLeft", "ArrowRight"].includes(e.key)) {
                return;
            }
            e.preventDefault();
            const at = options.findIndex(([v]) => v === get(this.s()));
            const next = options[(at + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length];
            if (next) {
                this.update((s) => set(s, next[0]));
                buttons.find((b) => b.dataset.value === next[0])?.focus();
            }
        });
        const row = h("div", { class: "control" }, h("span", { class: "control-label", text: label, attrs: { id: labelId } }), group);
        this.refreshers.push(() => {
            const current = get(this.s());
            const off = disabled?.(this.s()) ?? false;
            row.classList.toggle("disabled", off);
            for (const btn of buttons) {
                const on = btn.dataset.value === current;
                btn.setAttribute("aria-checked", String(on));
                btn.tabIndex = on ? 0 : -1;
                btn.disabled = off;
            }
        });
        return row;
    }

    private slider(
        label: string,
        range: { min: number; max: number; step: number },
        get: (s: NewTabSettings) => number,
        set: (s: NewTabSettings, value: number) => NewTabSettings,
        format: (v: number) => string,
    ): HTMLElement {
        const id = fieldId();
        const input = h("input", { attrs: { id, type: "range", min: range.min, max: range.max, step: range.step } });
        const out = h("output", { class: "control-value", attrs: { for: id } });
        const paint = () => {
            const v = Number(input.value);
            out.textContent = format(v);
            input.style.setProperty("--fill", `${((v - range.min) / (range.max - range.min)) * 100}%`);
        };
        input.addEventListener("input", () => {
            paint();
            this.host.set(set(this.s(), Number(input.value)), false);
        });
        input.addEventListener("change", () => this.host.set(this.s(), true));
        const row = h("div", { class: "control slider" }, h("label", { class: "control-label", text: label, attrs: { for: id } }), out, input);
        this.refreshers.push(() => {
            // Don't fight the thumb while it's being dragged.
            if (document.activeElement !== input) {
                input.value = String(get(this.s()));
            }
            paint();
        });
        return row;
    }

    private colorInput(label: string, value: string, onInput: (value: string) => void, onRemove?: () => void): HTMLElement {
        const input = h("input", { class: "swatch-input", attrs: { type: "color", "aria-label": label, title: label } });
        input.value = value;
        input.addEventListener("input", () => onInput(input.value));
        input.addEventListener("change", () => this.host.set(this.s(), true));
        const swatch = h("span", { class: "swatch" }, input);
        swatch.style.setProperty("--swatch", value);
        input.addEventListener("input", () => swatch.style.setProperty("--swatch", input.value));
        if (onRemove) {
            const remove = h("button", { class: "swatch-remove", html: ICONS.close, attrs: { type: "button", "aria-label": `Remove ${label.toLowerCase()}` } });
            remove.addEventListener("click", onRemove);
            swatch.append(remove);
        }
        return swatch;
    }

    private backgroundControls(): HTMLElement {
        const wrap = h("div", { class: "bg-controls" });
        wrap.append(
            this.segmented<BackgroundMode>(
                "Style",
                [
                    ["gradient", "Gradient"],
                    ["image", "Picture"],
                    ["solid", "Color"],
                ],
                (s) => s.background.mode,
                (s, v) => ({ ...s, background: { ...s.background, mode: v } }),
            ),
        );

        const gradientPane = this.gradientControls();
        const imagePane = this.imageControls();
        const solidPane = h("div", { class: "pane" });
        const solidRow = h("div", { class: "control" }, h("span", { class: "control-label", text: "Color" }));
        solidPane.append(solidRow);

        this.refreshers.push(() => {
            const s = this.s();
            gradientPane.hidden = s.background.mode !== "gradient";
            imagePane.hidden = s.background.mode !== "image";
            solidPane.hidden = s.background.mode !== "solid";
            const existing = solidRow.querySelector(".swatch");
            if (!existing?.contains(document.activeElement)) {
                existing?.remove();
                solidRow.append(
                    this.colorInput("Background color", s.background.solid, (v) =>
                        this.host.set({ ...this.s(), background: { ...this.s().background, solid: v } }, false),
                    ),
                );
            }
        });

        wrap.append(gradientPane, imagePane, solidPane);
        return wrap;
    }

    private setGradient(change: (g: GradientSettings) => GradientSettings, immediate = false) {
        const s = this.s();
        this.host.set({ ...s, background: { ...s.background, gradient: change(s.background.gradient) } }, immediate);
    }

    private gradientControls(): HTMLElement {
        const pane = h("div", { class: "pane" });

        const presets = h("div", { class: "presets", attrs: { role: "radiogroup", "aria-label": "Presets" } });
        const presetBtns = GRADIENT_PRESETS.map((preset) => {
            const [a = "#000", b = a, c = b, d = c] = preset.gradient.colors;
            const btn = h(
                "button",
                { class: "preset", attrs: { type: "button", role: "radio", title: preset.name }, dataset: { id: preset.id } },
                h("span", { class: "preset-art", attrs: { "aria-hidden": "true" } }),
                h("span", { class: "preset-name", text: preset.name }),
            );
            const art = btn.firstElementChild as HTMLElement;
            art.style.background = [
                `radial-gradient(circle at 18% 22%, ${a} 0, transparent 58%)`,
                `radial-gradient(circle at 82% 30%, ${b} 0, transparent 55%)`,
                `radial-gradient(circle at 70% 85%, ${c} 0, transparent 60%)`,
                `radial-gradient(circle at 25% 80%, ${d} 0, transparent 55%)`,
                preset.gradient.colorBack,
            ].join(", ");
            btn.addEventListener("click", () => this.setGradient(() => structuredClone(preset.gradient), true));
            presets.append(btn);
            return btn;
        });

        const shapes = this.segmentedShape();

        const colorsRow = h("div", { class: "swatches" });
        const shuffle = h("button", { class: "btn small", attrs: { type: "button" } }, h("span", { class: "btn-icon", html: ICONS.shuffle }), "Shuffle");
        shuffle.addEventListener("click", () => {
            this.setGradient((g) => ({ ...g, ...shuffledPalette(g.colors.length) }), true);
            this.sync();
        });
        const colorsControl = h(
            "div",
            { class: "control stacked" },
            h("div", { class: "control-head" }, h("span", { class: "control-label", text: "Colors" }), shuffle),
            colorsRow,
        );

        const backRow = h("div", { class: "control" }, h("span", { class: "control-label", text: "Base" }));

        const note = h("p", { class: "hint" });

        pane.append(
            presets,
            shapes,
            colorsControl,
            backRow,
            this.slider(
                "Softness",
                { min: 0, max: 1, step: 0.01 },
                (s) => s.background.gradient.softness,
                (s, v) => withGradient(s, { softness: v }),
                percent,
            ),
            this.slider(
                "Distortion",
                { min: 0, max: 1, step: 0.01 },
                (s) => s.background.gradient.intensity,
                (s, v) => withGradient(s, { intensity: v }),
                percent,
            ),
            this.slider(
                "Grain",
                { min: 0, max: 1, step: 0.01 },
                (s) => s.background.gradient.noise,
                (s, v) => withGradient(s, { noise: v }),
                percent,
            ),
            this.slider(
                "Speed",
                { min: 0, max: 2, step: 0.05 },
                (s) => s.background.gradient.speed,
                (s, v) => withGradient(s, { speed: v }),
                (v) => (v === 0 ? "Still" : `${v.toFixed(2)}\u00d7`),
            ),
            this.slider(
                "Zoom",
                { min: 0.2, max: 3, step: 0.05 },
                (s) => s.background.gradient.scale,
                (s, v) => withGradient(s, { scale: v }),
                (v) => `${v.toFixed(2)}\u00d7`,
            ),
            this.slider(
                "Rotation",
                { min: 0, max: 360, step: 1 },
                (s) => s.background.gradient.rotation,
                (s, v) => withGradient(s, { rotation: v }),
                (v) => `${Math.round(v)}\u00b0`,
            ),
            note,
        );

        this.refreshers.push(() => {
            const g = this.s().background.gradient;
            const active = matchingPreset(g)?.id;
            for (const btn of presetBtns) {
                btn.setAttribute("aria-checked", String(btn.dataset.id === active));
            }

            if (!colorsRow.contains(document.activeElement)) {
                colorsRow.textContent = "";
                g.colors.forEach((color, i) => {
                    colorsRow.append(
                        this.colorInput(
                            `Color ${i + 1}`,
                            color,
                            (v) => this.setGradient((cur) => ({ ...cur, colors: cur.colors.map((c, j) => (j === i ? v : c)) })),
                            g.colors.length > 1
                                ? () => {
                                      this.setGradient((cur) => ({ ...cur, colors: cur.colors.filter((_, j) => j !== i) }), true);
                                      this.sync();
                                  }
                                : undefined,
                        ),
                    );
                });
                if (g.colors.length < MAX_GRADIENT_COLORS) {
                    const add = h("button", { class: "swatch-add", html: ICONS.plus, attrs: { type: "button", "aria-label": "Add a color" } });
                    add.addEventListener("click", () => {
                        this.setGradient((cur) => ({ ...cur, colors: [...cur.colors, randomColor()] }), true);
                        this.sync();
                    });
                    colorsRow.append(add);
                }
            }

            const back = backRow.querySelector(".swatch");
            if (!back?.contains(document.activeElement)) {
                back?.remove();
                backRow.append(this.colorInput("Base color", g.colorBack, (v) => this.setGradient((cur) => ({ ...cur, colorBack: v }))));
            }

            const message = this.host.gradientNote();
            note.textContent = message ?? "";
            note.hidden = !message;
        });
        return pane;
    }

    private segmentedShape(): HTMLElement {
        const group = this.segmented(
            "Shape",
            GRADIENT_SHAPES.map((shape): [string, string] => [shape.id, shape.name]),
            (s) => s.background.gradient.shape,
            (s, v) => withGradient(s, { shape: v as GradientSettings["shape"] }),
        );
        group.classList.add("stacked", "wrap");
        return group;
    }

    private imageControls(): HTMLElement {
        const pane = h("div", { class: "pane" });
        const fileInput = h("input", { class: "visually-hidden", attrs: { type: "file", accept: "image/*", tabindex: "-1" } });
        const chooseLabel = h("span", { text: "Choose a picture" });
        const choose = h("button", { class: "btn", attrs: { type: "button" } }, h("span", { class: "btn-icon", html: ICONS.upload }), chooseLabel);
        const remove = h("button", { class: "btn", text: "Remove", attrs: { type: "button" } });
        const status = h("p", { class: "hint", attrs: { role: "status" } });

        choose.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", async () => {
            const file = fileInput.files?.[0];
            fileInput.value = "";
            if (!file) {
                return;
            }
            if (!file.type.startsWith("image/")) {
                status.textContent = "That file isn't a picture. Pick a JPEG, PNG, WebP, GIF or AVIF.";
                return;
            }
            if (file.size > MAX_IMAGE_BYTES) {
                status.textContent = `That picture is ${(file.size / 1024 / 1024).toFixed(0)} MB. Pick one under ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`;
                return;
            }
            status.textContent = "Saving...";
            try {
                // Make sure it actually decodes before it replaces the current one.
                const bitmap = await createImageBitmap(file);
                bitmap.close();
                await saveBackgroundImage(file);
                status.textContent = "";
                this.update((s) => ({ ...s, background: { ...s.background, mode: "image", imageVersion: Date.now() } }));
            } catch (err) {
                console.error("[tabdrift] couldn't save the picture:", err);
                status.textContent = "Couldn't read that picture. Try another file.";
            }
        });
        remove.addEventListener("click", async () => {
            await clearBackgroundImage();
            this.update((s) => ({ ...s, background: { ...s.background, imageVersion: 0 } }));
        });

        pane.append(
            h("div", { class: "control" }, h("span", { class: "control-label", text: "Picture" }), h("span", { class: "btn-row" }, remove, choose)),
            fileInput,
            status,
            this.slider(
                "Dim",
                { min: 0, max: 0.8, step: 0.01 },
                (s) => s.background.imageDim,
                (s, v) => ({ ...s, background: { ...s.background, imageDim: v } }),
                percent,
            ),
            this.slider(
                "Blur",
                { min: 0, max: 40, step: 1 },
                (s) => s.background.imageBlur,
                (s, v) => ({ ...s, background: { ...s.background, imageBlur: v } }),
                (v) => (v === 0 ? "Off" : `${v}px`),
            ),
        );
        this.refreshers.push(() => {
            const has = this.s().background.imageVersion > 0;
            remove.hidden = !has;
            chooseLabel.textContent = has ? "Replace" : "Choose a picture";
        });
        return pane;
    }

    private shortcutControls(): HTMLElement[] {
        const restore = h("button", { class: "link-btn", attrs: { type: "button" } });
        restore.addEventListener("click", () => this.update((s) => ({ ...s, shortcuts: { ...s.shortcuts, hidden: [] } })));
        const restoreRow = h("div", { class: "control" }, h("span", { class: "control-label" }), restore);
        this.refreshers.push(() => {
            const n = this.s().shortcuts.hidden.length;
            restoreRow.hidden = n === 0;
            restore.textContent = `Bring back ${n} removed ${n === 1 ? "site" : "sites"}`;
        });
        return [
            this.switchControl(
                "Show shortcuts",
                (s) => s.shortcuts.show,
                (s, v) => ({ ...s, shortcuts: { ...s.shortcuts, show: v } }),
            ),
            this.switchControl(
                "Fill with sites you visit often",
                (s) => s.shortcuts.topSites,
                (s, v) => ({ ...s, shortcuts: { ...s.shortcuts, topSites: v } }),
                (s) => !s.shortcuts.show,
            ),
            this.segmented<"1" | "2">(
                "Rows",
                [
                    ["1", "One"],
                    ["2", "Two"],
                ],
                (s) => String(s.shortcuts.rows) as "1" | "2",
                (s, v) => ({ ...s, shortcuts: { ...s.shortcuts, rows: v === "2" ? 2 : 1 } }),
                (s) => !s.shortcuts.show,
            ),
            restoreRow,
            h("p", { class: "hint", text: "Pin a site from its \u22ef menu. Drag pinned sites to reorder them." }),
        ];
    }

    private weatherControls(): HTMLElement[] {
        const id = fieldId();
        const input = h("input", {
            class: "text-input place-input",
            attrs: { id, type: "search", placeholder: "Search for a city", autocomplete: "off", spellcheck: "false", "aria-controls": `${id}-results` },
        });
        const results = h("ul", { class: "place-results", attrs: { id: `${id}-results`, role: "listbox", "aria-label": "Places" } });
        const status = h("p", { class: "hint", attrs: { role: "status" } });
        const current = h("p", { class: "place-current" });
        let timer: ReturnType<typeof setTimeout> | null = null;

        const pick = async (place: Place) => {
            if (!(await this.allowLocationSharing())) {
                status.textContent = "Weather needs your OK to send the place you pick to Open-Meteo.";
                return;
            }
            input.value = "";
            results.textContent = "";
            status.textContent = "";
            this.update((s) => ({ ...s, weather: { ...s.weather, show: true, place } }));
        };

        const runSearch = async (query: string) => {
            this.placeSearch?.abort();
            const controller = new AbortController();
            this.placeSearch = controller;
            try {
                const places = await searchPlaces(query, controller.signal);
                if (controller.signal.aborted) {
                    return;
                }
                results.textContent = "";
                status.textContent = places.length === 0 ? `No places called \u201c${query}\u201d. Check the spelling or try a bigger city nearby.` : "";
                for (const place of places) {
                    const option = h(
                        "li",
                        { attrs: { role: "option", tabindex: "0", "aria-selected": "false" } },
                        h("span", { class: "place-name", text: place.name }),
                        h("span", { class: "place-detail", text: place.detail }),
                    );
                    option.addEventListener("click", () => void pick(place));
                    option.addEventListener("keydown", (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void pick(place);
                        } else if (e.key === "ArrowDown") {
                            e.preventDefault();
                            (option.nextElementSibling as HTMLElement | null)?.focus();
                        } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            ((option.previousElementSibling as HTMLElement | null) ?? input).focus();
                        }
                    });
                    results.append(option);
                }
            } catch (err) {
                if (!controller.signal.aborted) {
                    console.warn("[tabdrift] place search failed:", err);
                    status.textContent = "Couldn't reach Open-Meteo. Check your connection and try again.";
                }
            }
        };

        input.addEventListener("input", () => {
            if (timer) {
                clearTimeout(timer);
            }
            const query = input.value.trim();
            if (query.length < 2) {
                this.placeSearch?.abort();
                results.textContent = "";
                status.textContent = "";
                return;
            }
            timer = setTimeout(() => void runSearch(query), 300);
        });
        input.addEventListener("keydown", (e) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                (results.firstElementChild as HTMLElement | null)?.focus();
            }
        });

        this.refreshers.push(() => {
            const w = this.s().weather;
            current.textContent = w.place
                ? `Showing ${w.place.name}${w.place.detail ? `, ${w.place.detail}` : ""}`
                : "Pick a place to show its weather next to the date.";
        });

        return [
            this.switchControl(
                "Show the weather",
                (s) => s.weather.show,
                (s, v) => ({ ...s, weather: { ...s.weather, show: v } }),
            ),
            current,
            h("div", { class: "control stacked" }, h("label", { class: "control-label", text: "Place", attrs: { for: id } }), input),
            results,
            status,
            this.segmented<TemperatureUnit>(
                "Units",
                [
                    ["celsius", "\u00b0C"],
                    ["fahrenheit", "\u00b0F"],
                ],
                (s) => s.weather.unit,
                (s, v) => ({ ...s, weather: { ...s.weather, unit: v } }),
            ),
            h("p", { class: "hint", text: "Weather comes from open-meteo.com. Only the place you pick is sent, never your address or IP location." }),
        ];
    }

    private async allowLocationSharing(): Promise<boolean> {
        try {
            const request = browser.permissions.request as (p: { data_collection: string[] }) => Promise<boolean>;
            return await request({ data_collection: ["locationInfo"] });
        } catch {
            // This browser or version doesn't know the data_collection permission — nothing to ask for.
            return true;
        }
    }

    private timerControls(): HTMLElement[] {
        const minutes = (label: string, get: (s: NewTabSettings) => number, set: (s: NewTabSettings, v: number) => NewTabSettings, max: number) =>
            this.slider(label, { min: 1, max, step: 1 }, get, set, (v) => `${v} min`);

        const notifyId = fieldId();
        const notify = h("input", { attrs: { id: notifyId, type: "checkbox", role: "switch" } });
        const notifyStatus = h("p", { class: "hint", attrs: { role: "status" } });
        notify.addEventListener("change", async () => {
            notifyStatus.textContent = "";
            if (notify.checked) {
                // Must be asked for straight from the click, before anything else awaits.
                const granted = await browser.permissions.request({ permissions: ["notifications"] });
                if (!granted) {
                    notify.checked = false;
                    notifyStatus.textContent = "Firefox didn't allow notifications, so the timer will stay quiet.";
                    return;
                }
            }
            this.update((s) => ({ ...s, timer: { ...s.timer, notify: notify.checked } }));
        });
        const notifyRow = h(
            "div",
            { class: "control" },
            h("label", { class: "control-label", text: "Notify when a session ends", attrs: { for: notifyId } }),
            h("span", { class: "switch" }, notify),
        );
        this.refreshers.push(() => {
            const t = this.s().timer;
            notify.checked = t.notify;
            notify.disabled = !t.show;
            notifyRow.classList.toggle("disabled", !t.show);
        });

        return [
            this.switchControl(
                "Show the focus timer",
                (s) => s.timer.show,
                (s, v) => ({ ...s, timer: { ...s.timer, show: v } }),
            ),
            minutes(
                "Focus",
                (s) => s.timer.focusMinutes,
                (s, v) => ({ ...s, timer: { ...s.timer, focusMinutes: v } }),
                120,
            ),
            minutes(
                "Break",
                (s) => s.timer.breakMinutes,
                (s, v) => ({ ...s, timer: { ...s.timer, breakMinutes: v } }),
                60,
            ),
            notifyRow,
            notifyStatus,
        ];
    }
}

function percent(v: number): string {
    return `${Math.round(v * 100)}%`;
}

function withGradient(s: NewTabSettings, change: Partial<GradientSettings>): NewTabSettings {
    return { ...s, background: { ...s.background, gradient: { ...s.background.gradient, ...change } } };
}

function hslToHex(hue: number, sat: number, light: number): string {
    const s = sat / 100;
    const l = light / 100;
    const k = (n: number) => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return `#${[f(0), f(8), f(4)]
        .map((x) =>
            Math.round(x * 255)
                .toString(16)
                .padStart(2, "0"),
        )
        .join("")}`;
}

function randomColor(): string {
    return hslToHex(Math.random() * 360, 60 + Math.random() * 30, 45 + Math.random() * 25);
}

function shuffledPalette(count: number): Pick<GradientSettings, "colors" | "colorBack"> {
    const base = Math.random() * 360;
    const n = Math.max(2, Math.min(count, MAX_GRADIENT_COLORS));
    const colors: string[] = [];
    for (let i = 0; i < n; i++) {
        const accent = i === n - 1 && n > 2;
        const hue = accent ? base + 180 : base + (i * 70) / Math.max(1, n - 2);
        const light = [58, 72, 44, 80, 36, 66, 52][i] ?? 60;
        colors.push(hslToHex(((hue % 360) + 360) % 360, accent ? 70 : 60 + Math.random() * 30, light));
    }
    return { colors, colorBack: hslToHex(base, 45, 4) };
}
