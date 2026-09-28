type Child = Node | string | null | undefined | false;

type Props = {
    class?: string;
    text?: string;
    /** Trusted, hard-coded markup only (icons). Never pass user or network text here. */
    html?: string;
    attrs?: Record<string, string | number | boolean>;
    dataset?: Record<string, string>;
    on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };
};

/** Creates an element. Text always goes in through textContent, so it can't inject markup. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (props.class) {
        el.className = props.class;
    }
    if (props.text !== undefined) {
        el.textContent = props.text;
    }
    if (props.html !== undefined) {
        el.innerHTML = props.html;
    }
    for (const [name, value] of Object.entries(props.attrs ?? {})) {
        if (value === false) {
            continue;
        }
        el.setAttribute(name, value === true ? "" : String(value));
    }
    for (const [name, value] of Object.entries(props.dataset ?? {})) {
        el.dataset[name] = value;
    }
    for (const [name, handler] of Object.entries(props.on ?? {})) {
        el.addEventListener(name, handler as EventListener);
    }
    for (const child of children) {
        if (child) {
            el.append(child);
        }
    }
    return el;
}

export const ICONS = {
    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm10 17-5.6-5.6"/></svg>`,
    sliders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    more: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg>`,
    pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3H7l3-3-1-6ZM12 13v7"/></svg>`,
    play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>`,
    pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>`,
    reset: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/></svg>`,
    skip: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6.2v11.6a.9.9 0 0 0 1.4.75l8.2-5.8a.9.9 0 0 0 0-1.5L7.4 5.45A.9.9 0 0 0 6 6.2Z"/><rect x="16.5" y="5.5" width="2.5" height="13" rx="1"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`,
    upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>`,
    shuffle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3.5c4.5 0 4.5 10 9 10H20M4 17h3.5c1.6 0 2.6-1.3 3.4-3M20 7h-3.5c-1.6 0-2.6 1.3-3.4 3"/><path d="m17 4 3 3-3 3M17 14l3 3-3 3"/></svg>`,
};
