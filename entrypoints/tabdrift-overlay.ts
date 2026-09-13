import Fuse from "fuse.js";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import type { TabSearchSettings } from "../lib/settings";
import { getSettings, onSettingsChanged } from "../lib/settings";

interface TabInfo {
    id: number;
    title?: string;
    url?: string;
    favIconUrl?: string;
}

interface HistoryInfo {
    id: string;
    title?: string;
    url?: string;
    lastVisitTime: number;
}

type ResultRow = { kind: "tab"; data: TabInfo } | { kind: "history"; data: HistoryInfo };

const HISTORY_DEBOUNCE_MS = 120;
const HISTORY_LIMIT = 6;

const FUSE_OPTIONS = {
    keys: [
        { name: "title", weight: 0.6 },
        { name: "url", weight: 0.4 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
};

export default defineUnlistedScript(() => {
    const win = window as unknown as { __tabSearchInjected?: boolean };
    if (win.__tabSearchInjected) {
        return;
    }
    win.__tabSearchInjected = true;

    let host: HTMLDivElement | null = null;
    let shadow: ShadowRoot | null = null;
    let settings: TabSearchSettings | null = null;

    let tabs: TabInfo[] = [];
    let filtered: TabInfo[] = [];
    let historyResults: HistoryInfo[] = [];
    let selectedIndex = 0;
    let historyTimer: ReturnType<typeof setTimeout> | null = null;
    let historyRequestId = 0;

    let input: HTMLInputElement | null = null;
    let resultsEl: HTMLDivElement | null = null;
    let cardEl: HTMLDivElement | null = null;

    onSettingsChanged((next) => {
        settings = next;
        if (cardEl) {
            applyPositionAndAccent();
        }
    });

    function ensureOverlay() {
        if (host) {
            return;
        }

        host = document.createElement("div");
        host.id = "tabdrift-overlay-host";
        host.style.cssText = "position: fixed; inset: 0; z-index: 2147483647;";
        document.documentElement.appendChild(host);

        shadow = host.attachShadow({ mode: "closed" });
        shadow.innerHTML = STYLES + MARKUP;

        cardEl = shadow.getElementById("card") as HTMLDivElement;
        input = shadow.getElementById("search-input") as HTMLInputElement;
        resultsEl = shadow.getElementById("results") as HTMLDivElement;
        const scrim = shadow.getElementById("scrim") as HTMLDivElement;
        const settingsBtn = shadow.getElementById("settings-btn") as HTMLButtonElement;

        settingsBtn.addEventListener("click", () => {
            browser.runtime.sendMessage({ action: "openOptions" });
        });
        input.addEventListener("input", () => filterTabs(input?.value ?? ""));
        scrim.addEventListener("click", hideOverlay);
        shadow.addEventListener("keydown", handleKeydown as EventListener);
    }

    function applyPositionAndAccent() {
        if (!shadow || !settings) {
            return;
        }
        const wrapper = shadow.getElementById("wrapper") as HTMLDivElement;
        wrapper.dataset.position = settings.position;
        wrapper.style.setProperty("--accent", settings.accent);
    }

    async function showOverlay() {
        ensureOverlay();
        settings = await getSettings();
        applyPositionAndAccent();

        if (host) {
            host.style.display = "block";
        }
        shadow?.getElementById("scrim")?.classList.add("open");
        cardEl?.classList.add("open");

        tabs = await browser.runtime.sendMessage({ action: "getTabs" });
        filtered = [];
        historyResults = [];
        selectedIndex = 0;
        renderResults();

        if (input) {
            input.value = "";
            input.focus();
        }
    }

    function hideOverlay() {
        if (!host) {
            return;
        }
        if (historyTimer) {
            clearTimeout(historyTimer);
            historyTimer = null;
        }
        historyRequestId++;
        shadow?.getElementById("scrim")?.classList.remove("open");
        cardEl?.classList.remove("open");
        setTimeout(() => {
            if (host) {
                host.style.display = "none";
            }
        }, 120);
    }

    function filterTabs(query: string) {
        const q = query.trim();
        if (!q) {
            filtered = [];
            historyResults = [];
            selectedIndex = 0;
            renderResults();
            return;
        }

        const tabFuse = new Fuse(tabs, FUSE_OPTIONS);
        filtered = tabFuse.search(q).map((r) => r.item);
        selectedIndex = 0;
        renderResults();
        queueHistorySearch(q);
    }

    function queueHistorySearch(query: string) {
        if (historyTimer) {
            clearTimeout(historyTimer);
        }
        const requestId = ++historyRequestId;
        historyTimer = setTimeout(async () => {
            const raw = (await browser.runtime.sendMessage({ action: "searchHistory", query })) as HistoryInfo[];
            // Bail if the input changed (or overlay closed) while this was in flight.
            if (requestId !== historyRequestId || input?.value.trim() !== query) {
                return;
            }

            const openUrls = new Set(tabs.map((t) => t.url));
            const candidates = raw.filter((h) => h.url && !openUrls.has(h.url));

            const historyFuse = new Fuse(candidates, FUSE_OPTIONS);
            historyResults = historyFuse
                .search(query)
                .slice(0, HISTORY_LIMIT)
                .map((r) => r.item);

            renderResults();
        }, HISTORY_DEBOUNCE_MS);
    }

    function getRows(): ResultRow[] {
        return [...filtered.map((data): ResultRow => ({ kind: "tab", data })), ...historyResults.map((data): ResultRow => ({ kind: "history", data }))];
    }

    function renderResults() {
        if (!resultsEl) {
            return;
        }
        resultsEl.innerHTML = "";

        const rows = getRows();

        if (rows.length === 0) {
            const empty = document.createElement("div");
            empty.className = "empty";
            empty.textContent = input?.value.trim() ? "No matching tabs or history" : "Start typing to search";
            resultsEl.appendChild(empty);
            return;
        }

        let historyHeaderShown = false;

        rows.forEach((row, i) => {
            if (row.kind === "history" && !historyHeaderShown) {
                const header = document.createElement("div");
                header.className = "section-header";
                header.textContent = "From history";
                resultsEl?.appendChild(header);
                historyHeaderShown = true;
            }

            const el = document.createElement("div");
            el.className = `row${i === selectedIndex ? " selected" : ""}`;

            const icon = document.createElement("img");
            icon.className = "favicon";
            icon.src = row.kind === "tab" ? row.data.favIconUrl || "" : "";
            icon.addEventListener("error", () => (icon.style.visibility = "hidden"));
            if (row.kind === "history") {
                icon.style.visibility = "hidden";
            }

            const text = document.createElement("div");
            text.className = "text";

            const title = document.createElement("div");
            title.className = "title";
            title.textContent = row.data.title || "Untitled";

            const url = document.createElement("div");
            url.className = "url";
            url.textContent = row.data.url || "";

            text.append(title, url);
            el.append(icon, text);

            if (row.kind === "history") {
                const badge = document.createElement("span");
                badge.className = "badge";
                badge.textContent = "history";
                el.append(badge);
            }

            el.addEventListener("click", () => activateRow(row));
            const capturedIndex = i;
            el.addEventListener("mouseenter", () => {
                selectedIndex = capturedIndex;
                renderResults();
            });

            resultsEl?.appendChild(el);
        });

        const domIndex = historyHeaderShown && selectedIndex >= filtered.length ? selectedIndex + 1 : selectedIndex;
        resultsEl.children[domIndex]?.scrollIntoView({ block: "nearest" });
    }

    async function activateRow(row: ResultRow) {
        if (row.kind === "tab") {
            await switchToTab(row.data.id);
        } else {
            await openHistoryEntry(row.data.url);
        }
    }

    async function switchToTab(tabId: number) {
        hideOverlay();
        await browser.runtime.sendMessage({ action: "switchTab", tabId });
    }

    async function openHistoryEntry(url: string | undefined) {
        if (!url) {
            return;
        }
        hideOverlay();
        await browser.runtime.sendMessage({ action: "openHistoryUrl", url });
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") {
            e.preventDefault();
            hideOverlay();
        } else if (e.key === "Enter") {
            e.preventDefault();
            const rows = getRows();
            const target = rows[selectedIndex];
            if (target) {
                activateRow(target);
            }
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, getRows().length - 1);
            renderResults();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            renderResults();
        }
    }

    browser.runtime.onMessage.addListener((message) => {
        if (message?.action === "showTabSearch") {
            if (host && host.style.display === "block") {
                hideOverlay();
            } else {
                showOverlay();
            }
        }
    });
});

