/** A simple to-do list, kept in storage.local and live across every open new tab. */
import { h, ICONS } from "./dom";
import { newId } from "./settings";

const STORAGE_KEY = "local:tabdriftLists";
const MAX_TEXT = 200;

interface Task {
    id: string;
    text: string;
    done: boolean;
}

interface ListsState {
    tasks: Task[];
}

async function readState(): Promise<ListsState> {
    const result = await browser.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY] as Partial<ListsState> | undefined;
    return { tasks: Array.isArray(stored?.tasks) ? stored.tasks : [] };
}

export class Lists {
    readonly el: HTMLElement;
    private readonly listEl: HTMLUListElement;
    private readonly input: HTMLInputElement;
    private readonly countEl: HTMLElement;
    private readonly clearBtn: HTMLButtonElement;
    private readonly emptyEl: HTMLElement;
    private tasks: Task[] = [];
    /** The task whose text is being edited, kept across re-renders from other tabs. */
    private editingId: string | null = null;
    /** What has been typed in the editor so far, so an update from another tab doesn't throw it away. */
    private editDraft = "";

    constructor() {
        this.countEl = h("span", { class: "panel-meta" });
        this.input = h("input", {
            class: "task-input",
            attrs: { type: "text", placeholder: "Add a task", maxlength: MAX_TEXT, "aria-label": "Add a task", autocomplete: "off" },
        });
        this.listEl = h("ul", { class: "tasks" });
        this.emptyEl = h("p", { class: "panel-empty", text: "Nothing on the list. Type a task and press Enter." });
        this.clearBtn = h("button", { class: "link-btn", text: "Clear done", attrs: { type: "button" } });

        this.el = h(
            "section",
            { class: "panel lists glass", attrs: { "aria-labelledby": "lists-title" } },
            h("header", { class: "panel-head" }, h("h2", { class: "panel-title", text: "To do", attrs: { id: "lists-title" } }), this.countEl),
            this.input,
            this.listEl,
            this.emptyEl,
            h("footer", { class: "panel-foot" }, this.clearBtn),
        );

        this.input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                const text = this.input.value.trim();
                if (text) {
                    this.input.value = "";
                    this.commit([...this.tasks, { id: newId(), text, done: false }]);
                }
            }
        });
        this.clearBtn.addEventListener("click", () => this.commit(this.tasks.filter((t) => !t.done)));

        browser.storage.onChanged.addListener((changes, area) => {
            if (area === "local" && changes[STORAGE_KEY]) {
                const next = changes[STORAGE_KEY].newValue as Partial<ListsState> | undefined;
                this.tasks = Array.isArray(next?.tasks) ? next.tasks : [];
                this.render();
            }
        });
        void readState().then((state) => {
            this.tasks = state.tasks;
            this.render();
        });
        this.render();
    }

    setVisible(show: boolean) {
        this.el.hidden = !show;
    }

    private commit(tasks: Task[]) {
        this.tasks = tasks;
        this.render();
        void browser.storage.local.set({ [STORAGE_KEY]: { tasks } satisfies ListsState });
    }

    private render() {
        const hadFocus = this.listEl.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
        this.listEl.textContent = "";
        for (const task of this.tasks) {
            this.listEl.append(this.buildTask(task));
        }
        const open = this.tasks.filter((t) => !t.done).length;
        const done = this.tasks.length - open;
        this.countEl.textContent = this.tasks.length === 0 ? "" : open === 0 ? "All done" : `${open} left`;
        this.emptyEl.hidden = this.tasks.length > 0;
        this.el.querySelector(".panel-foot")?.toggleAttribute("hidden", done === 0);

        const editor = this.listEl.querySelector<HTMLInputElement>(".task-edit");
        if (editor) {
            const task = this.tasks.find((t) => t.id === this.editingId);
            editor.focus();
            // Select everything when editing starts; keep the caret where it was when an update redraws the list.
            if (task && this.editDraft === task.text) {
                editor.select();
            }
        } else if (hadFocus) {
            this.listEl.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(hadFocus)}"]`)?.focus();
        }
    }

    private buildTask(task: Task): HTMLElement {
        const check = h("button", {
            class: "task-check",
            html: ICONS.check,
            dataset: { focusKey: `check-${task.id}` },
            attrs: { type: "button", role: "checkbox", "aria-checked": String(task.done), "aria-label": `Done: ${task.text}` },
        });
        check.addEventListener("click", () => this.commit(this.tasks.map((t) => (t.id === task.id ? { ...t, done: !t.done } : t))));

        const remove = h("button", {
            class: "task-remove icon-btn",
            html: ICONS.close,
            dataset: { focusKey: `remove-${task.id}` },
            attrs: { type: "button", "aria-label": `Delete ${task.text}`, title: "Delete" },
        });
        remove.addEventListener("click", () => this.commit(this.tasks.filter((t) => t.id !== task.id)));

        const item = h("li", { class: task.done ? "task done" : "task" }, check);
        if (this.editingId === task.id) {
            item.append(this.buildEditor(task));
        } else {
            const text = h("span", { class: "task-text", text: task.text, attrs: { title: "Double-click to edit" } });
            text.addEventListener("dblclick", () => {
                this.editingId = task.id;
                this.editDraft = task.text;
                this.render();
            });
            item.append(text);
        }
        item.append(remove);
        return item;
    }

    private buildEditor(task: Task): HTMLElement {
        const editor = h("input", { class: "task-edit", attrs: { type: "text", maxlength: MAX_TEXT, "aria-label": "Edit task" } });
        editor.value = this.editDraft;
        let finished = false;
        const finish = (save: boolean) => {
            if (finished) {
                return;
            }
            finished = true;
            this.editingId = null;
            const text = editor.value.trim();
            if (save && text && text !== task.text) {
                this.commit(this.tasks.map((t) => (t.id === task.id ? { ...t, text } : t)));
            } else {
                this.render();
            }
        };
        editor.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                finish(true);
            } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                finish(false);
            }
        });
        editor.addEventListener("input", () => {
            this.editDraft = editor.value;
        });
        // A re-render swaps the editor out. That isn't the user leaving it, so only a real blur saves.
        editor.addEventListener("blur", () => {
            if (editor.isConnected) {
                finish(true);
            }
        });
        return editor;
    }
}
