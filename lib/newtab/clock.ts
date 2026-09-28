import { h } from "./dom";
import type { NewTabSettings } from "./settings";

type ClockSettings = NewTabSettings["clock"];

/** Big clock and the date under it. Ticks on the second or minute boundary, not on a drifting interval. */
export class Clock {
    readonly el: HTMLElement;
    private readonly timeEl: HTMLTimeElement;
    private readonly mainEl: HTMLElement;
    private readonly secondsEl: HTMLElement;
    private readonly periodEl: HTMLElement;
    /** The date line. Placed by the page, next to the weather. */
    readonly dateEl: HTMLElement;
    private settings: ClockSettings;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private timeFormat!: Intl.DateTimeFormat;
    private readonly dateFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
    private readonly fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

    constructor(settings: ClockSettings) {
        this.settings = settings;
        this.mainEl = h("span", { class: "clock-main" });
        this.secondsEl = h("span", { class: "clock-seconds" });
        this.periodEl = h("span", { class: "clock-period" });
        this.timeEl = h("time", { class: "clock-time" }, this.mainEl, this.secondsEl, this.periodEl);
        this.dateEl = h("p", { class: "clock-date" });
        this.el = h("div", { class: "clock" }, this.timeEl);

        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) {
                this.tick();
            }
        });
        this.update(settings);
    }

    update(settings: ClockSettings) {
        this.settings = settings;
        this.el.hidden = !settings.show;
        this.dateEl.hidden = !settings.show || !settings.date;
        this.timeFormat = new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
            second: settings.seconds ? "2-digit" : undefined,
            hourCycle: settings.hourCycle === "12" ? "h12" : settings.hourCycle === "24" ? "h23" : undefined,
        });
        this.tick();
    }

    private tick() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (!this.settings.show) {
            return;
        }
        const now = new Date();
        this.render(now);

        // Wake up just after the next boundary. A hidden tab gets a catch-up tick on visibilitychange.
        const step = this.settings.seconds ? 1000 : 60_000;
        const wait = step - (now.getTime() % step) + 15;
        this.timer = setTimeout(() => this.tick(), wait);
    }

    private render(now: Date) {
        const parts = this.timeFormat.formatToParts(now);
        // Hour through minute, with the locale's own separator ("14:05", "14.05", "14 h 05").
        const from = parts.findIndex((p) => p.type === "hour");
        const to = parts.findIndex((p) => p.type === "minute");
        const main = parts
            .slice(from, to + 1)
            .map((p) => p.value)
            .join("");
        const seconds = parts.find((p) => p.type === "second")?.value ?? "";
        const period = parts.find((p) => p.type === "dayPeriod")?.value ?? "";

        this.mainEl.textContent = main;
        this.secondsEl.textContent = seconds;
        this.secondsEl.hidden = seconds === "";
        this.periodEl.textContent = period;
        this.periodEl.hidden = period === "";
        this.timeEl.dateTime = now.toISOString();
        this.timeEl.title = this.fullFormat.format(now);
        this.dateEl.textContent = this.dateFormat.format(now);
    }
}