const MARKUP = `
  <div id="scrim"></div>
  <div id="wrapper" data-position="center">
    <div id="card">
      <div id="input-wrap">
        <svg id="search-icon" viewBox="0 0 24 24" width="18" height="18">
          <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm10 17-5.6-5.6" />
        </svg>
        <input id="search-input" type="text" placeholder="Search open tabs and history..." autocomplete="off" spellcheck="false" />
        <button id="settings-btn" title="Settings" type="button">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.14-1.4l2.03-1.58-2-3.46-2.4.96a7.5 7.5 0 0 0-2.42-1.4L14.1 3h-4.2l-.37 2.52a7.5 7.5 0 0 0-2.4 1.4l-2.42-.96-2 3.46L4.74 10.6A7.4 7.4 0 0 0 4.6 12c0 .47.05.94.14 1.4l-2.03 1.58 2 3.46 2.4-.96a7.5 7.5 0 0 0 2.42 1.4L10.9 21h4.2l.38-2.52a7.5 7.5 0 0 0 2.4-1.4l2.42.96 2-3.46-2.03-1.58c.09-.46.14-.93.14-1.4Z" />
          </svg>
        </button>
      </div>
      <div id="results"></div>
      <div id="footer">
        <span>&uarr;&darr; navigate &nbsp;&bull;&nbsp; Enter switch &nbsp;&bull;&nbsp; Esc close</span>
        <span id="brand">Tabdrift</span>
      </div>
    </div>
  </div>
`;

