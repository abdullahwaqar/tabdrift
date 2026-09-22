import type { SearchEngineId } from "../../lib/search";
import { SEARCH_ENGINES } from "../../lib/search";
import type { OverlayPosition, TabSearchSettings } from "../../lib/settings";
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
const cleanShortcut = document.getElementById("clean-shortcut") as HTMLDivElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;

let recording = false;
let currentShortcut = DEFAULT_SETTINGS.shortcut;
let currentPosition: OverlayPosition = DEFAULT_SETTINGS.position;
let currentEngine: SearchEngineId = DEFAULT_SETTINGS.searchEngine;

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

    // Show whatever key the clean-link command is bound to right now.
    const commands = await browser.commands.getAll();
    const cleanCommand = commands.find((c) => c.name === "copy-clean-url");
    renderKeycaps(cleanShortcut, cleanCommand?.shortcut || "Not set");
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
    const settings: TabSearchSettings = {
        shortcut: currentShortcut,
        accent: accentInput.value,
        position: currentPosition,
        quickCopy: quickCopyInput.checked,
        listOnOpen: listOnOpenInput.checked,
        groupHistory: groupHistoryInput.checked,
        keepOpenOnOpen: keepOpenInput.checked,
        searchEngine: currentEngine,
    };

    await saveSettings(settings);
    await browser.runtime.sendMessage({ action: "applyShortcut" });

    status.textContent = "Saved.";
    setTimeout(() => (status.textContent = ""), 1800);
});
