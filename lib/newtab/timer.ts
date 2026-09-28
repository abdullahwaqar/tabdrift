/** Focus timer panel. The background script handles the alarm and the notification. */
import { h, ICONS } from "./dom";
import type { HourCycle, NewTabSettings } from "./settings";
import type { TimerPhase, TimerState } from "./timer-state";
import { IDLE_TIMER, otherPhase, readTimer, settle, TIMER_KEY, writeTimer } from "./timer-state";

type TimerSettings = NewTabSettings["timer"];

function format(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export class FocusTimer {
    readonly el: HTMLElement;
    private settings: TimerSettings;
    private state: TimerState = IDLE_TIMER;
    private tickTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly phaseBtns: Record<TimerPhase, HTMLButtonElement>;
    private readonly timeEl: HTMLElement;
    private readonly statusEl: HTMLElement;
    private readonly toggleBtn: HTMLButtonElement;
    private readonly resetBtn: HTMLButtonElement;
    private readonly skipBtn: HTMLButtonElement;
    private readonly progressEl: HTMLElement;
    private endFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

    constructor(settings: TimerSettings) {
        this.settings = settings;

        const phaseBtn = (phase: TimerPhase, label: string) => {
            const btn = h("button", { class: "chip", text: label, attrs: { type: "button", role: "radio" } });
            btn.addEventListener("click", () => this.choosePhase(phase));
            return btn;
        };
        this.phaseBtns = { focus: phaseBtn("focus", "Focus"), break: phaseBtn("break", "Break") };
        this.timeEl = h("div", { class: "timer-time", attrs: { role: "timer", "aria-live": "off" } });
        this.statusEl = h("p", { class: "timer-status", attrs: { "aria-live": "polite" } });
        this.toggleBtn = h("button", { class: "round-btn primary", attrs: { type: "button" } });
        this.resetBtn = h("button", { class: "round-btn", html: ICONS.reset, attrs: { type: "button", "aria-label": "Reset", title: "Reset" } });
        this.skipBtn = h("button", {
            class: "round-btn",
            html: ICONS.skip,
            attrs: { type: "button", "aria-label": "Skip to the next session", title: "Skip" },
        });
        this.progressEl = h("div", { class: "timer-progress", attrs: { "aria-hidden": "true" } });

        this.el = h(
            "section",
            { class: "panel timer glass", attrs: { "aria-labelledby": "timer-title" } },
            h(
                "header",
                { class: "panel-head" },
                h("h2", { class: "panel-title visually-hidden", text: "Focus timer", attrs: { id: "timer-title" } }),
                h("div", { class: "chips", attrs: { role: "radiogroup", "aria-label": "Session" } }, this.phaseBtns.focus, this.phaseBtns.break),
            ),
            this.timeEl,
            this.statusEl,
            h("div", { class: "timer-controls" }, this.resetBtn, this.toggleBtn, this.skipBtn),
            this.progressEl,
        );

        this.toggleBtn.addEventListener("click", () => this.toggle());
        this.resetBtn.addEventListener("click", () => this.commit({ ...this.state, status: "idle", endsAt: null, remainingMs: null }));
        this.skipBtn.addEventListener("click", () =>
            this.commit({ ...this.state, phase: otherPhase(this.state.phase), status: "idle", endsAt: null, remainingMs: null }),
        );

        browser.storage.onChanged.addListener((changes, area) => {
            if (area === "local" && changes[TIMER_KEY]) {
                this.state = { ...IDLE_TIMER, ...(changes[TIMER_KEY].newValue as Partial<TimerState> | undefined) };
                this.render();
            }
        });
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) {
                this.render();
            }
        });
        void readTimer().then((state) => {
            this.state = state;
            this.render();
        });
        this.render();
    }

    /** Matches the "until 3:40" time to the clock's 12 or 24 hour setting. */
    setHourCycle(cycle: HourCycle) {
        this.endFormat = new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
            hourCycle: cycle === "12" ? "h12" : cycle === "24" ? "h23" : undefined,
        });
    }

    update(settings: TimerSettings) {
        this.settings = settings;
        this.el.hidden = !settings.show;
        this.render();
    }

    private duration(phase: TimerPhase): number {
        return (phase === "focus" ? this.settings.focusMinutes : this.settings.breakMinutes) * 60_000;
    }

    private remaining(now = Date.now()): number {
        if (this.state.status === "running" && this.state.endsAt !== null) {
            return this.state.endsAt - now;
        }
        if (this.state.status === "paused" && this.state.remainingMs !== null) {
            return this.state.remainingMs;
        }
        return this.duration(this.state.phase);
    }

    private toggle() {
        const now = Date.now();
        if (this.state.status === "running") {
            this.commit({ ...this.state, status: "paused", endsAt: null, remainingMs: Math.max(0, this.remaining(now)) });
        } else {
            this.commit({ ...this.state, status: "running", endsAt: now + this.remaining(now), remainingMs: null });
        }
    }

    private choosePhase(phase: TimerPhase) {
        if (phase === this.state.phase && this.state.status === "idle") {
            return;
        }
        this.commit({ ...this.state, phase, status: "idle", endsAt: null, remainingMs: null });
    }

    private commit(state: TimerState) {
        this.state = state;
        this.render();
        void writeTimer(state);
    }

    private render() {
        if (this.tickTimer) {
            clearTimeout(this.tickTimer);
            this.tickTimer = null;
        }
        const now = Date.now();
        const settled = settle(this.state, now);
        if (settled !== this.state) {
            // Finished while this page was open. Whoever writes first wins; the result is the same.
            this.commit(settled);
            return;
        }

        const { phase, status } = this.state;
        const left = this.remaining(now);
        const total = this.duration(phase);

        for (const p of ["focus", "break"] as const) {
            this.phaseBtns[p].setAttribute("aria-checked", String(p === phase));
        }
        this.el.dataset.phase = phase;
        this.el.dataset.status = status;
        this.timeEl.textContent = format(left);

        const running = status === "running";
        this.toggleBtn.innerHTML = running ? ICONS.pause : ICONS.play;
        this.toggleBtn.setAttribute("aria-label", running ? "Pause" : status === "paused" ? "Resume" : "Start");
        this.toggleBtn.title = this.toggleBtn.getAttribute("aria-label") ?? "";
        this.resetBtn.disabled = status === "idle";

        this.statusEl.textContent = this.statusText(now);
        const done = total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 0;
        this.progressEl.style.setProperty("--progress", String(status === "idle" ? 0 : done));

        if (running && !document.hidden) {
            // Next whole second of the countdown.
            const wait = (((left % 1000) + 1000) % 1000) + 20;
            this.tickTimer = setTimeout(() => this.render(), wait);
        }
    }

    private statusText(now: number): string {
        const { status, phase, lastCompleted } = this.state;
        if (status === "running" && this.state.endsAt !== null) {
            const at = this.endFormat.format(this.state.endsAt);
            return `${phase === "focus" ? "Focusing" : "On a break"} until ${at}`;
        }
        if (status === "paused") {
            return "Paused";
        }
        // Just after a session ends, say what happened rather than repeating the button.
        if (lastCompleted && now - lastCompleted.endsAt < 10 * 60_000) {
            return lastCompleted.phase === "focus" ? "Session done. Take a break" : "Break's over. Ready when you are";
        }
        return phase === "focus" ? `${this.settings.focusMinutes} minute focus session` : `${this.settings.breakMinutes} minute break`;
    }
}
