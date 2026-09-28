export type TimerPhase = "focus" | "break";
export type TimerStatus = "idle" | "running" | "paused";

export interface TimerState {
    phase: TimerPhase;
    status: TimerStatus;
    /** When the running session ends (ms since epoch). */
    endsAt: number | null;
    /** Time left on a paused session. */
    remainingMs: number | null;
    /** The session that finished last, so the background knows which alarm it already handled. */
    lastCompleted: { phase: TimerPhase; endsAt: number } | null;
}

export const TIMER_KEY = "local:tabdriftTimer";
export const TIMER_ALARM_PREFIX = "tabdrift-timer:";

export const IDLE_TIMER: TimerState = { phase: "focus", status: "idle", endsAt: null, remainingMs: null, lastCompleted: null };

export async function readTimer(): Promise<TimerState> {
    const result = await browser.storage.local.get(TIMER_KEY);
    return { ...IDLE_TIMER, ...(result[TIMER_KEY] as Partial<TimerState> | undefined) };
}

export async function writeTimer(state: TimerState): Promise<void> {
    await browser.storage.local.set({ [TIMER_KEY]: state });
}

export function otherPhase(phase: TimerPhase): TimerPhase {
    return phase === "focus" ? "break" : "focus";
}

/** If the running session is over, the state it moves to: the other phase, waiting to be started. */
export function settle(state: TimerState, now = Date.now()): TimerState {
    if (state.status !== "running" || state.endsAt === null || now < state.endsAt) {
        return state;
    }
    return {
        phase: otherPhase(state.phase),
        status: "idle",
        endsAt: null,
        remainingMs: null,
        lastCompleted: { phase: state.phase, endsAt: state.endsAt },
    };
}
