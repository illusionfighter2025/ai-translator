# AI Translator (Chrome Extension)

A clean, modern Chrome browser extension powered by any **OpenAI-compatible** API. It supports:

- 🌐 **Full-page translation** — translates the entire webpage in place while preserving layout.
- ✍️ **Selection translation** — select any text to see a floating translation tooltip.
- 📝 **Webpage summary** — generates a structured Markdown summary of the current page.

Bring your own provider: OpenAI, DeepSeek, OpenRouter, Moonshot, local LLMs (Ollama/LM Studio with OpenAI shim), and more.

## Features

| Feature | How to use |
| --- | --- |
| Translate page | Click the extension → **Translate Page**, or press `Alt+T`. Click again to restore the original. |
| Summarize page | Click the extension → **Summarize Page**, or press `Alt+S`. |
| Translate selection | Select text on any page (auto tooltip), or press `Alt+Q`. Also via right-click menu. |
| Configure | Click the extension → fill **API Key / Base URL / Model**, or open the full Settings page. |

## Installation (developer mode)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (`H:\ai translator`).
4. The extension icon appears in your toolbar. Pin it for easy access.

## Configuration

Open the extension popup (or the Settings page) and enter:

- **API Key** — your provider key (e.g. `sk-...`).
- **Base URL** — the provider base. The extension appends `/v1/chat/completions` automatically. Examples:
  - DeepSeek: `https://api.deepseek.com`
  - OpenAI: `https://api.openai.com`
  - OpenRouter: `https://openrouter.ai/api`
- **Model** — any model name your provider supports (e.g. `deepseek-chat`, `gpt-4o-mini`).
- **Target language** — 中文 / English.
- **Auto-translate selection** — toggle the floating tooltip on text selection.

Settings are stored via `chrome.storage.sync`.

## Architecture

```
manifest.json       Manifest V3 config
background.js       Service worker: API calls (chat completions), context menus, commands
content.js          Content script: tooltip, page translation, summary modal
content.css         In-page UI styles
popup.html/css/js   Toolbar popup: quick actions + config
options.html/css/js Full settings page
icons/              Extension icons (16/48/128)
build-icons.js      One-off Node script to regenerate icons (no deps)
```

### How it works

- **Selection translation**: on `mouseup`, the content script sends the selected text to the background worker, which calls `/v1/chat/completions` and returns the translation shown in a styled tooltip.
- **Full-page translation**: the content script walks text nodes (skipping scripts/styles/inputs), batches them, and asks the model to return a JSON array of translations in the same order, then swaps the text in place. Original text is cached on each node so the page can be restored.
- **Webpage summary**: the content script extracts the main text, sends it with a summarization prompt, and renders the Markdown reply in a modal.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+T` | Translate / restore page |
| `Alt+S` | Summarize page |
| `Alt+Q` | Translate current selection |

## License

MIT — use it freely.
