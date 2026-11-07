const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  extractConversationId,
  buildLinearPath,
  nodeToMarkdown,
  collectSources,
  replaceCitations,
  yamlQuote,
  buildMarkdown,
} = require("../scripts/chatgpt-markdown-export.user.js");

const branched = require("./fixtures/branched.json");
const filtering = require("./fixtures/filtering.json");
const form = require("./fixtures/form.json");
const citations = require("./fixtures/citations.json");

const UUID = "11111111-2222-4333-8444-555555555555";
const EXPORTED_AT = new Date("2026-01-02T03:04:05.000Z");

// Fixtures are shared via the require cache, so mutate copies only.
const clone = (value) => structuredClone(value);

const sectionsOf = (conversation) =>
  buildLinearPath(conversation)
    .map((node, index, path) => nodeToMarkdown(node, path[index - 1]))
    .filter((section) => section !== null);

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

  it("treats a node without a parent field as the root", () => {
    const conversation = clone(branched);
    delete conversation.mapping.root.parent;
    assert.equal(buildLinearPath(conversation).length, 6);
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
  const sections = () => sectionsOf(filtering);

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

  it("drops messages hidden from the conversation", () => {
    const text = sectionsOf(citations).join("\n");
    assert.ok(!text.includes("DUPLICATE"));
  });

  it("uses a plain heading when model_slug is missing", () => {
    const node = clone(filtering.mapping["a-plain"]);
    delete node.message.metadata.model_slug;
    assert.equal(nodeToMarkdown(node), "## ChatGPT\n\nA single pixel.");
  });

  it("skips messages without author.role, content_type or parts", () => {
    const noRole = clone(filtering.mapping.u1);
    delete noRole.message.author;
    const noType = clone(filtering.mapping.u1);
    delete noType.message.content.content_type;
    const noParts = clone(filtering.mapping.u1);
    delete noParts.message.content.parts;
    for (const node of [noRole, noType, noParts]) {
      assert.equal(nodeToMarkdown(node), null);
    }
  });
});

describe("form responses", () => {
  it("labels a user message that answers a form widget", () => {
    const sections = sectionsOf(form);
    assert.equal(sections[2], '## User (form response)\n\nColor: "blue".');
  });

  it("keeps the form markup in the assistant message as is", () => {
    assert.match(
      sectionsOf(form)[1],
      /^## ChatGPT \(gpt-test\)\n\nPlease fill in:\n\n<box>\n {2}<form>/,
    );
  });

  it("does not label replies to a message that only shows <form> in code", () => {
    const sections = sectionsOf(form);
    assert.equal(sections[0], "## User\n\nAsk me what you need.");
    assert.equal(sections[4], "## User\n\nThanks.");
  });
});

describe("citations", () => {
  it("collects sources from any depth and ignores non-string ref_id", () => {
    const sources = collectSources(citations);
    assert.deepEqual([...sources.keys()].sort(), ["turn1search0", "turn1view1", "turn2search3"]);
    assert.deepEqual(sources.get("turn1search0"), {
      url: "https://example.com/a",
      title: "Paper A",
    });
  });

  it("replaces known refs with links and keeps unknown ones", () => {
    const sources = collectSources(citations);
    assert.equal(
      replaceCitations('A.<Cite ref="turn1search0"/> B.<Cite ref="turn1search9"/>', sources),
      'A.([Paper A](https://example.com/a)) B.<Cite ref="turn1search9"/>',
    );
  });

  it("escapes brackets, flattens whitespace and falls back to the URL", () => {
    const sources = collectSources(citations);
    assert.equal(
      replaceCitations('<Cite ref="turn1view1"/> <Cite ref="turn2search3"/>', sources),
      "([\\[PDF\\] Spec v2](https://example.com/spec.pdf)) " +
        "([https://example.com/untitled](https://example.com/untitled))",
    );
  });

  it("handles a tag with several refs", () => {
    const sources = collectSources(citations);
    assert.equal(
      replaceCitations('X.<Cite refs={["turn1search0","turn9search9"]}/>', sources),
      "X.([Paper A](https://example.com/a); turn9search9)",
    );
  });

  it("resolves refs whose source is stored on another message", () => {
    const markdown = buildMarkdown(citations, UUID, EXPORTED_AT);
    assert.ok(
      markdown.includes("See the spec.([\\[PDF\\] Spec v2](https://example.com/spec.pdf))"),
    );
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

  it("tolerates a missing title or create_time", () => {
    const conversation = clone(branched);
    delete conversation.title;
    delete conversation.create_time;
    const markdown = buildMarkdown(conversation, UUID, EXPORTED_AT);
    assert.ok(markdown.startsWith(`---\ntitle: ""\nconversation_id: ${UUID}\nexported: `));
  });

  it("rejects a conversation with nothing to export", () => {
    const conversation = clone(branched);
    conversation.current_node = "sys";
    assert.throws(() => buildMarkdown(conversation, UUID, EXPORTED_AT), /no user or assistant/);
  });
});
