# Tabdrift

![Tabdrift search overlay](./site/assets/social/tabdrift-social-1200x630.png)

A fast, keyboard-first tab switcher for Firefox. Press a shortcut, type a
few letters, jump straight to the tab you meant.

## What it does

Tabdrift opens a floating search overlay over whatever page you're on.
It filters your open tabs by title or URL as you type, across every
window, and switches to the one you pick with the arrow keys and enter.
Matching is fuzzy (via Fuse.js), so typos and out-of-order words still
find the right tab.

If nothing in your open tabs matches, Tabdrift also searches your
browsing history in the background and lists close matches underneath,
marked "history". Pick one and it opens in a new tab. This needs the
`history` permission; searches never leave your machine.

### History by site

Some sites (dashboards, admin panels) fill your history with dozens of long
links that carry IDs and session details. History results are grouped by
site, so you get one row per site with a page count instead of a wall of URLs.

- **Enter** opens the site's front page, and the site takes you where you
  need to go (login, last workspace).
- **Shift+Enter** opens the last page you visited on that site.
- **Right arrow** (with the cursor at the end of the search box) on a site row
  lists its pages underneath, most recent first. Pick one with the arrow keys
  and Enter to open that exact page. **Left arrow** collapses them again.
- **Right arrow** on a page (or on a site row that is already expanded) swaps
  the list for that link's copy options: clean link, site link, domain, root
  domain, Markdown link. **Left arrow** or **Esc** goes back.

Turn this off with "Group history by site" in settings to list every page.

### Open several results from one search

**Ctrl+Enter** (**Cmd+Enter** on a Mac) opens the highlighted history result
in a background tab and keeps the overlay open, with your search and
highlight where they were. Arrow down and press it again to open the next
one. It works on history rows and on the "open" rows under Utilities, and
Shift+Ctrl+Enter opens a site's last page instead of its front page.
Clicking a row with Ctrl held does the same. Switching to an open tab always
closes the overlay.

Turn on "Keep overlay open after opening a link" in settings to swap the two
keys: Enter opens in the background and stays, and Ctrl+Enter opens and
closes.

Default shortcut: `Alt+Shift+K`. Shortcut, overlay position, and accent
color are all configurable from the settings page.

## Search the web and open addresses

Tabdrift can stand in for the address bar. Open the overlay, type or paste,
press Enter. No Ctrl+T, Ctrl+L first.

- **Pick an engine with one letter**, before or after the search:
  `g` Google, `b` Bing, `d` DuckDuckGo. `g esp32 pinout` and
  `esp32 pinout g` both search Google. The row goes to the top and is
  highlighted, so Enter runs it. The full text searched with your default
  engine sits right below it, for when the letter is part of the search
  (`vitamin d`).
- **Plain searches** use the default engine, set in settings (Google out of
  the box). When nothing in your tabs matches, the search row is on top and
  Enter runs it. When tabs do match, tabs stay first and the search row sits
  under them, so the tab switcher works as before.
- **Addresses**: a full link (`https://...`, `www....`) gets an "open" row
  on top. Bare addresses like `github.com/user/repo`, `docs.rs`,
  `localhost:5173` or `192.168.1.1` work too. File names like `README.md`
  are left alone.
- **Enter** opens in a new tab, **Shift+Enter** loads it in the tab you're
  on, and **Ctrl+Enter** (Cmd+Enter on a Mac) opens it in the background
  and keeps the overlay open.

### New tab and other locked pages

Firefox doesn't let extensions draw on `about:` pages (including the new
tab page), addons.mozilla.org and a few other Mozilla sites. On those pages
the same shortcut or toolbar button opens Tabdrift as a toolbar popup
instead, with the same search, keys and settings.

On an empty tab (new tab, home, `about:blank`), Enter loads the result in
that tab, so Ctrl+T, shortcut, type, Enter works like the address bar.
Shift+Enter opens a new tab instead. If Firefox blocks a page Tabdrift
didn't expect (the PDF viewer, for example), the button flashes "!" and
the next press opens the popup.

