import { exportMarks, getMarks, importMarks, onMarksChanged } from "../../lib/marks";
import type { SearchProvider } from "../../lib/providers";
import { BUILTIN_PROVIDERS, isValidTemplate, keyProblem } from "../../lib/providers";
import type { SearchEngineId } from "../../lib/search";
import { SEARCH_ENGINES } from "../../lib/search";
import type { OverlayPosition, OverlayWidth, TabSearchSettings } from "../../lib/settings";
import { DEFAULT_SETTINGS, eventToShortcut, getSettings, saveSettings } from "../../lib/settings";

const shortcutInput = document.getElementById("shortcut-input") as HTMLButtonElement;
const miniBody = document.getElementById("mini-body") as HTMLDivElement;
const zones = document.querySelectorAll<HTMLButtonElement>(".zone");
const accentInput = document.getElementById("accent-input") as HTMLInputElement;
const accentValue = document.getElementById("accent-value") as HTMLSpanElement;
const quickCopyInput = document.getElementById("quick-copy") as HTMLInputElement;
const listOnOpenInput = document.getElementById("list-on-open") as HTMLInputElement;
const groupHistoryInput = document.getElementById("group-history") as HTMLInputElement;
const keepOpenInput = document.getElementById("keep-open") as HTMLInputElement;
const enginePicker = document.getElementById("engine-picker") as HTMLDivElement;
const widthPicker = document.getElementById("width-picker") as HTMLDivElement;
const showPreviewInput = document.getElementById("show-preview") as HTMLInputElement;
const providersOnInput = document.getElementById("providers-on") as HTMLInputElement;
const providersDetail = document.getElementById("providers-detail") as HTMLDivElement;
const builtinProvidersOnInput = document.getElementById("builtin-providers-on") as HTMLInputElement;
const builtinList = document.getElementById("builtin-providers") as HTMLUListElement;
const customList = document.getElementById("custom-providers") as HTMLUListElement;
const addProviderBtn = document.getElementById("add-provider") as HTMLButtonElement;
const exportMarksBtn = document.getElementById("export-marks") as HTMLButtonElement;
const importMarksBtn = document.getElementById("import-marks") as HTMLButtonElement;
const importFile = document.getElementById("import-file") as HTMLInputElement;
const marksCount = document.getElementById("marks-count") as HTMLSpanElement;
const markShortcutText = document.getElementById("mark-shortcut-text") as HTMLSpanElement;
const cleanShortcut = document.getElementById("clean-shortcut") as HTMLDivElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;
const openNewTab = document.getElementById("open-newtab") as HTMLButtonElement;

openNewTab.addEventListener("click", () => void browser.tabs.create({}));

let recording = false;
let currentShortcut = DEFAULT_SETTINGS.shortcut;
let currentPosition: OverlayPosition = DEFAULT_SETTINGS.position;
let currentEngine: SearchEngineId = DEFAULT_SETTINGS.searchEngine;
let currentWidth: OverlayWidth = DEFAULT_SETTINGS.width;

const WIDTHS: { id: OverlayWidth; label: string }[] = [
    { id: "compact", label: "Compact" },
    { id: "wide", label: "Wide" },
    { id: "full", label: "Full" },
];

init();

async function init() {
    const settings = await getSettings();
    currentShortcut = settings.shortcut;
    currentPosition = settings.position;

    renderKeycaps(shortcutInput, currentShortcut);
    setPosition(currentPosition);

    accentInput.value = settings.accent;
    setAccent(settings.accent);
    quickCopyInput.checked = settings.quickCopy;
    listOnOpenInput.checked = settings.listOnOpen;
    groupHistoryInput.checked = settings.groupHistory;
    keepOpenInput.checked = settings.keepOpenOnOpen;
    renderEnginePicker();
    setEngine(settings.searchEngine);
    renderWidthPicker();
    setWidth(settings.width);
    showPreviewInput.checked = settings.showPreview;
    providersOnInput.checked = settings.providersOn;
    builtinProvidersOnInput.checked = settings.builtinProvidersOn;
    renderBuiltinProviders();
    for (const p of settings.customProviders) {
        addProviderRow(p);
    }
    syncProvidersUi();
    await showMarksCount();
    onMarksChanged(() => void showMarksCount());

    // Show whatever key the clean-link command is bound to right now.
    const commands = await browser.commands.getAll();
    const cleanCommand = commands.find((c) => c.name === "copy-clean-url");
    renderKeycaps(cleanShortcut, cleanCommand?.shortcut || "Not set");
    const markCommand = commands.find((c) => c.name === "toggle-mark");
    markShortcutText.textContent = markCommand?.shortcut || "a shortcut you set in about:addons";
}

function renderKeycaps(target: HTMLElement, shortcut: string) {
    target.innerHTML = "";
    const parts = shortcut.split("+");
    parts.forEach((part, i) => {
        if (i > 0) {
            const join = document.createElement("span");
            join.className = "keycap-join";
            join.textContent = "+";
            target.appendChild(join);
        }
        const cap = document.createElement("span");
        cap.className = "keycap";
        cap.textContent = part;
        target.appendChild(cap);
    });
}

