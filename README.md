# userscripts

Userscripts by hal1278, tested with Firefox + [Violentmonkey](https://violentmonkey.github.io/).

## Scripts

### ChatGPT Markdown Handoff

[`scripts/chatgpt-markdown-export.user.js`](scripts/chatgpt-markdown-export.user.js)
· [Specification (Japanese)](docs/chatgpt-markdown-export.md)

Copies the ChatGPT conversation that is open in the current tab to the clipboard as Markdown.
Only the branch shown on screen is exported (the path from the root to `current_node`).

- Install: open the [raw file](https://raw.githubusercontent.com/hal1278/userscripts/main/scripts/chatgpt-markdown-export.user.js) with Violentmonkey enabled.
- Use: on `https://chatgpt.com/c/<id>` (or a project chat, `/g/g-p-…/c/<id>`), open the Violentmonkey menu and choose **Copy conversation as Markdown**.
- It reads the conversation through the same endpoints the ChatGPT web app uses
  (`/api/auth/session`, then `/backend-api/conversation/<id>`). Nothing is sent anywhere else,
  and it does not read or modify the page DOM.
- Kept: user messages and final assistant messages (`text` / `multimodal_text`).
  Dropped: system, tool, custom-instruction context, reasoning, other non-final output and
  messages hidden from the conversation. Images and other non-text parts become `*[attachment]*`.
- Message text is copied as is, except `<Cite …/>` tags, which become links to their sources, and
  user messages sent from a ChatGPT form, which are headed `## User (form response)`.

Output:

```markdown
---
title: "<title>"
conversation_id: <id>
created: <ISO 8601>
exported: <ISO 8601>
url: https://chatgpt.com/c/<id>
---

## User

...

## ChatGPT (<model_slug>)

...
```

The ChatGPT API is unofficial and changes often, so the script is best effort: it skips what it
does not recognise and only fails when nothing useful can be produced. Check the output.

## Development

```bash
nix develop
```

```bash
node --test
```

```bash
biome check .
```

Tests use synthetic fixtures only (`tests/fixtures/`); do not commit real conversation data.
Each userscript exports its pure functions through `module.exports` when it is loaded by Node,
and registers its menu command when it runs in a userscript manager.

## License

[MIT](LICENSE)
