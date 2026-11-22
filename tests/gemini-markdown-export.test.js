const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  extractConversationId,
  titleFromDocument,
  parseBatchResponse,
  chosenCandidate,
  collectSourceUrls,
  turnTime,
  fenceBody,
  turnToSections,
  buildMarkdown,
} = require("../scripts/gemini-markdown-export.user.js");

// Synthetic payload of the history RPC: [turns (newest first), page token, …].
const history = require("./fixtures/gemini-history.json");

const ID = "00000000000000aa";
const EXPORTED_AT = new Date("2026-01-02T03:04:05.000Z");
const turns = history[0];
const [newest, , middle, oldest] = turns;

/** A message body as the script fences it (no backtick run of 3+ inside). */
const fenced = (text) => `\`\`\`markdown\n${text}\n\`\`\``;
const followUp = '<FollowUp label="Ask more" query="Tell me more"/>';
const sourcesList = "Sources:\n- https://example.com/a\n- https://example.org/b";

/** Wraps a payload the way batchexecute sends it. */
function batchBody(rpcId, payload) {
  const line = JSON.stringify([
    ["wrb.fr", rpcId, JSON.stringify(payload), null, null, null, "generic"],
    ["di", 42],
  ]);
  return `)]}'\n\n${line.length}\n${line}\n25\n[["e",4,null,null,123]]\n`;
}

describe("extractConversationId", () => {
  it("reads /app/<id>", () => {
    assert.equal(extractConversationId(`/app/${ID}`), ID);
    assert.equal(extractConversationId(`/app/${ID}/`), ID);
  });

  it("returns null without a conversation", () => {
    for (const pathname of ["/", "/app", "/app/", "/gems/view", `/share/${ID}`, "/app/xyz"]) {
      assert.equal(extractConversationId(pathname), null, pathname);
    }
  });
});

describe("titleFromDocument", () => {
  it("drops the site suffix", () => {
    assert.equal(titleFromDocument("Synthetic chat - Google Gemini"), "Synthetic chat");
  });

  it("returns empty for a page without a conversation title", () => {
    assert.equal(titleFromDocument("Google Gemini"), "");
    assert.equal(titleFromDocument(""), "");
  });
});

describe("parseBatchResponse", () => {
  it("decodes the entry of the requested RPC", () => {
    assert.deepEqual(parseBatchResponse(batchBody("hNvQHb", history), "hNvQHb"), history);
  });

  it("fails when the RPC is missing", () => {
    assert.throws(() => parseBatchResponse(batchBody("other", history), "hNvQHb"), /no hNvQHb/);
    assert.throws(() => parseBatchResponse("<html>login</html>", "hNvQHb"), /no hNvQHb/);
  });
});

describe("chosenCandidate", () => {
  it("picks the draft whose ID matches the chosen one", () => {
    assert.equal(chosenCandidate(middle)[0], "rc_0000000000000022");
  });

  it("falls back to the first draft", () => {
    assert.equal(chosenCandidate(oldest)[0], "rc_0000000000000011");
  });

  it("returns null for unexpected shapes", () => {
    assert.equal(chosenCandidate(null), null);
    assert.equal(chosenCandidate([0, 1, 2, "x"]), null);
  });
});

describe("collectSourceUrls", () => {
  it("collects cited URLs in order, without duplicates or favicons", () => {
    assert.deepEqual(collectSourceUrls(chosenCandidate(newest)[2]), [
      "https://example.com/a",
      "https://example.org/b",
    ]);
  });

  it("returns nothing when there are no sources", () => {
    assert.deepEqual(collectSourceUrls(null), []);
    assert.deepEqual(collectSourceUrls([[1, 2, ["not a url"]]]), []);
  });
});

describe("turnTime", () => {
  it("reads [seconds, nanos]", () => {
    assert.equal(turnTime(oldest).toISOString(), "2025-01-01T00:00:00.000Z");
    assert.equal(turnTime([]), null);
  });
});

describe("fenceBody", () => {
  it("makes the fence longer than any backtick run inside", () => {
    const body = "## Heading\n\n```c\nint x;\n```\n";
    assert.equal(fenceBody(body), "````markdown\n## Heading\n\n```c\nint x;\n```\n````");
  });

  it("uses three backticks at least", () => {
    assert.equal(fenceBody("`a`"), "```markdown\n`a`\n```");
  });
});

describe("turnToSections", () => {
  it("outputs the chosen draft only, without reasoning", () => {
    assert.deepEqual(turnToSections(middle), [
      `## User\n\n${fenced("Write it again, shorter.")}`,
      `## Gemini (Synthetic Model)\n\n${fenced("Short draft.")}`,
    ]);
  });

  it("keeps Gemini tags as is", () => {
    assert.ok(turnToSections(oldest)[1].endsWith(`${followUp}\n\`\`\``));
  });

  it("appends sources outside the fence and omits a missing model", () => {
    assert.equal(
      turnToSections(newest)[1],
      `## Gemini\n\n${fenced("Two pages were used.")}\n\n${sourcesList}`,
    );
  });

  it("skips missing sides and unexpected shapes", () => {
    const noUser = structuredClone(middle);
    noUser[2] = null;
    assert.equal(turnToSections(noUser).length, 1);
    assert.deepEqual(turnToSections("unexpected"), []);
  });
});

describe("buildMarkdown", () => {
  it("builds the document oldest first", () => {
    const markdown = buildMarkdown(turns, ID, 'A "synthetic" chat', EXPORTED_AT);
    assert.equal(
      markdown,
      [
        "---",
        'title: "A \\"synthetic\\" chat"',
        `conversation_id: c_${ID}`,
        "created: 2025-01-01T00:00:00.000Z",
        "exported: 2026-01-02T03:04:05.000Z",
        `url: https://gemini.google.com/app/${ID}`,
        "---",
        "",
        `## User\n\n${fenced("Hello")}`,
        "",
        `## Gemini (Synthetic Model)\n\n${fenced(`Hi there.\n\n${followUp}`)}`,
        "",
        `## User\n\n${fenced("Write it again, shorter.")}`,
        "",
        `## Gemini (Synthetic Model)\n\n${fenced("Short draft.")}`,
        "",
        `## User\n\n${fenced("Which sources did you use?")}`,
        "",
        `## Gemini\n\n${fenced("Two pages were used.")}\n\n${sourcesList}`,
        "",
      ].join("\n"),
    );
  });

  it("omits created when no time is known", () => {
    const untimed = turns.map((turn) => (Array.isArray(turn) ? [...turn.slice(0, 4), null] : turn));
    assert.doesNotMatch(buildMarkdown(untimed, ID, "", EXPORTED_AT), /^created:/m);
  });

  it("fails when nothing can be output", () => {
    assert.throws(() => buildMarkdown([], ID, "", EXPORTED_AT), /no user or Gemini messages/);
    assert.throws(() => buildMarkdown(["x", null], ID, "", EXPORTED_AT), /no user/);
  });
});
