// ==UserScript==
// @name         Gemini Markdown Handoff
// @namespace    https://github.com/hal1278/userscripts
// @version      0.1.0
// @description  Copy the Gemini conversation shown on screen as Markdown.
// @author       hal1278
// @license      MIT
// @match        https://gemini.google.com/*
// @noframes
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/hal1278/userscripts/main/scripts/gemini-markdown-export.user.js
// @downloadURL  https://raw.githubusercontent.com/hal1278/userscripts/main/scripts/gemini-markdown-export.user.js
// ==/UserScript==

(() => {
  const SCRIPT_NAME = "Gemini Markdown Handoff";
  const ORIGIN = "https://gemini.google.com";
  const HISTORY_RPC = "hNvQHb";
  const PAGE_SIZE = 10;
  const MAX_PAGES = 200;
  const CONVERSATION_PATH = /\/app\/([0-9a-f]{8,})(?:\/|$)/i;
  const TITLE_SUFFIX = /\s*-\s*Google Gemini$/;
  const URL_PREFIX = /^https?:\/\//;
  const YAML_ESCAPES = {
    "\\": "\\\\",
    '"': '\\"',
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
  };

  // ---------------------------------------------------------------------
  // Pure functions (no I/O, no globals). Exported for tests; see bottom.
  // The RPC returns arrays without keys, so only a few shallow positions
  // are read (see docs/gemini-markdown-export.md); anything else is skipped.
  // ---------------------------------------------------------------------

  /** Returns the hex conversation ID in `pathname` (without `c_`), or null. */
  function extractConversationId(pathname) {
    const match = CONVERSATION_PATH.exec(pathname);
    return match ? match[1] : null;
  }

  /** Conversation title from `document.title`, or "" for a page without one. */
  function titleFromDocument(documentTitle) {
    const title = String(documentTitle ?? "")
      .replace(TITLE_SUFFIX, "")
      .trim();
    return title === "Google Gemini" || title === "Gemini" ? "" : title;
  }

  /**
   * Parses a `batchexecute` response body (`)]}'`, then length and JSON
   * lines) and returns the decoded payload of the `rpcId` entry.
   */
  function parseBatchResponse(text, rpcId) {
    for (const line of String(text).split("\n")) {
      if (!line.startsWith("[")) continue;
      let entries;
      try {
        entries = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (
          Array.isArray(entry) &&
          entry[0] === "wrb.fr" &&
          entry[1] === rpcId &&
          typeof entry[2] === "string"
        ) {
          return JSON.parse(entry[2]);
        }
      }
    }
    throw new Error(`no ${rpcId} payload in response`);
  }

  /** Picks the response draft the user chose; falls back to the first one. */
  function chosenCandidate(turn) {
    const candidates = turn?.[3]?.[0];
    if (!Array.isArray(candidates)) return null;
    const drafts = candidates.filter(Array.isArray);
    const chosenId = turn[3][3];
    return drafts.find((draft) => draft[0] === chosenId) ?? drafts[0] ?? null;
  }

  /**
   * Collects source URLs from anywhere in `value`: every `[number, number,
   * [url, …]]` array (a cited text range and its source). Deduplicated.
   */
  function collectSourceUrls(value) {
    const urls = [];
    const stack = [value];
    while (stack.length > 0) {
      const item = stack.pop();
      if (!Array.isArray(item)) continue;
      const [start, end, source] = item;
      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        Array.isArray(source) &&
        typeof source[0] === "string" &&
        URL_PREFIX.test(source[0]) &&
        !urls.includes(source[0])
      ) {
        urls.push(source[0]);
      }
      // Push in reverse so URLs come out in document order.
      for (let i = item.length - 1; i >= 0; i--) stack.push(item[i]);
    }
    return urls;
  }

  /** Time of a turn (`[seconds, nanos]`), or null. */
  function turnTime(turn) {
    const seconds = turn?.[4]?.[0];
    return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
  }

  /**
   * Wraps a message body in a `markdown` code fence longer than any backtick
   * run inside it, so headings and code blocks in the body stay inside.
   */
  function fenceBody(text) {
    const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
    const marks = "`".repeat(Math.max(3, longest + 1));
    return `${marks}markdown\n${text.replace(/\n+$/, "")}\n${marks}`;
  }

  /** Converts one turn to its User and Gemini sections (either may be missing). */
  function turnToSections(turn) {
    if (!Array.isArray(turn)) return [];
    const sections = [];

    const userText = turn[2]?.[0]?.[0];
    if (typeof userText === "string" && userText.trim() !== "") {
      sections.push(`## User\n\n${fenceBody(userText)}`);
    }

    const candidate = chosenCandidate(turn);
    const texts = candidate?.[1];
    const body = Array.isArray(texts) ? texts.find((text) => typeof text === "string") : undefined;
    if (typeof body === "string" && body.trim() !== "") {
      const model = turn[3]?.[21];
      const heading =
        typeof model === "string" && model.trim() !== "" ? `## Gemini (${model})` : "## Gemini";
      const urls = collectSourceUrls(candidate[2]);
      const sources =
        urls.length > 0 ? `\n\nSources:\n${urls.map((url) => `- ${url}`).join("\n")}` : "";
      sections.push(`${heading}\n\n${fenceBody(body)}${sources}`);
    }
    return sections;
  }

  /** Quotes `value` as a YAML double-quoted scalar. */
  function yamlQuote(value) {
    let quoted = "";
    for (const ch of value) {
      const code = ch.codePointAt(0);
      if (Object.hasOwn(YAML_ESCAPES, ch)) {
        quoted += YAML_ESCAPES[ch];
      } else if (
        code < 0x20 ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029
      ) {
        quoted += `\\u${code.toString(16).padStart(4, "0")}`;
      } else {
        quoted += ch;
      }
    }
    return `"${quoted}"`;
  }

  /**
   * Builds the whole Markdown document. `turns` are in API order (newest
   * first), as returned by the history RPC pages concatenated.
   */
  function buildMarkdown(turns, conversationId, title, exportedAt) {
    const ordered = [...turns].reverse();
    const sections = ordered.flatMap(turnToSections);
    if (sections.length === 0) {
      throw new Error("conversation has no user or Gemini messages");
    }

    const created = ordered.map(turnTime).find((time) => time !== null);
    const frontMatter = [
      "---",
      `title: ${yamlQuote(title)}`,
      `conversation_id: c_${conversationId}`,
      created ? `created: ${created.toISOString()}` : null,
      `exported: ${exportedAt.toISOString()}`,
      `url: ${ORIGIN}/app/${conversationId}`,
      "---",
    ]
      .filter((line) => line !== null)
      .join("\n");

    return `${[frontMatter, ...sections].join("\n\n")}\n`;
  }

  // ---------------------------------------------------------------------
  // Side effects: page tokens, network, clipboard, notifications.
  // ---------------------------------------------------------------------

  function readPageTokens() {
    const page = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
    const wiz = page.WIZ_global_data;
    const tokens = { at: wiz?.SNlM0e, bl: wiz?.cfb2h, sid: wiz?.FdrFJe };
    for (const [name, value] of Object.entries(tokens)) {
      if (typeof value !== "string" || value === "") {
        throw new Error(`token: page has no ${name} (logged out, or the page changed)`);
      }
    }
    return tokens;
  }

  async function fetchHistoryPage(conversationId, pageToken, tokens) {
    const args = [`c_${conversationId}`, PAGE_SIZE, pageToken, 1, [1], [4], null, 1];
    const query = new URLSearchParams({
      rpcids: HISTORY_RPC,
      "source-path": location.pathname,
      bl: tokens.bl,
      "f.sid": tokens.sid,
      hl: document.documentElement.lang || "en",
      _reqid: String(Math.floor(Math.random() * 900000) + 100000),
      rt: "c",
    });
    const body = new URLSearchParams({
      "f.req": JSON.stringify([[[HISTORY_RPC, JSON.stringify(args), null, "generic"]]]),
      at: tokens.at,
    });
    let response;
    try {
      response = await fetch(`${ORIGIN}/_/BardChatUi/data/batchexecute?${query}`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body,
      });
    } catch (error) {
      throw new Error(`history request failed: network error (${error.message})`);
    }
    if (!response.ok) throw new Error(`history request failed: HTTP ${response.status}`);
    try {
      return parseBatchResponse(await response.text(), HISTORY_RPC);
    } catch (error) {
      throw new Error(`history request failed: ${error.message}`);
    }
  }

  async function fetchTurns(conversationId) {
    const tokens = readPageTokens();
    const turns = [];
    const seen = new Set();
    let pageToken = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const payload = await fetchHistoryPage(conversationId, pageToken, tokens);
      if (Array.isArray(payload?.[0])) turns.push(...payload[0]);
      pageToken = payload?.[1];
      if (typeof pageToken !== "string" || pageToken === "" || seen.has(pageToken)) break;
      seen.add(pageToken);
    }
    return turns;
  }

  function notify(text) {
    GM_notification({ title: SCRIPT_NAME, text });
  }

  async function copyConversationAsMarkdown() {
    const conversationId = extractConversationId(location.pathname);
    if (conversationId === null) {
      notify("Failed: no conversation ID in this URL (expected /app/<id>)");
      return;
    }
    try {
      const turns = await fetchTurns(conversationId);
      let markdown;
      try {
        markdown = buildMarkdown(
          turns,
          conversationId,
          titleFromDocument(document.title),
          new Date(),
        );
      } catch (error) {
        throw new Error(`unexpected API response: ${error.message}`);
      }
      try {
        await GM_setClipboard(markdown, "text/plain");
      } catch (error) {
        throw new Error(`clipboard write failed: ${error.message}`);
      }
      notify(`Copied as Markdown (${markdown.length} characters)`);
    } catch (error) {
      console.error(`[${SCRIPT_NAME}]`, error.message);
      notify(`Failed: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------
  // Entry point. In the userscript manager the GM_* API exists and the menu
  // command is registered; under Node (tests) the pure functions are exported.
  // ---------------------------------------------------------------------

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Copy conversation as Markdown", copyConversationAsMarkdown);
  } else if (typeof module === "object" && module !== null && module.exports) {
    module.exports = {
      extractConversationId,
      titleFromDocument,
      parseBatchResponse,
      chosenCandidate,
      collectSourceUrls,
      turnTime,
      fenceBody,
      turnToSections,
      yamlQuote,
      buildMarkdown,
    };
  }
})();
