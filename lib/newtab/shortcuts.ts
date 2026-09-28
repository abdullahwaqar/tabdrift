import { parseAddress } from "../search";
import { h, ICONS } from "./dom";
import type { NewTabSettings, Shortcut } from "./settings";
import { newId } from "./settings";

type ShortcutSettings = NewTabSettings["shortcuts"];

export const TILES_PER_ROW = 8;

interface Tile {
    title: string;
    url: string;
    /** Set for tiles you pinned. Top sites have none. */
    pinnedId?: string;
}

interface TopSite {
    url: string;
    title?: string;
    favicon?: string;
    type?: string;
}

function firefoxTopSites() {
    return browser.topSites as unknown as {
        get(options: { newtab?: boolean; includeFavicon?: boolean; limit?: number }): Promise<TopSite[]>;
    };
}

function hostOf(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
        return "";
    }
}

/** A short readable name for a site with no title: "github.com" -> "github". */
function nameFromHost(host: string): string {
    const labels = host.split(".");
    const main = labels.length > 1 ? (labels[labels.length - 2] ?? host) : host;
    return main || host;
}

function hue(text: string): number {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 360;
}

/** Only http(s) favicons or inline images. Anything else (moz-anno, file:) won't load in this page. */
function usableIcon(url: string | undefined): string | undefined {
    if (!url) {
        return undefined;
    }
    return /^(https?:|data:image\/)/i.test(url) ? url : undefined;
}

export class Shortcuts {
    readonly el: HTMLElement;
    private readonly grid: HTMLElement;
    private readonly dialog: HTMLDialogElement;
    private readonly menu: HTMLElement;
    private settings: ShortcutSettings;
    private readonly save: (next: ShortcutSettings) => void;
    private topSites: TopSite[] = [];
    /** Favicons by host, from top sites and open tabs. */
    private icons = new Map<string, string>();
    /** The ⋯ button the open menu belongs to. */
    private anchor: HTMLElement | null = null;
    private dragId: string | null = null;
    /** The shortcut being edited in the dialog, or null when adding one. */
    private editing: Shortcut | null = null;

    constructor(settings: ShortcutSettings, save: (next: ShortcutSettings) => void) {
        this.settings = settings;
        this.save = save;
        this.grid = h("ol", { class: "tiles", attrs: { "aria-label": "Shortcuts" } });
        this.menu = this.buildMenu();
        this.dialog = this.buildDialog();
        this.el = h("nav", { class: "shortcuts" }, this.grid, this.menu, this.dialog);

        document.addEventListener("pointerdown", (e) => {
            const target = e.target as Node;
            if (!this.menu.hidden && !this.menu.contains(target) && !this.anchor?.contains(target)) {
                this.closeMenu();
            }
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && !this.menu.hidden) {
                this.closeMenu(true);
            }
        });
        window.addEventListener("blur", () => this.closeMenu());

