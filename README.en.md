# 双译 · Shuangyi

[![test](https://github.com/istoo/shuangyi-translate/actions/workflows/test.yml/badge.svg)](https://github.com/istoo/shuangyi-translate/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

**A bilingual reading extension for Chrome. You pick the translation model.**

[中文说明](README.md) · [FAQ](https://istoo.github.io/shuangyi-translate/faq.html) · [Privacy](https://istoo.github.io/shuangyi-translate/privacy.html) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

Shuangyi turns a web page, a video or a PDF into a bilingual read. It is not tied to any vendor: you save as many translation profiles as you like (OpenAI-compatible APIs, Anthropic, Gemini, Ollama, DeepL, Google's free endpoint, or any custom HTTP endpoint) and switch between them from the toolbar.

There is no backend. Settings and cached translations stay in your browser, and page text goes only to the endpoint you configure. The interface has a Simplified Chinese and an English locale, and follows your browser language.

## What it does

| Area | Features |
|---|---|
| Web pages | Full-page bilingual view, hover to translate one paragraph, selection bubble, input box (press space three times) |
| Video | Bilingual subtitles from standard WebVTT tracks and from YouTube's own caption DOM, prefetched around the playhead |
| PDF | Text-layer extraction, paragraph rebuilding, bilingual reading, Markdown export |
| Reading | Bilingual or translation-only mode, five translation styles, per-paragraph copy, in-place edit and retranslate |
| Quality | One batch of paragraphs is sent together with the document title, so terminology and tone stay consistent; per-profile glossary and expert persona |
| Control | Site rules (always or never translate), keyboard shortcuts, font scale, language cache invalidation |

## Install

Download `shuangyi-translate-<version>.zip` from [Releases](https://github.com/istoo/shuangyi-translate/releases) and unpack it to a folder you will keep.

1. Open `chrome://extensions` and turn on Developer mode.
2. Click "Load unpacked" and select the folder you unpacked.
3. Open the extension's settings to configure a model, or start with the built-in Google endpoint.

Chrome shows a warning bubble at startup for manually loaded extensions. It is harmless. Keep Developer mode on, otherwise the extension will not load after a browser restart. The Chrome Web Store and Edge Addons listings are being prepared; this page will link them once they are live.

## Configure a model

Settings → Translation service → choose a type, fill in the fields, then click "Test this service".

| Type | Base URL field | Model example |
|---|---|---|
| Google Translate | nothing to configure | n/a |
| DeepL | API key only | n/a |
| OpenAI-compatible | Base URL, up to the version segment | `gpt-4o-mini` |
| Anthropic | leave the default | `claude-sonnet-4-5` |
| Google Gemini | leave the default | `gemini-2.0-flash` |
| Ollama | leave the default | `qwen2.5:7b` |
| Custom HTTP endpoint | the full request URL | any |

Common OpenAI-compatible base URLs: DeepSeek `https://api.deepseek.com/v1`, Moonshot `https://api.moonshot.cn/v1`, OpenRouter `https://openrouter.ai/api/v1`, LM Studio `http://localhost:1234/v1`, Ollama's compatible endpoint `http://localhost:11434/v1`.

For an endpoint nobody has preset yet, choose the custom type and edit the request URL, headers, body template and response path under Advanced. Placeholders in the body are inserted as JSON values, so you do not add quotes yourself:

```json
{ "text": {{texts}}, "target": {{target}}, "model": {{model}} }
```

`{{texts}}` is a JSON array string, `{{textsJson}}` is a real array, `{{text}}` is all paragraphs joined into one string, and `{{system}}` carries the system prompt. The response path accepts `a.b[0].c` style expressions such as `choices[0].message.content`; leave it empty when the whole response body is the translation.

## Shortcuts

- `Alt+A` translates or restores the current page
- `Alt+W` switches between bilingual and translation-only
- Hold `Shift` and hover a paragraph to translate just that one (the key and the feature can be changed in settings)
- Select text for a translation bubble; press space three times in an input box to translate what you typed

The first two are browser commands. Chrome does not let an extension rebind its own shortcuts, so the settings page shows the current bindings and links to `chrome://extensions/shortcuts`.

## Privacy

No server, no accounts, no telemetry. Settings, translation service credentials and the translation cache live in `chrome.storage.local`. When you translate, the text the extension reads from the page is sent straight to the endpoint you configured, and nowhere else. Full details are in the [privacy policy](https://istoo.github.io/shuangyi-translate/privacy.html), and the code is in this repository if you would rather check for yourself.

## Development

There is no build step. The browser loads `src/` directly as ES modules.

```bash
npm install     # test dependencies only (jsdom, ws)
npm test        # offline suite, no browser required

npm run dev:sync   # mirror manifest, icons, src and _locales into dev-ext/
npm run pack       # write dist/shuangyi-translate-<version>.zip and .crx
```

To try your changes, run `npm run dev:sync`, load `dev-ext/` as an unpacked extension, and click the reload button on the extension card after every edit. The test suite runs on Node 22 or newer and covers prompt rendering, paragraph rebuilding, i18n completeness, the background cache, and DOM behaviour.

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it lists the checks that must pass and the commit message convention.

## License

[GNU Affero General Public License v3.0](LICENSE). You may use, modify and redistribute it, including commercially, but derivative works must stay under the same license and publish their source. Bundled third-party components are credited in [NOTICE](NOTICE).