import { h } from "./dom";
import type { NewTabSettings, Place, TemperatureUnit } from "./settings";

const CACHE_KEY = "local:tabdriftWeather";
const CACHE_MS = 30 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

export interface WeatherReport {
    temperature: number;
    apparent: number;
    code: number;
    isDay: boolean;
    high: number;
    low: number;
}

interface CacheEntry {
    key: string;
    fetchedAt: number;
    report: WeatherReport;
}

type Condition = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

/** WMO weather interpretation codes, as documented by Open-Meteo. */
const WMO: Record<number, [string, Condition]> = {
    0: ["Clear", "clear"],
    1: ["Mostly clear", "partly"],
    2: ["Partly cloudy", "partly"],
    3: ["Overcast", "cloudy"],
    45: ["Fog", "fog"],
    48: ["Freezing fog", "fog"],
    51: ["Light drizzle", "drizzle"],
    53: ["Drizzle", "drizzle"],
    55: ["Heavy drizzle", "drizzle"],
    56: ["Freezing drizzle", "drizzle"],
    57: ["Freezing drizzle", "drizzle"],
    61: ["Light rain", "rain"],
    63: ["Rain", "rain"],
    65: ["Heavy rain", "rain"],
    66: ["Freezing rain", "rain"],
    67: ["Freezing rain", "rain"],
    71: ["Light snow", "snow"],
    73: ["Snow", "snow"],
    75: ["Heavy snow", "snow"],
    77: ["Snow grains", "snow"],
    80: ["Light showers", "rain"],
    81: ["Showers", "rain"],
    82: ["Heavy showers", "rain"],
    85: ["Snow showers", "snow"],
    86: ["Heavy snow showers", "snow"],
    95: ["Thunderstorm", "storm"],
    96: ["Thunderstorm, hail", "storm"],
    99: ["Thunderstorm, hail", "storm"],
};

const STROKE = `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`;
const CLOUD = `<path d="M7 18h10.5a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 7.2 10.1 4 4 0 0 0 7 18Z"/>`;
/** The same cloud raised a little, to leave room for rain or snow under it. */
const HIGH_CLOUD = `<path d="M7 15h10.5a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 7.2 7.1 4 4 0 0 0 7 15Z"/>`;
const SUN = `<circle cx="12" cy="12" r="4"/><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M5.6 18.4l1.1-1.1M17.3 6.7l1.1-1.1"/>`;
const MOON = `<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z"/>`;
const SMALL_SUN = `<circle cx="8.5" cy="8.5" r="3"/><path d="M8.5 2.5v1M2.5 8.5h1M4.3 4.3l.7.7M12.7 4.3l-.7.7"/>`;
const SMALL_MOON = `<path d="M12 9.5A4.5 4.5 0 0 1 6.5 4a4.5 4.5 0 1 0 5.5 5.5Z"/>`;
const PART_CLOUD = `<path d="M9 19h8.5a3 3 0 0 0 .35-5.98 4.5 4.5 0 0 0-8.63-.8A3.4 3.4 0 0 0 9 19Z"/>`;

function icon(condition: Condition, isDay: boolean): string {
    const body = {
        clear: isDay ? SUN : MOON,
        partly: (isDay ? SMALL_SUN : SMALL_MOON) + PART_CLOUD,
        cloudy: CLOUD,
        fog: `<path d="M4 9h16M6 13h12M4 17h16"/>`,
        drizzle: `${HIGH_CLOUD}<path d="M9 18.5v.5M12 19v.5M15 18.5v.5"/>`,
        rain: `${HIGH_CLOUD}<path d="M9 17.5 8 20M12.5 17.5l-1 2.5M16 17.5 15 20"/>`,
        snow: `${HIGH_CLOUD}<path d="M9 18.5h.01M12.5 20h.01M16 18.5h.01"/>`,
        storm: `${HIGH_CLOUD}<path d="m12.5 15.5-2 3h3l-2 3"/>`,
    }[condition];
    return `<svg viewBox="0 0 24 24" ${STROKE}>${body}</svg>`;
}

export function describe(code: number): [string, Condition] {
    return WMO[code] ?? ["Unknown", "cloudy"];
}

function cacheKey(place: Place, unit: TemperatureUnit): string {
    return `${place.latitude.toFixed(3)},${place.longitude.toFixed(3)},${unit}`;
}

async function readCache(): Promise<CacheEntry | null> {
    const result = await browser.storage.local.get(CACHE_KEY);
    return (result[CACHE_KEY] as CacheEntry | undefined) ?? null;
}

async function getJson<T>(url: URL): Promise<T> {
    const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
}

