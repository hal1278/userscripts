// ==UserScript==
// @name         ChatGPT Markdown Handoff
// @namespace    https://github.com/hal1278/userscripts
// @version      0.1.0
// @description  Copy the ChatGPT conversation shown on screen (current branch only) as Markdown.
// @author       hal1278
// @license      MIT
// @match        https://chatgpt.com/*
// @noframes
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_notification
// @updateURL    https://raw.githubusercontent.com/hal1278/userscripts/main/scripts/chatgpt-markdown-export.user.js
// @downloadURL  https://raw.githubusercontent.com/hal1278/userscripts/main/scripts/chatgpt-markdown-export.user.js
// ==/UserScript==

(() => {
  const SCRIPT_NAME = "ChatGPT Markdown Handoff";
  const ORIGIN = "https://chatgpt.com";
  // Matches `/c/<uuid>` anywhere in the path, so project chats
  // (`/g/g-p-…/c/<uuid>`) work as well as plain ones (`/c/<uuid>`).
  const CONVERSATION_PATH =
    /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;
  const KEPT_CONTENT_TYPES = new Set(["text", "multimodal_text"]);
  const ATTACHMENT_PLACEHOLDER = "*[attachment]*";
  const YAML_ESCAPES = {
    "\\": "\\\\",
    '"': '\\"',
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
  };

  // ---------------------------------------------------------------------
  // Pure functions (no I/O, no globals). Exported for tests; see bottom.
  // ---------------------------------------------------------------------

  /** Returns the conversation UUID in `pathname`, or null if there is none. */
  function extractConversationId(pathname) {
    const match = CONVERSATION_PATH.exec(pathname);
    return match ? match[1] : null;
  }

  /**
   * Walks from `current_node` up through `parent` links to the root and
   * returns the nodes in root-to-leaf order. Other branches are ignored.
   */
  function buildLinearPath(conversation) {
    const mapping = conversation?.mapping;
    if (mapping === null || typeof mapping !== "object") {
      throw new Error("conversation JSON has no `mapping` object");
    }
    const currentNode = conversation.current_node;
    if (typeof currentNode !== "string") {
      throw new Error("conversation JSON has no `current_node` string");
    }

    const path = [];
    const visited = new Set();
    let id = currentNode;
    while (id !== null) {
      if (visited.has(id)) {
        throw new Error(`cycle in mapping at node ${id}`);
      }
      visited.add(id);
      if (!Object.hasOwn(mapping, id)) {
        throw new Error(`node ${id} is missing from mapping`);
      }
      const node = mapping[id];
      if (node === null || typeof node !== "object") {
        throw new Error(`node ${id} is not an object`);
      }
      if (!Object.hasOwn(node, "parent")) {
        throw new Error(`node ${id} has no \`parent\` field`);
      }
      if (node.parent !== null && typeof node.parent !== "string") {
        throw new Error(`node ${id} has a non-string \`parent\``);
      }
      path.push(node);
      id = node.parent;
    }
    return path.reverse();
  }

  /** Joins `parts`; non-string parts (images, files, …) become a placeholder. */
  function partsToText(parts) {
    return parts
      .map((part) => (typeof part === "string" ? part : ATTACHMENT_PLACEHOLDER))
      .filter((text) => text !== "")
      .join("\n\n");
  }

  /**
   * Converts one mapping node to a Markdown section, or returns null when the
   * node is not part of the visible conversation (system, tool, hidden
   * context, non-final assistant channels, other content types, empty body).
   */
  function nodeToMarkdown(node) {
    const message = node.message;
    // Structural nodes such as the root carry no message.
    if (message === null || message === undefined) return null;
    const label = `message ${message.id ?? node.id}`;

    const role = message.author?.role;
    if (typeof role !== "string") {
      throw new Error(`${label} has no \`author.role\``);
    }
    if (role !== "user" && role !== "assistant") return null;

    const contentType = message.content?.content_type;
    if (typeof contentType !== "string") {
      throw new Error(`${label} has no \`content.content_type\``);
    }
    if (!KEPT_CONTENT_TYPES.has(contentType)) return null;

    if (
      role === "assistant" &&
      message.channel !== undefined &&
      message.channel !== null &&
      message.channel !== "final"
    ) {
      return null;
    }

    const parts = message.content.parts;
    if (!Array.isArray(parts)) {
      throw new Error(`${label} has no \`content.parts\` array`);
    }
    const body = partsToText(parts);
    if (body.trim() === "") return null;

    if (role === "user") return `## User\n\n${body}`;

    const modelSlug = message.metadata?.model_slug;
    if (typeof modelSlug !== "string" || modelSlug === "") {
      throw new Error(`${label} has no \`metadata.model_slug\``);
    }
    return `## ChatGPT (${modelSlug})\n\n${body}`;
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

  /** Converts a Unix timestamp in seconds (the API's format) to ISO 8601. */
  function unixSecondsToIso(seconds, field) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
      throw new Error(`conversation JSON has no numeric \`${field}\``);
    }
    return new Date(seconds * 1000).toISOString();
  }

  /** Builds the whole Markdown document for a conversation JSON. */
  function buildMarkdown(conversation, conversationId, exportedAt) {
    const title = conversation?.title;
    if (typeof title !== "string") {
      throw new Error("conversation JSON has no `title` string");
    }
    const created = unixSecondsToIso(conversation.create_time, "create_time");

    const sections = buildLinearPath(conversation)
      .map(nodeToMarkdown)
      .filter((section) => section !== null);
    if (sections.length === 0) {
      throw new Error("conversation has no user or assistant messages");
    }

    const frontMatter = [
      "---",
      `title: ${yamlQuote(title)}`,
      `conversation_id: ${conversationId}`,
      `created: ${created}`,
      `exported: ${exportedAt.toISOString()}`,
      `url: ${ORIGIN}/c/${conversationId}`,
      "---",
    ].join("\n");

    return `${[frontMatter, ...sections].join("\n\n")}\n`;
  }

  // ---------------------------------------------------------------------
  // Side effects: network, clipboard, notifications.
  // ---------------------------------------------------------------------

  async function fetchJson(url, stage, headers = {}) {
    let response;
    try {
      response = await fetch(url, {
        credentials: "include",
        headers: { Accept: "application/json", ...headers },
      });
    } catch (error) {
      throw new Error(`${stage} request failed: network error (${error.message})`);
    }
    if (!response.ok) {
      throw new Error(`${stage} request failed: HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`${stage} request failed: HTTP ${response.status} but body is not JSON`);
    }
  }

  async function fetchConversation(conversationId) {
    const session = await fetchJson(`${ORIGIN}/api/auth/session`, "session");
    const accessToken = session?.accessToken;
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new Error("session request returned no accessToken (logged out?)");
    }
    return fetchJson(`${ORIGIN}/backend-api/conversation/${conversationId}`, "conversation", {
      Authorization: `Bearer ${accessToken}`,
    });
  }

  function notify(text) {
    GM_notification({ title: SCRIPT_NAME, text });
  }

  async function copyConversationAsMarkdown() {
    const conversationId = extractConversationId(location.pathname);
    if (conversationId === null) {
      notify("Failed: no conversation ID in this URL (expected …/c/<uuid>)");
      return;
    }
    try {
      const conversation = await fetchConversation(conversationId);
      let markdown;
      try {
        markdown = buildMarkdown(conversation, conversationId, new Date());
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
      buildLinearPath,
      nodeToMarkdown,
      yamlQuote,
      buildMarkdown,
    };
  }
})();