function setPosition(position: OverlayPosition) {
    currentPosition = position;
    miniBody.dataset.position = position;
    zones.forEach((zone) => {
        zone.setAttribute("aria-pressed", String(zone.dataset.position === position));
    });
}

function renderEnginePicker() {
    enginePicker.innerHTML = "";
    for (const engine of SEARCH_ENGINES) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("role", "radio");
        btn.dataset.engine = engine.id;
        btn.append(engine.name);
        const key = document.createElement("kbd");
        key.textContent = engine.key;
        btn.append(key);
        btn.addEventListener("click", () => setEngine(engine.id));
        enginePicker.appendChild(btn);
    }
}

function setEngine(id: SearchEngineId) {
    currentEngine = SEARCH_ENGINES.some((e) => e.id === id) ? id : DEFAULT_SETTINGS.searchEngine;
    for (const btn of enginePicker.querySelectorAll<HTMLButtonElement>("button")) {
        const on = btn.dataset.engine === currentEngine;
        btn.setAttribute("aria-checked", String(on));
        btn.tabIndex = on ? 0 : -1;
    }
}

// Arrow keys move between engines, like any radio group.
enginePicker.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        return;
    }
    e.preventDefault();
    const at = SEARCH_ENGINES.findIndex((en) => en.id === currentEngine);
    const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    const next = SEARCH_ENGINES[(at + step + SEARCH_ENGINES.length) % SEARCH_ENGINES.length];
    if (next) {
        setEngine(next.id);
        enginePicker.querySelector<HTMLButtonElement>(`[data-engine="${next.id}"]`)?.focus();
    }
});

function renderWidthPicker() {
    widthPicker.innerHTML = "";
    for (const w of WIDTHS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("role", "radio");
        btn.dataset.width = w.id;
        btn.textContent = w.label;
        btn.addEventListener("click", () => setWidth(w.id));
        widthPicker.appendChild(btn);
    }
}

function setWidth(id: OverlayWidth) {
    currentWidth = WIDTHS.some((w) => w.id === id) ? id : DEFAULT_SETTINGS.width;
    miniBody.dataset.width = currentWidth;
    for (const btn of widthPicker.querySelectorAll<HTMLButtonElement>("button")) {
        const on = btn.dataset.width === currentWidth;
        btn.setAttribute("aria-checked", String(on));
        btn.tabIndex = on ? 0 : -1;
    }
}

widthPicker.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        return;
    }
    e.preventDefault();
    const at = WIDTHS.findIndex((w) => w.id === currentWidth);
    const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    const next = WIDTHS[(at + step + WIDTHS.length) % WIDTHS.length];
    if (next) {
        setWidth(next.id);
        widthPicker.querySelector<HTMLButtonElement>(`[data-width="${next.id}"]`)?.focus();
    }
});

function renderBuiltinProviders() {
    builtinList.innerHTML = "";
    for (const p of BUILTIN_PROVIDERS) {
        const li = document.createElement("li");
        const key = document.createElement("kbd");
        key.textContent = p.keys.join(" ");
        li.append(key, p.name);
        builtinList.append(li);
    }
}

function syncProvidersUi() {
    providersDetail.hidden = !providersOnInput.checked;
    builtinList.dataset.off = String(!builtinProvidersOnInput.checked);
}

providersOnInput.addEventListener("change", syncProvidersUi);
builtinProvidersOnInput.addEventListener("change", syncProvidersUi);

function textInput(className: string, placeholder: string, label: string, value: string): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = className;
    input.placeholder = placeholder;
    input.value = value;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", label);
    return input;
}

