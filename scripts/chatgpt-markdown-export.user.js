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
  const FORM_TAG = /<form[\s>]/;
  const CODE_FENCE_BLOCK = /```[\s\S]*?```/g;
  // `<Cite ref="a"/>` or `<Cite refs={["a","b"]}/>`; every quoted string is a ref.
  const CITE_TAG = /<Cite\b[^>]*\/>/g;
  const QUOTED = /"([^"]+)"/g;
  const YAML_ESCAPES = {
    "\\": "\\\\",
    '"': '\\"',
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
  };

  // ---------------------------------------------------------------------
  // Pure functions (no I/O, no globals). Exported for tests; see bottom.
  // The API is unofficial and changes often, so unexpected shapes are
  // skipped rather than treated as errors.
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
    let id = conversation?.current_node;
    if (mapping === null || typeof mapping !== "object" || typeof id !== "string") {
      throw new Error("conversation JSON has no `mapping` / `current_node`");
    }
    const path = [];
    const visited = new Set();
    while (typeof id === "string") {
      if (visited.has(id)) throw new Error(`cycle in mapping at node ${id}`);
      visited.add(id);
      const node = mapping[id];
      if (node === null || typeof node !== "object") {
        throw new Error(`node ${id} is missing from mapping`);
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

  /** True when an assistant message shows a form (outside code blocks). */
  function containsForm(message) {
    const parts = message?.content?.parts;
    if (message?.author?.role !== "assistant" || !Array.isArray(parts)) return false;
    const text = parts.filter((part) => typeof part === "string").join("\n");
    return FORM_TAG.test(text.replace(CODE_FENCE_BLOCK, ""));
  }

  /**
   * Converts one mapping node to a Markdown section, or returns null when the
   * node is not part of the visible conversation. `parentNode` is the previous
   * node on the path: ChatGPT stores a submitted form like a typed message, so
   * a user message that follows a form is labelled.
   */
  function nodeToMarkdown(node, parentNode) {
    const message = node?.message;
    if (!message || message.metadata?.is_visually_hidden_from_conversation === true) return null;
    const role = message.author?.role;
    if (role !== "user" && role !== "assistant") return null;
    if (!KEPT_CONTENT_TYPES.has(message.content?.content_type)) return null;
    if (role === "assistant" && message.channel != null && message.channel !== "final") {
      return null;
    }
    const parts = message.content.parts;
    if (!Array.isArray(parts)) return null;
    const body = partsToText(parts);
    if (body.trim() === "") return null;

    if (role === "user") {
      const heading = containsForm(parentNode?.message) ? "## User (form response)" : "## User";
      return `${heading}\n\n${body}`;
    }
    const modelSlug = message.metadata?.model_slug;
    const heading =
      typeof modelSlug === "string" && modelSlug ? `## ChatGPT (${modelSlug})` : "## ChatGPT";
    return `${heading}\n\n${body}`;
  }

  /**
   * Collects citation sources from anywhere in `value`: every object with a
   * string `ref_id` and a string `url`. Where ChatGPT keeps them changes, so
   * no path is assumed.
   */
  function collectSources(value) {
    const sources = new Map();
    const stack = [value];
    while (stack.length > 0) {
      const item = stack.pop();
      if (item === null || typeof item !== "object") continue;
      if (typeof item.ref_id === "string" && typeof item.url === "string") {
        if (!sources.has(item.ref_id)) {
          const title = typeof item.title === "string" ? item.title : "";
          sources.set(item.ref_id, { url: item.url, title });
        }
      }
      stack.push(...Object.values(item));
    }
    return sources;
  }

  /**
   * Replaces each `<Cite …/>` tag with links to its sources. Unknown refs are
   * kept by name; a tag with no known ref is left as is.
   */
  function replaceCitations(text, sources) {
    return text.replace(CITE_TAG, (tag) => {
      const refs = [...tag.matchAll(QUOTED)].map((match) => match[1]);
      if (!refs.some((ref) => sources.has(ref))) return tag;
      const links = refs.map((ref) => {
        const source = sources.get(ref);
        if (!source) return ref;
        const label = (source.title.trim() || source.url)
          .replace(/\s+/g, " ")
          .replace(/[[\]]/g, "\\$&");
        return `[${label}](${source.url})`;
      });
      return `(${links.join("; ")})`;
    });
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

  /** Builds the whole Markdown document for a conversation JSON. */
  function buildMarkdown(conversation, conversationId, exportedAt) {
    const sources = collectSources(conversation);
    const sections = buildLinearPath(conversation)
      .map((node, index, path) => nodeToMarkdown(node, path[index - 1]))
      .filter((section) => section !== null)
      .map((section) => replaceCitations(section, sources));
    if (sections.length === 0) {
      throw new Error("conversation has no user or assistant messages");
    }

    const title = typeof conversation.title === "string" ? conversation.title : "";
    const created = conversation.create_time;
    const frontMatter = [
      "---",
      `title: ${yamlQuote(title)}`,
      `conversation_id: ${conversationId}`,
      Number.isFinite(created) ? `created: ${new Date(created * 1000).toISOString()}` : null,
      `exported: ${exportedAt.toISOString()}`,
      `url: ${ORIGIN}/c/${conversationId}`,
      "---",
    ]
      .filter((line) => line !== null)
      .join("\n");

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
        cache: "no-store",
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
      collectSources,
      replaceCitations,
      yamlQuote,
      buildMarkdown,
    };
  }
})();
