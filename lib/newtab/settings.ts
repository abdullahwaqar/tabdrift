import type { GrainGradientShape } from "@paper-design/shaders";

export type BackgroundMode = "gradient" | "image" | "solid";

export const GRADIENT_SHAPES: { id: GrainGradientShape; name: string }[] = [
    { id: "corners", name: "Corners" },
    { id: "wave", name: "Wave" },
    { id: "blob", name: "Blob" },
    { id: "ripple", name: "Ripple" },
    { id: "sphere", name: "Sphere" },
    { id: "dots", name: "Dots" },
    { id: "truchet", name: "Truchet" },
];

export const MAX_GRADIENT_COLORS = 7;

export interface GradientSettings {
    colorBack: string;
    /** 1 to 7 hex colors. */
    colors: string[];
    shape: GrainGradientShape;
    /** 0 = hard edges, 1 = smooth blend. */
    softness: number;
    /** Distortion between the color bands, 0 to 1. */
    intensity: number;
    /** Grain on top, 0 to 1. */
    noise: number;
    /** 0 stops the animation. */
    speed: number;
    /** Zoom, 0.1 to 4. */
    scale: number;
    /** Degrees, 0 to 360. */
    rotation: number;
}

export interface Shortcut {
    id: string;
    title: string;
    url: string;
}

export interface Place {
    name: string;
    /** Region and country, for telling Springfields apart. */
    detail: string;
    latitude: number;
    longitude: number;
}

export type TemperatureUnit = "celsius" | "fahrenheit";
export type HourCycle = "auto" | "12" | "24";

export interface NewTabSettings {
    background: {
        mode: BackgroundMode;
        gradient: GradientSettings;
        solid: string;
        /** Darkens the picture so text stays readable, 0 to 0.8. */
        imageDim: number;
        /** Blur in px, 0 to 40. */
        imageBlur: number;
        /**
         * Changes whenever a new picture is saved (0 when there is none), so other
         * open new tabs know to reload it from IndexedDB.
         */
        imageVersion: number;
    };
    clock: {
        show: boolean;
        hourCycle: HourCycle;
        seconds: boolean;
        date: boolean;
    };
    search: {
        show: boolean;
    };
    shortcuts: {
        show: boolean;
        /** Fill the free slots with the sites you visit most. */
        topSites: boolean;
        rows: 1 | 2;
        pinned: Shortcut[];
        /** Top sites you removed, by URL. */
        hidden: string[];
    };
    weather: {
        show: boolean;
        place: Place | null;
        unit: TemperatureUnit;
    };
    lists: {
        show: boolean;
    };
    timer: {
        show: boolean;
        focusMinutes: number;
        breakMinutes: number;
        /** Show a system notification when a session ends. Needs the optional "notifications" permission. */
        notify: boolean;
    };
}

export interface GradientPreset {
    id: string;
    name: string;
    gradient: GradientSettings;
}

/** Hand-tuned looks. The first one is the default. */
export const GRADIENT_PRESETS: GradientPreset[] = [
    {
        id: "drift",
        name: "Drift",
        gradient: {
            colorBack: "#04060f",
            colors: ["#1b3bd8", "#5aa9ff", "#f2b38f", "#2a1470"],
            shape: "corners",
            softness: 0.75,
            intensity: 0.35,
            noise: 0.28,
            speed: 0.35,
            scale: 1.1,
            rotation: 0,
        },
    },
    {
        id: "ember",
        name: "Ember",
        gradient: {
            colorBack: "#0d0503",
            colors: ["#e0461c", "#f0a054", "#8a1238", "#2b0a24"],
            shape: "blob",
            softness: 0.6,
            intensity: 0.4,
            noise: 0.35,
            speed: 0.3,
            scale: 1.2,
            rotation: 0,
        },
    },
    {
        id: "lagoon",
        name: "Lagoon",
        gradient: {
            colorBack: "#00100f",
            colors: ["#00898c", "#4cc2a4", "#0b3d91", "#2f7d6a"],
            shape: "wave",
            softness: 0.8,
            intensity: 0.2,
            noise: 0.3,
            speed: 0.3,
            scale: 1,
            rotation: 20,
        },
    },
    {
        id: "violet",
        name: "Violet",
        gradient: {
            colorBack: "#000000",
            colors: ["#7300ff", "#eba8ff", "#00bfff", "#2a00ff"],
            shape: "corners",
            softness: 0.5,
            intensity: 0.5,
            noise: 0.25,
            speed: 0.5,
            scale: 1,
            rotation: 0,
        },
    },
    {
        id: "moss",
        name: "Moss",
        gradient: {
            colorBack: "#0f0e18",
            colors: ["#3e6172", "#a49b74", "#568c50"],
            shape: "blob",
            softness: 0.15,
            intensity: 0.15,
            noise: 0.5,
            speed: 0.3,
            scale: 1.3,
            rotation: 0,
        },
    },
    {
        id: "dune",
        name: "Dune",
        gradient: {
            colorBack: "#000a0f",
            colors: ["#b3680a", "#a3924d", "#7d6f69"],
            shape: "wave",
            softness: 0.7,
            intensity: 0.15,
            noise: 0.5,
            speed: 0.3,
            scale: 1,
            rotation: 0,
        },
    },
    {
        id: "orbit",
        name: "Orbit",
        gradient: {
            colorBack: "#05030c",
            colors: ["#ff7ab6", "#6b5bff", "#12d6ff"],
            shape: "sphere",
            softness: 0.7,
            intensity: 0.3,
            noise: 0.3,
            speed: 0.4,
            scale: 0.9,
            rotation: 0,
        },
    },
];

