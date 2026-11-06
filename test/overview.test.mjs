import assert from "node:assert/strict";
import test from "node:test";
import { queryHistory } from "../history.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const msg = (id, role, content, extra = {}) => ({
  type: "message", id, parentId: null, timestamp, message: { role, content, ...extra },
});
const call = (name = "bash") => ({ type: "toolCall", id: "call", name, arguments: { secret: "HIDDEN_ARGUMENT" } });
const result = (id, name = "bash", isError = false) => msg(id, "toolResult", "HIDDEN_OUTPUT error needle", { toolName: name, isError });
const cp = (id, firstKeptEntryId) => ({ type: "compaction", id, timestamp, parentId: null,
  firstKeptEntryId, summary: "saved checkpoint summary", tokensBefore: 20000 });
const fixture = () => [
  msg("u", "user", "Question 中文😀"),
  msg("a", "assistant", [{ type: "text", text: "Inspecting the original" }, call()]),
  result("r1"), msg("a2", "assistant", [call("read")]), result("r2", "read", true),
  msg("done", "assistant", "Conclusion"), msg("kept", "user", "retained tail"), cp("cp", "kept"),
];
const overview = (entries, params = {}) => queryHistory(entries, { action: "overview", ...params });

function tailPages(entries, limit) {
  const rows = [];
  let offset = 0, untilId;
  for (let iterations = 0; iterations < entries.length + 2; iterations++) {
    const page = overview(entries, { offset, untilId, limit, tail: true });
    rows.unshift(...page.messages);
    untilId ??= page.untilId;
    if (page.nextOffset === null) return rows;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.fail("tail pagination must terminate");
}

function allPages(entries, limit) {
  const rows = [];
  let offset = 0, untilId;
  for (let iterations = 0; iterations < entries.length + 2; iterations++) {
    const page = overview(entries, { offset, untilId, limit });
    rows.push(...page.messages);
    untilId ??= page.untilId;
    if (page.nextOffset === null) return rows;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.fail("pagination must terminate");
}

test("overview projects user/assistant text, folds tool-only messages and preserves error locators", () => {
  const entries = fixture();
  const original = structuredClone(entries);
  const page = overview(entries);
  assert.equal(page.checkpoint.id, "cp");
  assert.equal(page.checkpoint.firstKeptEntryId, "kept");
  assert.deepEqual(page.messages.map((m) => [m.role, m.id]), [["user", "u"], ["assistant", "a"], ["assistant", "done"], ["user", "kept"], ["compaction", "cp"]]);
  assert.equal(queryHistory(entries, { action: "read", entryId: "cp" }).text, "saved checkpoint summary");
  const tools = page.messages[1].tools;
  assert.deepEqual([tools.calls, tools.results, tools.errors], [2, 2, 1]);
  assert.deepEqual(tools.byName, [{ name: "bash", calls: 1, results: 1, errors: 0 }, { name: "read", calls: 1, results: 1, errors: 1 }]);
  assert.deepEqual([tools.firstEntryId, tools.lastEntryId, tools.firstErrorEntryId, tools.offset], ["a", "r2", "r2", 1]);
  assert.doesNotMatch(JSON.stringify(page), /HIDDEN_/);
  assert.deepEqual(entries, original);
  assert.match(queryHistory(entries, { action: "read", entryId: tools.firstErrorEntryId }).text, /HIDDEN_OUTPUT/);
  assert.match(queryHistory(entries, { action: "read", entryId: "a" }).text, /HIDDEN_ARGUMENT/);
  assert.equal(queryHistory(entries, { action: "messages", query: "error needle" }).messages.length, 2);
});

test("overview pages by raw cursor without splitting an assistant's folded tool activity", () => {
  const entries = fixture();
  const first = overview(entries, { limit: 1 });
  assert.equal(first.nextOffset, 1);
  const second = overview(entries, { offset: first.nextOffset, untilId: first.untilId, limit: 1 });
  assert.equal(second.messages[0].tools.results, 2);
  assert.equal(second.nextOffset, 5);
  assert.deepEqual(allPages(entries, 1), allPages(entries, 10));
  assert.deepEqual(overview(entries, { offset: Number.MAX_SAFE_INTEGER, untilId: "cp" }).messages, []);
});

test("overview checkpoint is navigation metadata; archives overlap and retained tools do not leak", () => {
  const entries = [...fixture(), msg("next", "assistant", "new decision"), cp("cp2", "next")];
  const first = overview(entries, { compactionId: "cp" });
  assert.equal(first.checkpoint.id, "cp");
  assert.ok(!first.messages.some((m) => m.id === "kept"));
  const second = overview(entries, { compactionId: "cp2", limit: 10 });
  assert.equal(second.messages[0].id, first.messages[0].id);
  assert.ok(second.messages.some((m) => m.id === "kept"));
  assert.ok(!second.messages.some((m) => m.id === "next"));
  assert.equal(overview(entries, { untilId: "done" }).checkpoint, null);
  const boundary = [msg("a", "assistant", [call()]), result("kept-result"), cp("c", "kept-result")];
  assert.equal(overview(boundary, { compactionId: "c" }).messages[0].tools.results, 0);
  assert.deepEqual(overview([msg("kept", "user", "text"), cp("c", "kept")], { compactionId: "c" }).messages, []);
  assert.ok(overview([...fixture(), cp("none", "none")], { compactionId: "none" }).messages.some((m) => m.id === "kept"));
  assert.equal(overview([...fixture(), cp("none", "none")], { compactionId: "none" }).messages.at(-1).id, "cp");
});

test("overview uses fixed snapshots while appends continue and rejects invalid boundaries/options", () => {
  const entries = fixture();
  const first = overview(entries, { limit: 1 });
  entries.push(msg("later", "user", "new append"));
  const rows = allPages(entries.slice(0, -1), 1);
  let page = overview(entries, { untilId: first.untilId, offset: first.nextOffset, limit: 10 });
  assert.deepEqual([first.messages[0], ...page.messages], rows);
  for (const params of [
    { offset: 1 }, { compactionId: "cp", offset: 1 }, { untilId: "sibling" },
    { compactionId: "sibling" }, { query: "needle" }, { limit: 0 }, { limit: 11 },
    { limit: 1.5 }, { offset: -1 }, { offset: NaN },
  ]) assert.throws(() => overview(entries, params));
  assert.throws(() => overview([cp("broken", "missing")], { compactionId: "broken" }), /boundary/);
  assert.deepEqual(overview([]), { untilId: null, scope: "current branch (raw)", order: "oldest-first", checkpoint: null, messages: [], nextOffset: null });
});

test("orphan results, tool-only assistants and terminal bash fold without inventing conversation text", () => {
  const entries = [result("orphan", "bash", true), msg("tool-only", "assistant", [call()]),
    msg("terminal", "bashExecution", undefined, { command: "HIDDEN_COMMAND", output: "HIDDEN_TERMINAL", exitCode: 2, cancelled: false }),
    msg("abort", "bashExecution", undefined, { command: "HIDDEN_COMMAND", output: "", cancelled: true }),
    msg("u", "user", "next question")];
  const page = overview(entries);
  assert.deepEqual(page.messages.map((m) => m.role), ["tools", "user"]);
  assert.deepEqual([page.messages[0].tools.calls, page.messages[0].tools.results, page.messages[0].tools.errors], [3, 3, 3]);
  assert.deepEqual(allPages(entries, 1), allPages(entries, 10));
  assert.doesNotMatch(JSON.stringify(page), /HIDDEN_/);
});

test("missing tool names fold under a label instead of crashing; previews never split surrogate pairs", () => {
  const entries = [
    msg("u", "user", "😀".repeat(200)),
    { type: "message", id: "r", parentId: null, timestamp, message: { role: "toolResult", content: "output" } },
    msg("a", "assistant", [{ type: "toolCall", id: "c", arguments: {} },
      { type: "toolCall", id: "d", name: "x".repeat(39) + "😀", arguments: {} }]),
  ];
  const page = overview(entries);
  assert.equal(page.messages[0].preview.length, 300);
  assert.doesNotMatch(page.messages[0].preview, /[\uD800-\uDBFF]$/);
  assert.equal(page.messages[0].truncated, true);
  const tools = page.messages[1].tools;
  assert.deepEqual([tools.calls, tools.results, tools.errors], [2, 1, 0]);
  assert.ok(tools.byName.every((n) => !/[\uD800-\uDBFF]$/.test(n.name)));
  assert.ok(tools.byName.some((n) => n.name === "unknown"));
});

test("overview omits thinking/binary/private state and marks long text as preview", () => {
  const entries = [
    { type: "custom", id: "state", timestamp, data: "PRIVATE_STATE" },
    msg("a", "assistant", [{ type: "thinking", thinking: "PRIVATE_THINKING" },
      { type: "text", text: "😀汉字".repeat(200), textSignature: "PRIVATE_SIGNATURE" }, call(),
      { type: "image", mimeType: "image/png", data: "PRIVATE_BINARY" }]),
    msg("think-only", "assistant", [{ type: "thinking", thinking: "PRIVATE_THINKING" }]),
    msg("system", "system", "PRIVATE_SYSTEM"),
  ];
  const page = overview(entries);
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].truncated, true);
  assert.equal(page.messages[0].preview.length, 300);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE_|HIDDEN_ARGUMENT/);
});