function addProviderRow(p?: SearchProvider) {
    const li = document.createElement("li");
    li.className = "provider-edit";
    li.dataset.id = p?.id ?? `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const name = textInput("name", "Name, e.g. Spotify", "Provider name", p?.name ?? "");
    const keys = textInput("keys", "Key, e.g. sp", "Keys", p?.keys.join(" ") ?? "");
    const url = textInput("url", "https://open.spotify.com/search/{q}", "Search address", p?.url ?? "");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => li.remove());
    const error = document.createElement("p");
    error.className = "provider-error";
    error.setAttribute("aria-live", "polite");
    for (const input of [name, keys, url]) {
        input.addEventListener("input", () => {
            input.removeAttribute("aria-invalid");
            error.textContent = "";
        });
    }
    li.append(name, keys, remove, url, error);
    customList.append(li);
    if (!p) {
        name.focus();
    }
}

addProviderBtn.addEventListener("click", () => addProviderRow());

const KEY_MESSAGES = {
    empty: "Add a key, like sp.",
    format: "Keys can only use letters, numbers, . - and _ (up to 16 characters).",
    reserved: "g, b, d and n belong to the search engines. Pick another key.",
};

/** Reads your providers from the form. Returns null and flags the rows when something needs fixing. */
function readCustomProviders(): SearchProvider[] | null {
    const out: SearchProvider[] = [];
    const seen = new Set<string>();
    let ok = true;
    for (const li of customList.querySelectorAll<HTMLLIElement>("li.provider-edit")) {
        const name = li.querySelector<HTMLInputElement>("input.name") as HTMLInputElement;
        const keys = li.querySelector<HTMLInputElement>("input.keys") as HTMLInputElement;
        const url = li.querySelector<HTMLInputElement>("input.url") as HTMLInputElement;
        const error = li.querySelector<HTMLParagraphElement>(".provider-error") as HTMLParagraphElement;
        // A row you left completely empty is just dropped.
        if (!name.value.trim() && !keys.value.trim() && !url.value.trim()) {
            continue;
        }
        const keyList = keys.value
            .split(/[\s,]+/)
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean);
        let message = "";
        let bad: HTMLInputElement | null = null;
        const problem = keyList.length === 0 ? "empty" : keyList.map(keyProblem).find((x) => x !== null);
        const dupe = keyList.find((k) => seen.has(k));
        if (problem) {
            message = KEY_MESSAGES[problem];
            bad = keys;
        } else if (dupe) {
            message = `Another of your providers already uses ${dupe}.`;
            bad = keys;
        } else if (!isValidTemplate(url.value)) {
            message = "The address needs to start with https:// and have {q} where the search goes.";
            bad = url;
        }
        error.textContent = message;
        if (bad) {
            bad.setAttribute("aria-invalid", "true");
            ok = false;
            continue;
        }
        for (const k of keyList) {
            seen.add(k);
        }
        out.push({ id: li.dataset.id ?? "", name: name.value.trim() || keyList[0] || "Search", keys: keyList, url: url.value.trim() });
    }
    return ok ? out : null;
}

async function showMarksCount() {
    const n = (await getMarks()).length;
    marksCount.textContent = n === 0 ? "You have no marks yet." : `You have ${n} mark${n === 1 ? "" : "s"}.`;
}

function flashStatus(text: string) {
    status.textContent = text;
    setTimeout(() => (status.textContent = ""), 2400);
}

exportMarksBtn.addEventListener("click", async () => {
    const blob = new Blob([await exportMarks()], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `tabdrift-marks-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

importMarksBtn.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    importFile.value = "";
    if (!file) {
        return;
    }
    try {
        const added = await importMarks(await file.text());
        flashStatus(added === 0 ? "Nothing new to import." : `Imported ${added} mark${added === 1 ? "" : "s"}.`);
    } catch (err) {
        flashStatus(err instanceof Error ? err.message : "Couldn't read that file.");
    }
});

function setAccent(hex: string) {
    document.documentElement.style.setProperty("--accent", hex);
    accentValue.textContent = hex.toUpperCase();
}

shortcutInput.addEventListener("click", startRecording);
shortcutInput.addEventListener("keydown", (e) => {
    if (!recording) {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            startRecording();
        }
        return;
    }
    e.preventDefault();

    const combo = eventToShortcut(e as KeyboardEvent);
    if (!combo) {
        return;
    }

    currentShortcut = combo;
    renderKeycaps(shortcutInput, combo);
    stopRecording();
});

shortcutInput.addEventListener("blur", () => {
    if (recording) {
        stopRecording();
        renderKeycaps(shortcutInput, currentShortcut);
    }
});

function startRecording() {
    recording = true;
    shortcutInput.classList.add("recording");
    shortcutInput.innerHTML = '<span class="keycap-placeholder">Press a combo…</span>';
}

function stopRecording() {
    recording = false;
    shortcutInput.classList.remove("recording");
}

zones.forEach((zone) => {
    zone.addEventListener("click", () => {
        const position = zone.dataset.position as OverlayPosition;
        setPosition(position);
    });
});

accentInput.addEventListener("input", () => {
    setAccent(accentInput.value);
});

saveBtn.addEventListener("click", async () => {
    const customProviders = readCustomProviders();
    if (!customProviders) {
        // Show the rows that need fixing, without changing your on/off choice.
        providersDetail.hidden = false;
        customList.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
        status.textContent = "Check your providers.";
        return;
    }
    const settings: TabSearchSettings = {
        shortcut: currentShortcut,
        accent: accentInput.value,
        position: currentPosition,
        quickCopy: quickCopyInput.checked,
        listOnOpen: listOnOpenInput.checked,
        groupHistory: groupHistoryInput.checked,
        keepOpenOnOpen: keepOpenInput.checked,
        searchEngine: currentEngine,
        width: currentWidth,
        showPreview: showPreviewInput.checked,
        providersOn: providersOnInput.checked,
        builtinProvidersOn: builtinProvidersOnInput.checked,
        customProviders,
    };

    await saveSettings(settings);
    await browser.runtime.sendMessage({ action: "applyShortcut" });

    status.textContent = "Saved.";
    setTimeout(() => (status.textContent = ""), 1800);
});