const DEFAULT_GRADIENT = (GRADIENT_PRESETS[0] as GradientPreset).gradient;

export const DEFAULT_NEWTAB_SETTINGS: NewTabSettings = {
    background: {
        mode: "gradient",
        gradient: { ...DEFAULT_GRADIENT, colors: [...DEFAULT_GRADIENT.colors] },
        solid: "#16171d",
        imageDim: 0.25,
        imageBlur: 0,
        imageVersion: 0,
    },
    clock: { show: true, hourCycle: "auto", seconds: false, date: true },
    search: { show: true },
    shortcuts: { show: true, topSites: true, rows: 1, pinned: [], hidden: [] },
    weather: { show: false, place: null, unit: "celsius" },
    lists: { show: true },
    timer: { show: true, focusMinutes: 25, breakMinutes: 5, notify: false },
};

const STORAGE_KEY = "local:tabdriftNewTab";

type Section = keyof NewTabSettings;

/**
 * Fills in anything missing from stored settings with the defaults, one
 * section at a time, so a setting added in a later version doesn't wipe the
 * rest of a section.
 */
export function withDefaults(stored: Partial<Record<Section, object>> | undefined): NewTabSettings {
    const d = DEFAULT_NEWTAB_SETTINGS;
    const s = stored ?? {};
    const background = { ...d.background, ...(s.background as Partial<NewTabSettings["background"]>) };
    background.gradient = sanitizeGradient({ ...d.background.gradient, ...background.gradient });
    return {
        background,
        clock: { ...d.clock, ...(s.clock as Partial<NewTabSettings["clock"]>) },
        search: { ...d.search, ...(s.search as Partial<NewTabSettings["search"]>) },
        shortcuts: { ...d.shortcuts, ...(s.shortcuts as Partial<NewTabSettings["shortcuts"]>) },
        weather: { ...d.weather, ...(s.weather as Partial<NewTabSettings["weather"]>) },
        lists: { ...d.lists, ...(s.lists as Partial<NewTabSettings["lists"]>) },
        timer: { ...d.timer, ...(s.timer as Partial<NewTabSettings["timer"]>) },
    };
}

function sanitizeGradient(g: GradientSettings): GradientSettings {
    const colors = Array.isArray(g.colors) ? g.colors.filter((c) => typeof c === "string").slice(0, MAX_GRADIENT_COLORS) : [];
    return {
        ...g,
        colors: colors.length > 0 ? colors : [...DEFAULT_GRADIENT.colors],
        shape: GRADIENT_SHAPES.some((s) => s.id === g.shape) ? g.shape : DEFAULT_GRADIENT.shape,
    };
}

export async function getNewTabSettings(): Promise<NewTabSettings> {
    const result = await browser.storage.local.get(STORAGE_KEY);
    return withDefaults(result[STORAGE_KEY] as Partial<Record<Section, object>> | undefined);
}

export async function saveNewTabSettings(settings: NewTabSettings): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEY]: settings });
}

export function onNewTabSettingsChanged(callback: (settings: NewTabSettings) => void) {
    browser.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[STORAGE_KEY]) {
            return;
        }
        callback(withDefaults(changes[STORAGE_KEY].newValue as Partial<Record<Section, object>> | undefined));
    });
}

/** The preset these settings match exactly, if any. */
export function matchingPreset(g: GradientSettings): GradientPreset | undefined {
    return GRADIENT_PRESETS.find((p) => sameGradient(p.gradient, g));
}

function sameGradient(a: GradientSettings, b: GradientSettings): boolean {
    const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
    return (
        same(a.colorBack, b.colorBack) &&
        a.colors.length === b.colors.length &&
        a.colors.every((c, i) => same(c, b.colors[i] ?? "")) &&
        a.shape === b.shape &&
        a.softness === b.softness &&
        a.intensity === b.intensity &&
        a.noise === b.noise &&
        a.speed === b.speed &&
        a.scale === b.scale &&
        a.rotation === b.rotation
    );
}

export function newId(): string {
    return crypto.randomUUID();
}
