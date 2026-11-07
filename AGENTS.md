# Repository guidance

## Layout and checks

- Userscripts live in `scripts/`, one spec per script in `docs/`, tests in `tests/`.
- Test fixtures must be synthetic. Never commit real conversation or account data.
- Run `node --test` and `biome check .` (both available in `nix develop`) after changes.

## Design

- Implement clean-room: do not fetch, read, or adapt existing userscripts (Greasy Fork etc.).
- No `@require`, no requests to third-party hosts, no dependence on the target site's DOM
  unless the spec says otherwise.
- Target sites (e.g. ChatGPT) change their unofficial APIs often. Write best-effort code that
  tolerates schema changes: skip or pass through unexpected shapes, and fail only when no
  meaningful output is possible. Avoid hard-coding deep metadata paths; search generically.
- The user checks every output by hand, so prefer short, simple code over exhaustive handling.
- Keep pure logic (parsing, conversion) separate from I/O so `node:test` can load it; the
  userscript manager path must not change because of this.

## Workflow

- When asked how something will behave or be represented, propose the policy and update the
  spec in `docs/`. Do not implement until the user confirms.
- In reports, separate what was actually tested from what is inferred, and say under which
  conditions a check ran (browser, page state).