test("large tool runs and many/long names remain bounded and preserve exact counts", () => {
  const entries = [msg("u", "user", "question")];
  for (let i = 0; i < 20000; i++) {
    const name = "\u0001".repeat(100) + (i % 10);
    entries.push(msg("a" + i, "assistant", [call(name)]), result("r" + i, name, i % 2 === 0));
  }
  const page = overview(entries);
  assert.equal(page.messages.length, 2);
  const tools = page.messages[1].tools;
  assert.deepEqual([tools.calls, tools.results, tools.errors], [20000, 20000, 10000]);
  assert.equal(tools.byName.length, 5);
  assert.equal(tools.other.calls, 10000);
  assert.equal(tools.other.results, 10000);
  assert.ok(tools.byName.every((n) => n.name.length <= 40));
  const worst = [];
  for (let i = 0; i < 10; i++) {
    worst.push(msg("m" + i, "assistant", [{ type: "text", text: "\u0001".repeat(400) },
      ...Array.from({ length: 8 }, (_, j) => call("\u0001".repeat(100) + j))]));
  }
  const bounded = overview(worst, { limit: 10 });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 50 * 1024);
});

test("tail pages from the newest row backwards and covers the same rows as forward paging", () => {
  const entries = fixture();
  const first = overview(entries, { tail: true, limit: 2 });
  assert.equal(first.order, "newest-page-first");
  assert.deepEqual(first.messages.map((m) => m.id), ["kept", "cp"]);
  assert.equal(first.nextOffset, 2);
  const second = overview(entries, { tail: true, limit: 2, offset: 2, untilId: first.untilId });
  assert.deepEqual(second.messages.map((m) => m.id), ["a", "done"]);
  assert.equal(second.nextOffset, 4);
  assert.deepEqual(tailPages(entries, 1), allPages(entries, 10));
  assert.deepEqual(tailPages(entries, 3), allPages(entries, 10));
  const single = overview(entries, { tail: true, limit: 1 });
  assert.deepEqual(single.messages.map((m) => m.id), ["cp"]);
  assert.equal(overview([], { tail: true }).messages.length, 0);
  assert.throws(() => overview(entries, { tail: true, offset: 1 }), /untilId/);
  assert.throws(() => overview(entries, { tail: true, limit: 11 }));
  assert.throws(() => queryHistory(entries, { action: "messages", tail: true }), /only supported by overview/);
  const archived = overview(entries, { tail: true, compactionId: "cp" });
  assert.deepEqual(archived.messages.map((m) => m.id), ["u", "a", "done"]);  const trailingTools = [...entries, result("last-result")];
  assert.equal(overview(trailingTools, { tail: true, limit: 1 }).messages[0].id, "last-result");
  assert.deepEqual(tailPages(trailingTools, 2), allPages(trailingTools, 10));
});