## Clean up tabs

Open the overlay and your tabs are listed, most recent first, before you
type anything. Close the ones you're done with without leaving the keyboard.

- **Ctrl+D** closes the highlighted tab. The overlay stays open and the
  highlight moves to the next tab, so you can tap through a pile. Holding
  the keys down doesn't repeat, and the small x on a row does the same with
  the mouse.
- **Close duplicate tabs**: when the same page is open more than once, a
  Clean up row appears above the list (arrow up, Enter). It keeps one copy
  of each page. Tracking parameters, `#fragments` and trailing slashes are
  ignored when comparing.
- **Close all matching tabs**: type something like a site name and the
  same row offers to close everything that matched. It asks for a second
  Enter first.

Pinned tabs are never closed in bulk, and the tab you're on is never
closed from its own overlay. Closed tabs are normal closed tabs, so
`Ctrl+Shift+T` (`Cmd+Shift+T` on Mac) brings them back. Turn off "List
tabs on open" in settings to go back to a blank box until you type.

## Email and link utilities

Paste an email address or a link into the overlay and a **Utilities**
section shows up above your tabs. The top row is selected, so `Enter`
copies it to the clipboard. Use the arrow keys to pick a different one.

| You paste          | You get                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| An email           | Domain, root domain, open the website, cleaned address (`Name <a@b.com>` and `mailto:` are handled) |
| A list of emails   | Unique domains, one per line, plus a cleaned email list                                              |
| A link             | Link without tracking parameters, no query or hash, site link (no path), domain, root domain, Markdown link, open the clean link, open in the Wayback Machine |

Link cleaning removes `utm_*`, `fbclid`, `gclid`, `msclkid`, `mc_eid`, and
similar click ids, unwraps redirect links (Google `/url?q=`, Outlook
Safe Links, Facebook `l.php`, LinkedIn, Slack and a few more), collapses
Amazon product links to `/dp/ASIN`, and trims noise on YouTube, Spotify,
Google Search, X, Instagram, LinkedIn and TikTok. Parameters that don't look
like tracking are left exactly as they were. Everything runs locally.

- **Quick copy** (settings): pasting an email or link into the overlay
  copies its top result straight away and closes the overlay.
- **Copy clean link** (`Alt+Shift+C`): copies the current page's link
  without tracking parameters. Change the key under Manage Extension
  Shortcuts in `about:addons`.
- **Right-click a link, Copy clean link**: same cleaning, for any link on
  a page.

The `clipboardWrite` permission is used to copy, and `contextMenus` for the
right-click item. Nothing is sent anywhere.

[<img src="https://blog.mozilla.org/addons/files/2020/04/get-the-addon-fx-apr-2020.svg" alt="Get the Add-on for Firefox" width="172">](https://addons.mozilla.org/firefox/addon/tabdrift/)

## Install

Click the badge above once the listing is live, or install from source:

```sh
npm install
npm run dev:firefox
```

This opens a temporary Firefox profile with the extension already loaded.

## Development

| Script                  | What it does                               |
| ----------------------- | ------------------------------------------ |
| `npm run dev`           | Run in a dev browser (Chromium by default) |
| `npm run dev:firefox`   | Run in a dev Firefox profile               |
| `npm run build`         | Production build                           |
| `npm run build:firefox` | Production build targeting Firefox         |
| `npm run zip:firefox`   | Build and package as a submittable `.zip`  |
| `npm run compile`       | Type-check without emitting                |
| `npm run lint`          | Lint with Biome                            |
| `npm run lint:fix`      | Lint and auto-fix with Biome               |

### Releasing a new version

```sh
npm version patch   # or minor / major
```

## Project layout

- `entrypoints/`, background script, the injected overlay, and the
  settings page
- `lib/`, shared settings storage, the clipboard helper, and the pure
  email and link helpers in `utils.ts`
- `public/icons/`, extension icons
- `site/`, the standalone marketing page (deployable as-is to Netlify
  or any static host)

## License

[MIT](./LICENSE)