export async function fetchWeather(place: Place, unit: TemperatureUnit): Promise<WeatherReport> {
    const url = new URL(FORECAST_URL);
    url.searchParams.set("latitude", String(place.latitude));
    url.searchParams.set("longitude", String(place.longitude));
    url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,is_day");
    url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min");
    url.searchParams.set("temperature_unit", unit);
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "1");

    const data = await getJson<{
        current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number; is_day?: number };
        daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
    }>(url);
    const current = data.current;
    if (!current || typeof current.temperature_2m !== "number" || typeof current.weather_code !== "number") {
        throw new Error("Unexpected forecast response");
    }
    return {
        temperature: current.temperature_2m,
        apparent: current.apparent_temperature ?? current.temperature_2m,
        code: current.weather_code,
        isDay: current.is_day !== 0,
        high: data.daily?.temperature_2m_max?.[0] ?? current.temperature_2m,
        low: data.daily?.temperature_2m_min?.[0] ?? current.temperature_2m,
    };
}

/** Place search for the settings panel. */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
    const url = new URL(GEOCODE_URL);
    url.searchParams.set("name", query);
    url.searchParams.set("count", "6");
    url.searchParams.set("language", navigator.language.split("-")[0] || "en");
    url.searchParams.set("format", "json");
    const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
        results?: { name: string; latitude: number; longitude: number; admin1?: string; country?: string }[];
    };
    return (data.results ?? []).map((r) => ({
        name: r.name,
        detail: [r.admin1, r.country].filter((part) => part && part !== r.name).join(", "),
        latitude: r.latitude,
        longitude: r.longitude,
    }));
}

type WeatherSettings = NewTabSettings["weather"];

export class Weather {
    readonly el: HTMLElement;
    private settings: WeatherSettings;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private requestId = 0;
    private readonly iconEl: HTMLSpanElement;
    private readonly tempEl: HTMLSpanElement;
    private readonly detailEl: HTMLSpanElement;
    private readonly onSetup: () => void;

    constructor(settings: WeatherSettings, onSetup: () => void) {
        this.settings = settings;
        this.onSetup = onSetup;
        this.iconEl = h("span", { class: "weather-icon", attrs: { "aria-hidden": "true" } });
        this.tempEl = h("span", { class: "weather-temp" });
        this.detailEl = h("span", { class: "weather-detail" });
        this.el = h("button", { class: "weather", attrs: { type: "button" } }, this.iconEl, this.tempEl, this.detailEl);
        this.el.addEventListener("click", () => this.onSetup());

        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) {
                void this.refresh();
            }
        });
        browser.storage.onChanged.addListener((changes, area) => {
            if (area === "local" && changes[CACHE_KEY]?.newValue) {
                this.renderFromCache(changes[CACHE_KEY].newValue as CacheEntry);
            }
        });
        this.update(settings);
    }

    update(settings: WeatherSettings) {
        this.settings = settings;
        this.el.hidden = !settings.show || !settings.place;
        void this.refresh();
    }

    private renderFromCache(entry: CacheEntry) {
        const place = this.settings.place;
        if (place && entry.key === cacheKey(place, this.settings.unit)) {
            this.render(entry.report, place);
        }
    }

    private render(report: WeatherReport, place: Place) {
        const [label, condition] = describe(report.code);
        const unit = this.settings.unit === "fahrenheit" ? "F" : "C";
        this.iconEl.innerHTML = icon(condition, report.isDay);
        this.tempEl.textContent = `${Math.round(report.temperature)}\u00b0`;
        this.detailEl.textContent = `${label} in ${place.name}`;
        this.el.title = [
            `${label}, ${Math.round(report.temperature)}\u00b0${unit} in ${place.name}`,
            `Feels like ${Math.round(report.apparent)}\u00b0, high ${Math.round(report.high)}\u00b0, low ${Math.round(report.low)}\u00b0`,
            "Click to change the place",
        ].join("\n");
        this.el.classList.remove("stale");
    }

    private async refresh() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        const place = this.settings.place;
        if (!this.settings.show || !place || document.hidden) {
            return;
        }
        const key = cacheKey(place, this.settings.unit);
        const requestId = ++this.requestId;

        const cached = await readCache().catch(() => null);
        if (requestId !== this.requestId) {
            return;
        }
        const fresh = cached && cached.key === key && Date.now() - cached.fetchedAt < CACHE_MS;
        if (cached && cached.key === key) {
            this.render(cached.report, place);
        }
        if (fresh) {
            this.schedule(CACHE_MS - (Date.now() - cached.fetchedAt));
            return;
        }

        try {
            const report = await fetchWeather(place, this.settings.unit);
            if (requestId !== this.requestId) {
                return;
            }
            const entry: CacheEntry = { key, fetchedAt: Date.now(), report };
            this.render(report, place);
            await browser.storage.local.set({ [CACHE_KEY]: entry });
            this.schedule(CACHE_MS);
        } catch (err) {
            console.warn("[tabdrift] weather update failed:", err);
            if (!cached || cached.key !== key) {
                this.tempEl.textContent = "";
                this.iconEl.innerHTML = "";
                this.detailEl.textContent = `Weather for ${place.name} is unavailable`;
            }
            this.el.classList.add("stale");
            this.schedule(RETRY_MS);
        }
    }

    private schedule(ms: number) {
        this.refreshTimer = setTimeout(() => void this.refresh(), Math.max(ms, 10_000));
    }
}