test("100 seeded mixed transcripts have identical folded rows across page sizes", () => {
  let seed = 0x5eed1234;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 100; trial++) {
    const entries = [];
    for (let i = 0; i < 100; i++) {
      switch (random(6)) {
        case 0: entries.push(msg(String(i), "user", "Question " + i)); break;
        case 1: entries.push(msg(String(i), "assistant", [{ type: "text", text: "Answer " + i }, call()])); break;
        case 2: entries.push(msg(String(i), "assistant", [call("read")])); break;
        case 3: entries.push(result(String(i), "read", Boolean(random(2)))); break;
        case 4: entries.push({ type: "custom", id: String(i), timestamp, data: "PRIVATE" }); break;
        default: entries.push(msg(String(i), "assistant", "Answer " + i));
      }
    }
    assert.deepEqual(allPages(entries, 1 + random(4)), allPages(entries, 10), "trial " + trial);
  }
});

test("timeline keeps checkpoints, extension notices and branch summaries visible and readable", () => {
  const entries = [
    msg("u", "user", "start"),
    cp("cp1", "kept"),
    { type: "custom_message", id: "cm", parentId: null, timestamp, customType: "delegate", content: "任务完成通知" },
    { type: "message", id: "bs", parentId: null, timestamp, message: { role: "branchSummary", summary: "BRANCH", fromId: "x" } },
    { type: "message", id: "legacy", parentId: null, timestamp, message: { role: "compactionSummary", summary: "LEGACY", tokensBefore: 1 } },
    msg("kept", "user", "tail"),
  ];
  const page = overview(entries, { limit: 10 });
  assert.deepEqual(page.messages.map((m) => [m.role, m.id]), [
    ["user", "u"], ["compaction", "cp1"], ["custom:delegate", "cm"],
    ["branchSummary", "bs"], ["compactionSummary", "legacy"], ["user", "kept"],
  ]);
  assert.match(page.messages[2].preview, /任务完成通知/);
  for (const id of ["cp1", "cm", "bs", "legacy"]) {
    assert.ok(queryHistory(entries, { action: "read", entryId: id }).text.length > 0, id);
  }
  assert.equal(overview(entries, { limit: 2, untilId: page.untilId }).messages.length, 2);
  assert.deepEqual(tailPages(entries, 1), allPages(entries, 10));
});