        void this.loadSources().then(() => this.render());
        this.render();
    }

    update(settings: ShortcutSettings) {
        const topSitesTurnedOn = settings.topSites && !this.settings.topSites;
        this.settings = settings;
        this.el.hidden = !settings.show;
        if (topSitesTurnedOn) {
            void this.loadSources().then(() => this.render());
        }
        this.render();
    }

    private async loadSources() {
        const icons = new Map<string, string>();
        try {
            // Tabs first, so the (usually sharper) top-site icons win below.
            const tabs = await browser.tabs.query({});
            for (const tab of tabs) {
                const icon = usableIcon(tab.favIconUrl);
                const host = tab.url ? hostOf(tab.url) : "";
                if (icon && host) {
                    icons.set(host, icon);
                }
            }
        } catch (err) {
            console.warn("[tabdrift] tab icons unavailable:", err);
        }

        try {
            // Same list Firefox shows on its own new tab page, including sites pinned there.
            const sites = await firefoxTopSites().get({ newtab: true, includeFavicon: true, limit: 30 });
            this.topSites = sites.filter((s) => (s.type ?? "url") === "url" && /^https?:/i.test(s.url));
            for (const site of this.topSites) {
                const icon = usableIcon(site.favicon);
                const host = hostOf(site.url);
                if (icon && host) {
                    icons.set(host, icon);
                }
            }
        } catch (err) {
            console.warn("[tabdrift] top sites unavailable:", err);
            this.topSites = [];
        }
        this.icons = icons;
    }

    /** The last slot always holds the Add button, so a shortcut can be added even when top sites fill the rest. */
    private tiles(): Tile[] {
        const limit = this.settings.rows * TILES_PER_ROW - 1;
        const tiles: Tile[] = this.settings.pinned.map((s) => ({ title: s.title, url: s.url, pinnedId: s.id }));
        if (this.settings.topSites) {
            const taken = new Set(tiles.map((t) => hostOf(t.url)));
            const hidden = new Set(this.settings.hidden);
            for (const site of this.topSites) {
                const host = hostOf(site.url);
                if (hidden.has(site.url) || taken.has(host)) {
                    continue;
                }
                taken.add(host);
                tiles.push({ title: site.title || nameFromHost(host), url: site.url });
            }
        }
        return tiles.slice(0, limit);
    }

    private render() {
        this.grid.textContent = "";
        const tiles = this.tiles();
        for (const tile of tiles) {
            this.grid.append(this.buildTile(tile));
        }
        this.grid.append(this.buildAddTile());
    }

    private buildTile(tile: Tile): HTMLElement {
        const host = hostOf(tile.url);
        const iconUrl = this.icons.get(host);
        const monogram = h("span", { class: "tile-monogram", text: (tile.title || host).trim().charAt(0).toUpperCase() || "?" });
        const iconBox = h("span", { class: "tile-icon", attrs: { "aria-hidden": "true" } }, monogram);
        iconBox.style.setProperty("--tile-hue", String(hue(host)));
        if (iconUrl) {
            const img = h("img", { attrs: { src: iconUrl, alt: "", draggable: "false", referrerpolicy: "no-referrer" } });
            img.addEventListener("load", () => iconBox.classList.add("has-favicon"));
            img.addEventListener("error", () => img.remove());
            iconBox.append(img);
        }

        const link = h(
            "a",
            { class: "tile-link", attrs: { href: tile.url, title: `${tile.title}\n${tile.url}`, draggable: tile.pinnedId ? "true" : "false" } },
            iconBox,
            h("span", { class: "tile-title", text: tile.title }),
        );

        const moreBtn = h("button", {
            class: "tile-more",
            html: ICONS.more,
            attrs: { type: "button", "aria-label": `Options for ${tile.title}`, "aria-haspopup": "menu" },
        });
        moreBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (this.anchor === moreBtn) {
                this.closeMenu();
            } else {
                this.openMenu(tile, moreBtn);
            }
        });

        const item = h("li", { class: tile.pinnedId ? "tile pinned" : "tile" }, link, moreBtn);
        if (tile.pinnedId) {
            iconBox.append(h("span", { class: "tile-pin", html: ICONS.pin, attrs: { "aria-hidden": "true" } }));
            this.makeDraggable(item, link, tile.pinnedId);
        }
        return item;
    }

    private buildAddTile(): HTMLElement {
        const btn = h(
            "button",
            { class: "tile-link tile-add", attrs: { type: "button", title: "Add a shortcut" } },
            h("span", { class: "tile-icon", html: ICONS.plus, attrs: { "aria-hidden": "true" } }),
            h("span", { class: "tile-title", text: "Add" }),
        );
        btn.addEventListener("click", () => this.openDialog(null));
        return h("li", { class: "tile add" }, btn);
    }

    /* ------------------------------------------------------------------ */
    /* Reordering pinned tiles                                             */
    /* ------------------------------------------------------------------ */

    private makeDraggable(item: HTMLElement, link: HTMLElement, id: string) {
        link.addEventListener("dragstart", (e) => {
            this.dragId = id;
            item.classList.add("dragging");
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/uri-list", (link as HTMLAnchorElement).href);
            }
        });
        link.addEventListener("dragend", () => {
            this.dragId = null;
            item.classList.remove("dragging");
            for (const el of this.grid.querySelectorAll(".drop-target")) {
                el.classList.remove("drop-target");
            }
        });
        item.addEventListener("dragover", (e) => {
            if (!this.dragId || this.dragId === id) {
                return;
            }
            e.preventDefault();
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = "move";
            }
            item.classList.add("drop-target");
        });
        item.addEventListener("dragleave", () => item.classList.remove("drop-target"));
        item.addEventListener("drop", (e) => {
            e.preventDefault();
            item.classList.remove("drop-target");
            if (!this.dragId || this.dragId === id) {
                return;
            }
            const pinned = [...this.settings.pinned];
            const from = pinned.findIndex((s) => s.id === this.dragId);
            const to = pinned.findIndex((s) => s.id === id);
            if (from === -1 || to === -1) {
                return;
            }
            const [moved] = pinned.splice(from, 1);
            if (moved) {
                pinned.splice(to, 0, moved);
                this.commit({ ...this.settings, pinned });
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Tile menu                                                           */
    /* ------------------------------------------------------------------ */

    private buildMenu(): HTMLElement {
        const menu = h("div", { class: "menu glass", attrs: { role: "menu", hidden: true } });
        menu.addEventListener("keydown", (e) => {
            const items = [...menu.querySelectorAll<HTMLButtonElement>("button")];
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const next = items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
                next?.focus();
            }
        });
        return menu;
    }

    private openMenu(tile: Tile, anchor: HTMLElement) {
        this.closeMenu();
        this.menu.textContent = "";

        const item = (label: string, run: () => void, danger = false) => {
            const btn = h("button", { class: danger ? "danger" : "", text: label, attrs: { type: "button", role: "menuitem" } });
            btn.addEventListener("click", () => {
                this.closeMenu(true);
                run();
            });
            this.menu.append(btn);
        };

        if (tile.pinnedId) {
            const pinnedId = tile.pinnedId;
            item("Edit", () => {
                const shortcut = this.settings.pinned.find((s) => s.id === pinnedId);
                if (shortcut) {
                    this.openDialog(shortcut);
                }
            });
            item("Open in a new window", () => void browser.windows.create({ url: tile.url }));
            item("Unpin", () => this.commit({ ...this.settings, pinned: this.settings.pinned.filter((s) => s.id !== pinnedId) }), true);
        } else {
            item("Pin", () => this.commit({ ...this.settings, pinned: [...this.settings.pinned, { id: newId(), title: tile.title, url: tile.url }] }));
            item("Open in a new window", () => void browser.windows.create({ url: tile.url }));
            item("Remove", () => this.commit({ ...this.settings, hidden: [...new Set([...this.settings.hidden, tile.url])] }), true);
        }

        this.menu.hidden = false;
        const box = anchor.getBoundingClientRect();
        const host = this.el.getBoundingClientRect();
        const width = this.menu.offsetWidth;
        const left = Math.min(box.left - host.left, window.innerWidth - host.left - width - 12);
        this.menu.style.left = `${Math.max(left, -host.left + 12)}px`;
        this.menu.style.top = `${box.bottom - host.top + 6}px`;
        anchor.setAttribute("aria-expanded", "true");
        this.anchor = anchor;
        this.menu.querySelector<HTMLButtonElement>("button")?.focus();
    }

    private closeMenu(restoreFocus = false) {
        if (this.menu.hidden) {
            return;
        }
        this.menu.hidden = true;
        this.anchor?.setAttribute("aria-expanded", "false");
        if (restoreFocus && this.anchor?.isConnected) {
            this.anchor.focus();
        }
        this.anchor = null;
    }

    /* ------------------------------------------------------------------ */
    /* Add / edit dialog                                                   */
    /* ------------------------------------------------------------------ */

    private buildDialog(): HTMLDialogElement {
        const titleInput = h("input", {
            attrs: { id: "shortcut-title", name: "title", type: "text", autocomplete: "off", maxlength: 60, spellcheck: "false" },
        });
        const urlInput = h("input", {
            attrs: { id: "shortcut-url", name: "url", type: "text", autocomplete: "off", required: true, spellcheck: "false", placeholder: "example.com" },
        });
        const error = h("p", { class: "field-error", attrs: { role: "alert" } });
        const heading = h("h2", { class: "dialog-title", text: "Add shortcut" });
        const saveBtn = h("button", { class: "btn primary", text: "Add", attrs: { type: "submit" } });
        const cancelBtn = h("button", { class: "btn", text: "Cancel", attrs: { type: "button" } });

        const form = h(
            "form",
            { attrs: { method: "dialog", novalidate: true } },
            heading,
            h("label", { class: "field" }, h("span", { text: "Name" }), titleInput),
            h("label", { class: "field" }, h("span", { text: "Address" }), urlInput),
            error,
            h("div", { class: "dialog-actions" }, cancelBtn, saveBtn),
        );
        const dialog = h("dialog", { class: "dialog glass", attrs: { "aria-labelledby": "shortcut-dialog-title" } }, form);
        heading.id = "shortcut-dialog-title";

        cancelBtn.addEventListener("click", () => dialog.close());
        urlInput.addEventListener("input", () => {
            error.textContent = "";
        });
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            const address = parseAddress(urlInput.value);
            if (!address) {
                error.textContent = "Enter a web address, like example.com or https://example.com/page";
                urlInput.focus();
                return;
            }
            const title = titleInput.value.trim() || nameFromHost(hostOf(address.url));
            const pinned = [...this.settings.pinned];
            if (this.editing) {
                const at = pinned.findIndex((s) => s.id === this.editing?.id);
                if (at !== -1) {
                    pinned[at] = { ...this.editing, title, url: address.url };
                }
            } else {
                pinned.push({ id: newId(), title, url: address.url });
            }
            this.commit({ ...this.settings, pinned });
            dialog.close();
        });

        this.dialogParts = { heading, titleInput, urlInput, error, saveBtn };
        return dialog;
    }

    private dialogParts!: {
        heading: HTMLElement;
        titleInput: HTMLInputElement;
        urlInput: HTMLInputElement;
        error: HTMLElement;
        saveBtn: HTMLButtonElement;
    };

    private openDialog(shortcut: Shortcut | null) {
        this.editing = shortcut;
        const { heading, titleInput, urlInput, error, saveBtn } = this.dialogParts;
        heading.textContent = shortcut ? "Edit shortcut" : "Add shortcut";
        saveBtn.textContent = shortcut ? "Save" : "Add";
        titleInput.value = shortcut?.title ?? "";
        urlInput.value = shortcut?.url ?? "";
        error.textContent = "";
        this.dialog.showModal();
        (shortcut ? titleInput : urlInput).focus();
    }

    private commit(next: ShortcutSettings) {
        this.settings = next;
        this.render();
        this.save(next);
    }
}
