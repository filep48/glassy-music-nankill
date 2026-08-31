# Glassy Music (filep48 fork)

Fork of `NanKillBro/glassy-music-nankill`, itself a mod of `pear-devs/pear-desktop`
(formerly `th-ch/youtube-music`). Electron wrapping music.youtube.com, plus plugins.

    origin    https://github.com/filep48/glassy-music-nankill
    upstream  https://github.com/NanKillBro/glassy-music-nankill

The top upstream (pear-desktop) is not configured as a remote, but most plugin code
comes from there and so do the useful issues. Most plugin bugs are pear-desktop bugs,
not Glassy ones.

## Running it

```bash
pnpm install --frozen-lockfile
git submodule update --init --recursive   # extensions-src/*, the prebuild needs them
pnpm dev          # electron-vite dev --watch
pnpm check        # lint + format:check + typecheck
pnpm test         # Playwright
pnpm dist:win     # installer
```

Node >= 22, pnpm >= 11. TypeScript is `7.0.1-rc`, the linter is **oxlint** and the
formatter **oxfmt**. Not eslint, not prettier: that migration already happened.

`pnpm check` fails on a clean checkout. Master carries 26 lint errors and 29
unformatted files. Measure against that baseline rather than trying to get to zero,
and format only the files you touched (`pnpm exec oxfmt --write <path>`) so the diff
stays reviewable.

**Only one instance can run at a time.** `src/index.ts:67` takes a single-instance
lock and exits when it fails, so `pnpm dev` dies on startup while the installed build
is open. Close it first.

**`pnpm dev` cannot load renderer plugins.** Menu and backend hooks come up, no
renderer hook ever does, and the log carries `ReferenceError: __dirname is not defined`
out of `node_modules/.vite/deps/electron.js`. `rendererExcludes` in
`electron.vite.config.mts:102` is only wired into `build.rolldownOptions.external`, so
in dev Vite's optimizer pre-bundles `electron` for the browser and it throws while the
plugin virtual module is still evaluating. `vite-plugins/plugin-importer.mts` emits a
static import of every plugin `index.ts` into the renderer bundle, so one plugin
importing `electron`, `fs` or `path` at module scope takes all of them down with it,
and several do. The upstream config is identical, so this is not a Glassy regression.

Verify renderer work with `pnpm build && pnpm start` until that is fixed. Slower, but
it runs the real bundle.

The installed release is not this tree: `%LOCALAPPDATA%\Programs\glassy-music-nankill-mod`.
Its live settings are in `%APPDATA%\Glassy Music\config.json`, which is the source of
truth for which plugins are actually enabled.

## Plugin architecture, the one thing to understand

A plugin is a folder under `src/plugins/<name>/` whose `index.ts` default-exports
`createPlugin({...})`. Three contexts, one per process:

| hook | process | for |
|---|---|---|
| `backend` | main | network, files, `ipcMain`, the `BrowserWindow` |
| `preload` | preload | rarely used |
| `renderer` | renderer | YTM's DOM, the `<video>` element, UI |

Rules that exist because they have already broken things:

1. **Every plugin `index.ts` is imported whether the plugin is enabled or not.** They
   are statically pulled into the renderer bundle. Only Solid signals and plain object
   construction may live at module scope. A stray `@/config` reference drags
   electron-store's node imports in and breaks the whole renderer script. Written down
   in `src/plugins/pitch-shift/index.ts`, and it is not theoretical.
2. **Hooks are invoked with `.call(plugin.renderer, ...)`** (`src/renderer.ts`), so
   `this` inside a `renderer` object is that object. That is how `sponsorblock` reaches
   `this.timeUpdateListener`. Check the call site before flattening those into
   standalone functions.
3. **In the player bar use `on:click`, never `onClick`.** Solid delegates `onClick` to
   a single listener on `document`, and inside YTM's player bar the click is stopped
   before it gets there: the button hovers, and does nothing. `captions-selector`,
   `quality-changer`, `video-toggle`, `pitch-shift` and `playback-speed` all use `on:`
   for this reason.
4. **The player bar is re-rendered on navigation.** A one-shot mount does not survive;
   it needs a `MutationObserver` that remounts. `pitch-shift/renderer.tsx` and
   `playback-speed/renderer.tsx` are the pattern: `PLAYER_BAR_SELECTOR` is
   `.right-controls-buttons`, and the wrapper gets `display: contents` to stay out of
   the flex layout.
5. **`restartNeeded: true` shows the user a restart dialog.** Only when the plugin
   genuinely cannot reload in place.

App-level events are prefixed `peard:` (from pear-desktop): `peard:video-src-changed`
(IPC renderer to main, carrying the whole `GetPlayerResponse`), `peard:src-changed`
(a DOM event on the `<video>`), `peard:audio-can-play`, `peard:seeked`. All emitted by
`src/providers/song-info-front.ts`.

## Naming that does not match behaviour

The **`do-not-track` plugin is the ad blocker**, renamed from `adblocker` in 3.12
(migration in `src/config/store.ts:15`). Its `In player` mode only prunes `playerAds`,
`adPlacements` and `adSlots` out of the player response; `With blocklists` runs the
Ghostery engine over uBlock Origin's lists. Do not go looking for `src/plugins/adblocker`.

## Style

Colours come from YTM's own custom properties (`--ytmusic-text-primary`,
`--ytmusic-menu-item-hover-background-color`, ...) with a fallback. Never hardcode
light or dark. `pitch-shift/style.css` and `playback-speed/style.css` are the examples.

## Everything written here must be upstreamable

No personal patches. Write every change as if it were going to land as a PR against
`NanKillBro/glassy-music-nankill` or `pear-devs/pear-desktop`: a config option when it
changes default behaviour, an i18n key for every user-visible string, no new lint or
format failures beyond the baseline, and the style of the file being touched.

## Writing

- **Everything in English**: code, identifiers, comments, commits, PRs, this file.
- **Few comments or none.** If a line needs a comment to be understood, the line is
  wrong. The only ones that stay explain *why* something counter-intuitive is the way
  it is: a YTM quirk, a Chromium behaviour, a race. No `// set the volume`, no JSDoc on
  self-evident functions, no decorative comment blocks.
- **No em dashes.** Anywhere. Comma, colon, parentheses or a full stop.
- Banned in prose: robust, seamless, comprehensive, leverage, delve, utilize,
  facilitate, "in order to", "ensure that". No three-adjective lists.

## Commits and PRs

Conventional Commits:

    type(scope): subject (#issue)

Imperative, lowercase after the colon, no trailing period, subject under 72 chars. One
logical change per commit. Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`,
`build`, `chore`. Scope is the plugin or the part that moved (`playback-speed`,
`sponsorblock`, `pitch-shift`, `loader`, `i18n`).

Never `Co-Authored-By: Claude`, never "Generated with" footers, never emoji.

PR: one-line title, body saying what and why in five lines or fewer. No `## Summary`,
no `## Test plan`, no file listings.

## Nothing gets committed that has not been run

Compiling and typechecking are not evidence. This is an Electron app manipulating
someone else's web DOM: the only proof is `pnpm dev`, a song playing, and looking at
it. If it cannot be verified in the session, say so and stop there rather than
committing with caveats.

## i18n

Strings live in `src/i18n/resources/<lang>.json`. Every user-visible string goes
through `t('plugins.<plugin>.…')`. A new key goes into `en.json` at minimum, keeping
the file's alphabetical order; other languages fall back to English on their own.