const STYLES = `
<style>
  :host, * { box-sizing: border-box; }

  #scrim {
    position: fixed;
    inset: 0;
    background: rgba(10, 10, 14, 0.35);
    backdrop-filter: blur(3px);
    opacity: 0;
    transition: opacity 0.15s ease;
    pointer-events: none;
  }
  #scrim.open { opacity: 1; pointer-events: auto; }

  #wrapper {
    --accent: #3b82f6;
    position: fixed;
    inset: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 10vh 20px;
    pointer-events: none;
  }
  #wrapper[data-position="top"] { align-items: flex-start; }
  #wrapper[data-position="bottom"] { align-items: flex-end; }

  #card {
    width: 640px;
    max-width: 92vw;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    border-radius: 16px;
    overflow: hidden;
    background: rgba(30, 30, 34, 0.72);
    backdrop-filter: blur(24px) saturate(160%);
    -webkit-backdrop-filter: blur(24px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow:
      0 24px 60px -12px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(255, 255, 255, 0.04) inset;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #f1f1f3;
    opacity: 0;
    transform: scale(0.97) translateY(-6px);
    transition: opacity 0.15s ease, transform 0.15s ease;
    pointer-events: auto;
  }
  #card.open { opacity: 1; transform: scale(1) translateY(0); }

  #input-wrap {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  #search-icon { color: var(--accent); flex-shrink: 0; }
  #search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 17px;
    color: #f8f8f8;
    letter-spacing: 0.01em;
  }
  #search-input::placeholder { color: rgba(255, 255, 255, 0.4); }

  #results {
    overflow-y: auto;
    max-height: 50vh;
  }
  #results::-webkit-scrollbar { width: 8px; }
  #results::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
    border-radius: 8px;
  }

  .empty {
    padding: 48px 20px;
    text-align: center;
    color: rgba(255, 255, 255, 0.45);
    font-size: 14px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 20px;
    cursor: pointer;
    transition: background 0.08s ease;
  }
  .row:hover { background: rgba(255, 255, 255, 0.05); }
  .row.selected { background: color-mix(in srgb, var(--accent) 28%, transparent); }

  .section-header {
    padding: 8px 20px 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: rgba(255, 255, 255, 0.35);
  }

  .badge {
    flex-shrink: 0;
    font-size: 10.5px;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.5);
  }

  .favicon { width: 18px; height: 18px; flex-shrink: 0; border-radius: 3px; }

  .text { flex: 1; min-width: 0; }
  .title {
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .url {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.45);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
  }

  #footer {
    display: flex;
    justify-content: space-between;
    padding: 9px 20px;
    font-size: 11.5px;
    color: rgba(255, 255, 255, 0.4);
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  #brand { color: var(--accent); font-weight: 600; }

  #settings-btn {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.4);
    cursor: pointer;
    padding: 4px;
    display: flex;
    flex-shrink: 0;
    border-radius: 6px;
    transition: color 0.1s ease, background 0.1s ease;
  }
  #settings-btn:hover {
    color: var(--accent);
    background: rgba(255, 255, 255, 0.08);
  }
</style>
`;
