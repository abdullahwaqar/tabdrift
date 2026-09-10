import type { TabSearchSettings } from "../../lib/settings";
import { DEFAULT_SETTINGS, eventToShortcut, getSettings, saveSettings } from "../../lib/settings";

const shortcutInput = document.getElementById("shortcut-input") as HTMLInputElement;
const accentInput = document.getElementById("accent-input") as HTMLInputElement;
const accentValue = document.getElementById("accent-value") as HTMLSpanElement;
const positionInputs = document.querySelectorAll<HTMLInputElement>('input[name="position"]');
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;

let recording = false;
let currentShortcut = DEFAULT_SETTINGS.shortcut;

init();

async function init() {
    const settings = await getSettings();
    currentShortcut = settings.shortcut;
    shortcutInput.value = settings.shortcut;
    accentInput.value = settings.accent;
    accentValue.textContent = settings.accent;
    document.documentElement.style.setProperty("--accent", settings.accent);

    positionInputs.forEach((el) => {
        el.checked = el.value === settings.position;
    });
}

shortcutInput.addEventListener("click", () => {
    recording = true;
    shortcutInput.classList.add("recording");
    shortcutInput.value = "Press a combo...";
});

shortcutInput.addEventListener("keydown", (e) => {
    if (!recording) {
        return;
    }
    e.preventDefault();

    const combo = eventToShortcut(e);
    if (!combo) {
        shortcutInput.value = "Needs Ctrl/Alt + a key";
        return;
    }

    currentShortcut = combo;
    shortcutInput.value = combo;
    recording = false;
    shortcutInput.classList.remove("recording");
});

shortcutInput.addEventListener("blur", () => {
    if (recording) {
        recording = false;
        shortcutInput.classList.remove("recording");
        shortcutInput.value = currentShortcut;
    }
});

accentInput.addEventListener("input", () => {
    accentValue.textContent = accentInput.value;
    document.documentElement.style.setProperty("--accent", accentInput.value);
});

saveBtn.addEventListener("click", async () => {
    const position = document.querySelector<HTMLInputElement>('input[name="position"]:checked')?.value as TabSearchSettings["position"] | undefined;

    const settings: TabSearchSettings = {
        shortcut: currentShortcut,
        accent: accentInput.value,
        position: position ?? DEFAULT_SETTINGS.position,
    };

    await saveSettings(settings);
    await browser.runtime.sendMessage({ action: "applyShortcut" });

    status.textContent = "Saved.";
    setTimeout(() => (status.textContent = ""), 1800);
});
