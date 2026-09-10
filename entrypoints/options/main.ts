import type { OverlayPosition, TabSearchSettings } from "../../lib/settings";
import { DEFAULT_SETTINGS, eventToShortcut, getSettings, saveSettings } from "../../lib/settings";

const shortcutInput = document.getElementById("shortcut-input") as HTMLButtonElement;
const miniBody = document.getElementById("mini-body") as HTMLDivElement;
const zones = document.querySelectorAll<HTMLButtonElement>(".zone");
const accentInput = document.getElementById("accent-input") as HTMLInputElement;
const accentValue = document.getElementById("accent-value") as HTMLSpanElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;

let recording = false;
let currentShortcut = DEFAULT_SETTINGS.shortcut;
let currentPosition: OverlayPosition = DEFAULT_SETTINGS.position;

init();

async function init() {
    const settings = await getSettings();
    currentShortcut = settings.shortcut;
    currentPosition = settings.position;

    renderKeycaps(currentShortcut);
    setPosition(currentPosition);

    accentInput.value = settings.accent;
    setAccent(settings.accent);
}

function renderKeycaps(shortcut: string) {
    shortcutInput.innerHTML = "";
    const parts = shortcut.split("+");
    parts.forEach((part, i) => {
        if (i > 0) {
            const join = document.createElement("span");
            join.className = "keycap-join";
            join.textContent = "+";
            shortcutInput.appendChild(join);
        }
        const cap = document.createElement("span");
        cap.className = "keycap";
        cap.textContent = part;
        shortcutInput.appendChild(cap);
    });
}

function setPosition(position: OverlayPosition) {
    currentPosition = position;
    miniBody.dataset.position = position;
    zones.forEach((zone) => {
        zone.setAttribute("aria-pressed", String(zone.dataset.position === position));
    });
}

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
    renderKeycaps(combo);
    stopRecording();
});

shortcutInput.addEventListener("blur", () => {
    if (recording) {
        stopRecording();
        renderKeycaps(currentShortcut);
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
    };

    await saveSettings(settings);
    await browser.runtime.sendMessage({ action: "applyShortcut" });

    status.textContent = "Saved.";
    setTimeout(() => (status.textContent = ""), 1800);
});
