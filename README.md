# Tabdrift

![Tabdrift search overlay](./site/showcase01.png)

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

Default shortcut: `Alt+Shift+K`. Shortcut, overlay position, and accent
color are all configurable from the settings page.

## Email and link utilities

Paste an email address or a link into the overlay and a **Utilities**
section shows up above your tabs. The top row is selected, so `Enter`
copies it to the clipboard. Use the arrow keys to pick a different one.

| You paste          | You get                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| An email           | Domain, root domain, open the website, cleaned address (`Name <a@b.com>` and `mailto:` are handled) |
| A list of emails   | Unique domains, one per line, plus a cleaned email list                                              |
| A link             | Link without tracking parameters, no query or hash, domain, root domain, Markdown link, open the clean link, open in the Wayback Machine |

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
