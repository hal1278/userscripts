const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  extractConversationId,
  buildLinearPath,
  nodeToMarkdown,
  yamlQuote,
  buildMarkdown,
} = require("../scripts/chatgpt-markdown-export.user.js");

const branched = require("./fixtures/branched.json");
const filtering = require("./fixtures/filtering.json");

const UUID = "11111111-2222-4333-8444-555555555555";
const EXPORTED_AT = new Date("2026-01-02T03:04:05.000Z");

// Fixtures are shared via the require cache, so mutate copies only.
const clone = (value) => structuredClone(value);

describe("extractConversationId", () => {
  it("reads a plain conversation URL", () => {
    assert.equal(extractConversationId(`/c/${UUID}`), UUID);
  });

  it("reads a project conversation URL", () => {
    assert.equal(extractConversationId(`/g/g-p-0123456789abcdef-research/c/${UUID}`), UUID);
  });

  it("accepts a trailing slash", () => {
    assert.equal(extractConversationId(`/c/${UUID}/`), UUID);
  });

  it("returns null when there is no /c/<uuid> segment", () => {
    for (const pathname of [
      "/",
      "/g/g-p-0123456789abcdef-research/project",
      `/share/${UUID}`,
      `/xc/${UUID}`,
      "/c/not-a-uuid",
      `/c/${UUID}extra`,
    ]) {
      assert.equal(extractConversationId(pathname), null, pathname);
    }
  });
});

describe("buildLinearPath", () => {
  it("follows current_node only, from root to leaf", () => {
    const ids = buildLinearPath(branched).map((node) => node.id);
    assert.deepEqual(ids, ["root", "sys", "u1", "a1", "u2-edited", "a2-edited"]);
  });

  it("rejects a cycle", () => {
    const conversation = {
      current_node: "a",
      mapping: {
        a: { id: "a", message: null, parent: "b" },
        b: { id: "b", message: null, parent: "a" },
      },
    };
    assert.throws(() => buildLinearPath(conversation), /cycle/);
  });

  it("rejects a parent that is missing from mapping", () => {
    const conversation = clone(branched);
    delete conversation.mapping.a1;
    assert.throws(() => buildLinearPath(conversation), /node a1 is missing/);
  });

  it("rejects a node without a parent field", () => {
    const conversation = clone(branched);
    delete conversation.mapping.root.parent;
    assert.throws(() => buildLinearPath(conversation), /`parent`/);
  });

  it("rejects missing mapping or current_node", () => {
    const noMapping = clone(branched);
    delete noMapping.mapping;
    assert.throws(() => buildLinearPath(noMapping), /`mapping`/);

    const noCurrent = clone(branched);
    delete noCurrent.current_node;
    assert.throws(() => buildLinearPath(noCurrent), /`current_node`/);
  });
});

describe("nodeToMarkdown", () => {
  const sections = () =>
    buildLinearPath(filtering)
      .map(nodeToMarkdown)
      .filter((section) => section !== null);

  it("drops system, tool, user_editable_context, non-final and empty messages", () => {
    const text = sections().join("\n");
    for (const hidden of [
      "SYSTEM PROMPT",
      "USER PROFILE",
      "USER INSTRUCTIONS",
      "THOUGHT",
      "ANALYSIS CHANNEL",
      "TOOL CALL",
      "TOOL OUTPUT",
    ]) {
      assert.ok(!text.includes(hidden), `${hidden} should be excluded`);
    }
  });

  it("keeps user and final assistant messages in order", () => {
    assert.deepEqual(sections(), [
      "## User\n\nQuestion with **markdown** and `code`",
      "## ChatGPT (gpt-test)\n\n# Heading\n\n- item with \\*escaped\\* star\n",
      "## User\n\n*[attachment]*\n\nWhat is in this image?",
      "## ChatGPT (gpt-test)\n\nA single pixel.",
    ]);
  });

  it("returns null for a node without a message", () => {
    assert.equal(nodeToMarkdown({ id: "root", message: null, parent: null }), null);
  });

  it("rejects a kept assistant message without model_slug", () => {
    const node = clone(filtering.mapping["a-plain"]);
    delete node.message.metadata.model_slug;
    assert.throws(() => nodeToMarkdown(node), /model_slug/);
  });

  it("rejects a message without author.role or content_type", () => {
    const noRole = clone(filtering.mapping.u1);
    delete noRole.message.author;
    assert.throws(() => nodeToMarkdown(noRole), /author\.role/);

    const noType = clone(filtering.mapping.u1);
    delete noType.message.content.content_type;
    assert.throws(() => nodeToMarkdown(noType), /content_type/);
  });

  it("rejects a kept message without a parts array", () => {
    const node = clone(filtering.mapping.u1);
    delete node.message.content.parts;
    assert.throws(() => nodeToMarkdown(node), /content\.parts/);
  });
});

describe("yamlQuote", () => {
  it("escapes quotes, backslashes, newlines and control characters", () => {
    const title = 'He said "hi"\nsecond line\\path\ttab\u0007bell\u2028end';
    const quoted = yamlQuote(title);
    assert.equal(quoted, '"He said \\"hi\\"\\nsecond line\\\\path\\ttab\\u0007bell\\u2028end"');
    assert.ok(!quoted.includes("\n"));
    // These escapes are a subset that JSON shares with YAML double quotes.
    assert.equal(JSON.parse(quoted), title);
  });

  it("leaves non-ASCII text as is", () => {
    assert.equal(yamlQuote("研究方針の議論"), '"研究方針の議論"');
  });
});

describe("buildMarkdown", () => {
  it("assembles front matter and the current branch", () => {
    assert.equal(
      buildMarkdown(branched, UUID, EXPORTED_AT),
      [
        "---",
        'title: "Synthetic branch test"',
        `conversation_id: ${UUID}`,
        "created: 2025-01-01T00:00:00.500Z",
        "exported: 2026-01-02T03:04:05.000Z",
        `url: https://chatgpt.com/c/${UUID}`,
        "---",
        "",
        "## User",
        "",
        "First question",
        "",
        "## ChatGPT (gpt-test-a)",
        "",
        "First answer",
        "",
        "## User",
        "",
        "Edited question",
        "",
        "## ChatGPT (gpt-test-b)",
        "",
        "Final answer",
        "",
      ].join("\n"),
    );
  });

  it("escapes a title with quotes and a newline", () => {
    const conversation = clone(branched);
    conversation.title = 'Plan "B"\nrevised';
    const markdown = buildMarkdown(conversation, UUID, EXPORTED_AT);
    assert.ok(markdown.startsWith('---\ntitle: "Plan \\"B\\"\\nrevised"\n'));
  });

  it("rejects a missing title or create_time", () => {
    const noTitle = clone(branched);
    delete noTitle.title;
    assert.throws(() => buildMarkdown(noTitle, UUID, EXPORTED_AT), /`title`/);

    const noCreated = clone(branched);
    delete noCreated.create_time;
    assert.throws(() => buildMarkdown(noCreated, UUID, EXPORTED_AT), /`create_time`/);
  });

  it("rejects a conversation with nothing to export", () => {
    const conversation = clone(branched);
    conversation.current_node = "sys";
    assert.throws(() => buildMarkdown(conversation, UUID, EXPORTED_AT), /no user or assistant/);
  });
});
