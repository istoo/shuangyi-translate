# Repository Guidelines

Shuangyi (双译) is a Manifest V3 Chrome extension for bilingual web, video, and PDF reading. It
ships as plain ES modules — there is no build step; the browser loads `src/` directly.

## Project Structure & Module Organization

- `src/shared/` — chrome-free logic (`providers.js`, `config.js`, `pdf-text.js`, `i18n.js`); unit-testable in Node.
- `src/bg/` — service worker: `engines.js` (provider adapters) and `service-worker.js` (message routing, translation cache, context menu).
- `src/content/` — `index.js` (segmentation, DOM injection, hover/selection/input translation, export) and `subtitles.js`.
- `src/options|popup|welcome|pdf/` — extension pages. `src/vendor/pdfjs/` is vendored pdf.js (Apache-2.0).
- `_locales/zh_CN|en/` — message catalogs; `zh_CN` is the default locale.
- `test/` plus `test/e2e/` and `test/helpers/`; `scripts/pack.mjs` builds releases. `store/` holds listing assets only.

`dist/`, `dev-ext/`, and `keys/` are generated or secret and are gitignored.

## Build, Test, and Development Commands

- `npm install` — installs test-only dependencies (`jsdom`, `ws`).
- `npm test` — offline suite, no browser required.
- `npm run dev:sync` — mirrors `manifest.json`, `icons/`, `src/`, `_locales/` into `dev-ext/`; load that folder in `chrome://extensions` and reload after each change.
- `npm run pack` — writes `dist/shuangyi-translate-<version>.zip` and `.crx`.
- `npm run test:e2e` / `test:e2e:walkthrough` — real-browser checks; start Chrome first with `--remote-debugging-port=9360`.

## Coding Style & Naming Conventions

Two-space indentation, single quotes, semicolons, ESM `import`/`export`. Keep comments in
Chinese, matching the existing files. Prefix injected CSS classes with `irt-` and use `:where()`
to limit specificity leakage. All user-visible text must go through i18n (`__MSG__` in the
manifest, `t()` in code) — never hardcode strings. Name files lowercase (`service-worker.js`);
name tests `<topic>.test.mjs`.

## Testing Guidelines

Tests are dependency-free Node scripts using `node:assert/strict` and a local `check()` harness.
Add each new test file to the `test` script in `package.json`. `test/helpers/i18n.mjs` reads real
locale files, so missing translations fail tests. There is no coverage threshold; CI
(`.github/workflows/test.yml`) runs `npm ci --omit=optional && npm test` on Node 20.
The `test/e2e/` scripts share one Chrome instance and one config, so bring your own state via
`test/e2e/state.mjs` (`setTestConfig`) — leftover site rules or providers make them order-dependent.

## Commit & Pull Request Guidelines

Commits follow Conventional Commits with a Chinese subject: `fix: 支持 shadow DOM…`,
`feat: 更名双译、重做图标`, `chore:`, `style:`. Keep PRs focused, keep `npm test` green, and include
screenshots for UI or icon changes. Update `_locales/zh_CN` and `_locales/en` together when
user-facing copy changes.

## Security & Configuration Tips

Never commit `keys/*.pem` (CRX signing key) or `dist/`. Preserve `src/vendor/pdfjs/LICENSE`. The
extension has no backend: settings and cached translations stay local, and page text is sent only
to the endpoint the user configures.
