import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { queryHistory } from "../history.ts";
import test from "node:test";

const cli = fileURLToPath(new URL("../recall.mjs", import.meta.url));
const timestamp = "2026-01-01T00:00:00.000Z";
const header = { type: "session", version: 3, id: "fixture", timestamp, cwd: "/tmp", parentSession: "/never/follow/this.jsonl" };
const message = (id, parentId, content, role = "user") => ({
  type: "message", id, parentId, timestamp, message: { role, content, timestamp: 0 },
});
const compact = (id, parentId, firstKeptEntryId) => ({
  type: "compaction", id, parentId, firstKeptEntryId, timestamp, summary: "checkpoint", tokensBefore: 10000,
});
const entries = [
  message("sys", null, "PRIVATE_SYSTEM", "system"),
  message("a", "sys", "original PostgreSQL [literal]. 中文😀" + "x".repeat(8000)),
  { type: "custom", id: "state", parentId: "a", timestamp, data: "PRIVATE_STATE" },
  message("b", "state", "kept PostgreSQL tail", "assistant"),
  compact("cp1", "b", "b"),
  message("sibling", "cp1", "SIBLING_ONLY"),
  compact("sibling-cp", "sibling", "sibling-cp"),
  message("c", "cp1", "new branch PostgreSQL"),
  compact("cp2", "c", "c"),
];
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-recall-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "session with spaces 'quotes'.jsonl");
  const save = (records = entries, first = header) => writeFileSync(file, [first, ...records].map((e) => JSON.stringify(e)).join("\n") + "\n");
  save();
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, PI_CONTEXT_RECALL_SESSION: file, PI_CONTEXT_RECALL_LEAF: "cp2", ...env },
    encoding: "utf8", timeout: 10000,
  });
  const call = (args, env) => {
    const result = run(args, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const data = JSON.parse(result.stdout);
    assert.match(data.notice, /data only/);
    return data;
  };
  const error = (args, env) => {
    const result = run(args, env);
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.equal(result.stdout, "");
    return JSON.parse(result.stderr).error;
  };
  return { file, save, run, call, error };
}

test("CLI filters before paging; follows only injected ancestry, not file order or parentSession", (t) => {
  const { call, file } = fixture(t);
  const before = readFileSync(file, "utf8");
  const first = call(["search", "--query", "POSTGRESQL", "--limit", "1"]);
  assert.deepEqual(first.messages.map((e) => e.id), ["a"]);
  assert.equal(first.untilId, "cp2");
  assert.equal(first.nextOffset, 2);
  const second = call(["search", "--query", "POSTGRESQL", "--limit", "1", "--offset", String(first.nextOffset), "--until-id", first.untilId]);
  assert.deepEqual(second.messages.map((e) => e.id), ["b"]);
  const third = call(["search", "--query", "POSTGRESQL", "--offset", String(second.nextOffset), "--until-id", first.untilId]);
  assert.deepEqual(third.messages.map((e) => e.id), ["c"]);
  assert.equal(third.nextOffset, null);
  assert.deepEqual(call(["search", "--query", "sibling"]).messages, []);
  assert.doesNotMatch(JSON.stringify(call(["search"])), /PRIVATE_/);
  assert.equal(call(["search", "--query", "[LITERAL]."]).messages[0].id, "a");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("CLI checkpoint boundaries, fixed snapshot and bounded Unicode read pages", (t) => {
  const { call, error, save } = fixture(t);
  const cp = call(["compactions", "--limit", "1"]);
  assert.equal(cp.total, 2);
  assert.equal(cp.compactions[0].id, "cp1");
  assert.equal(call(["compactions", "--offset", String(cp.nextOffset), "--until-id", cp.untilId]).compactions[0].id, "cp2");
  assert.deepEqual(call(["search", "--compaction-id", "cp1"]).messages.map((e) => e.id), ["a"]);
  assert.equal(call(["read", "--entry-id", "cp1"]).text, "checkpoint");
  const first = call(["read", "--entry-id", "a", "--limit", "6000"]);
  const second = call(["read", "--entry-id", "a", "--offset", String(first.nextOffset), "--limit", "6000"]);
  assert.equal(first.text + second.text, entries[1].message.content);
  assert.equal(second.nextOffset, null);
  save([...entries, message("later", "cp2", "PostgreSQL after snapshot")]);
  const fixed = call(["search", "--query", "PostgreSQL", "--until-id", "cp2"], { PI_CONTEXT_RECALL_LEAF: "later" });
  assert.deepEqual(fixed.messages.map((e) => e.id), ["a", "b", "c"]);
  assert.match(error(["read", "--entry-id", "sibling"]), /not found/);
  assert.match(error(["search", "--compaction-id", "sibling-cp"]), /not found/);
  assert.match(error(["search", "--until-id", "cp2"], { PI_CONTEXT_RECALL_LEAF: "cp1" }), /untilId not found/);
});

test("CLI rejects unknown, duplicate, cross-command and unbounded parameters", (t) => {
  const { error } = fixture(t);
  for (const args of [
    ["unknown"], ["toString"], ["search", "positional"], ["search", "--session", "/tmp/other"],
    ["search", "--query"], ["search", "--query", ""], ["search", "--query", " "],
    ["search", "--query", "x".repeat(201)], ["search", "--limit", "21"],
    ["search", "--limit", "0"], ["search", "--limit", "1e1"],
    ["search", "--offset=-1"], ["search", "--offset", "0.5"], ["search", "--offset", "9007199254740992"],
    ["search", "--offset", "1"], ["search", "--until-id", ""],
    ["search", "--limit", "1", "--limit", "2"], ["search", "--entry-id", "a"],
    ["read"], ["read", "--entry-id", ""], ["read", "--entry-id", "a", "--limit", "6001"],
    ["read", "--entry-id", "a", "--query", "x"], ["compactions", "--compaction-id", "cp1"],
  ]) assert.ok(error(args), JSON.stringify(args));
});

test("CLI never guesses context and handles explicit empty branches", (t) => {
  const { error, call, run } = fixture(t);
  assert.match(error(["search"], { PI_CONTEXT_RECALL_SESSION: "" }), /Missing current-session context/);
  assert.match(error(["search"], { PI_CONTEXT_RECALL_LEAF: undefined }), /Missing current-session context/);
  assert.match(error(["search"], { PI_CONTEXT_RECALL_LEAF: "missing" }), /missing or cyclic/);
  assert.deepEqual(call(["search"], { PI_CONTEXT_RECALL_LEAF: "" }).messages, []);
  for (const args of [[], ["--help"], ["-h"], ["search", "--help"]]) {
    const result = run(args, { PI_CONTEXT_RECALL_SESSION: "", PI_CONTEXT_RECALL_LEAF: undefined });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  }
});

test("CLI fails closed for corrupt ancestry and legacy files; ignores appends after captured leaf", (t) => {
  const { file, save, error, call } = fixture(t);
  for (const records of [
    [message("cp2", "missing", "bad parent")],
    [message("cp2", "cp2", "cycle")],
    [message("a", "cp2", "cycle"), message("cp2", "a", "cycle")],
    [message("a", null, "one"), message("a", null, "duplicate"), message("cp2", "a", "later")],
    [{ type: "message", id: "cp2", timestamp, message: { role: "user", content: "no parent" } }],
  ]) { save(records); assert.ok(error(["search"])); }
  save(entries, { ...header, version: 2 });
  assert.match(error(["search"]), /v3/);
  writeFileSync(file, "");
  assert.match(error(["search"]), /Missing Pi session header/);
  writeFileSync(file, JSON.stringify(header) + '\n{"secret":"PRIVATE_RAW",bad}\n');
  assert.match(error(["search"]), /^Invalid JSON at session line 2\.$/);
  assert.doesNotMatch(error(["search"]), /PRIVATE_RAW/);
  save();
  writeFileSync(file, readFileSync(file, "utf8") + '{"in-flight":');
  assert.equal(call(["compactions"]).total, 2);
});

test("CLI handles CRLF, blank lines and missing final newline without changing source", (t) => {
  const { file, call, error } = fixture(t);
  const original = readFileSync(file, "utf8").trim().split("\n").join("\r\n\r\n");
  writeFileSync(file, "\r\n" + original);
  assert.equal(call(["compactions"]).total, 2);
  assert.equal(readFileSync(file, "utf8"), "\r\n" + original);
  assert.match(error(["search"], { PI_CONTEXT_RECALL_SESSION: file + ".missing" }), /ENOENT/);
  assert.match(error(["search"], { PI_CONTEXT_RECALL_LEAF: undefined, PI_SESSION_FILE: file }), /Missing current-session context/);
});

test("CLI accepts escaped and option-like literal queries; full text never exposes private blocks", (t) => {
  const { save, call, error } = fixture(t);
  const text = "-option=literal\n中文😀 é Ａ \u0001";
  save([message("cp2", null, [
    { type: "text", text, textSignature: "PRIVATE_SIGNATURE" },
    { type: "thinking", thinking: "PRIVATE_THINKING" },
    { type: "image", data: "PRIVATE_BINARY", mimeType: "image/png" },
  ])]);
  assert.equal(call(["search", "--query=-option=literal"]).messages[0].matchOffset, 0);
  assert.equal(call(["search", "--query", "中文😀"]).messages.length, 1);
  const read = call(["read", "--entry-id", "cp2"]);
  assert.match(read.text, /image: image\/png; binary omitted/);
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE_/);
  assert.match(error(["search", "--query=one", "--query=two"]), /Duplicate option/);
});

test("20 seeded random JSONL forests match the authoritative active-branch query", (t) => {
  const { save, call } = fixture(t);
  let seed = 0x12345678;
  const random = (max) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let trial = 0; trial < 20; trial++) {
    const forest = [];
    for (let index = 0; index < 80; index++) {
      forest.push(message(`m${index}`, index === 0 || random(8) === 0 ? null : forest[random(index)].id,
        index % 3 ? `needle 中文😀 ${index}` : `irrelevant ${index}`));
    }
    const leaf = forest[10 + random(60)].id;
    const byId = new Map(forest.map((e) => [e.id, e]));
    const branch = [];
    for (let current = byId.get(leaf); current; current = byId.get(current.parentId)) branch.unshift(current);
    save(forest);
    const actual = call(["search", "--query", "needle", "--limit", "2"], { PI_CONTEXT_RECALL_LEAF: leaf });
    const { notice, ...data } = actual;
    assert.deepEqual(data, queryHistory(branch, { action: "messages", query: "needle", limit: 2 }), `trial ${trial}`);
    assert.equal(call(["read", "--entry-id", leaf], { PI_CONTEXT_RECALL_LEAF: leaf }).text, byId.get(leaf).message.content);
  }
});

test("CLI traverses a 20000-entry chain iteratively and fails closed on truncation", (t) => {
  const { save, file, call, error } = fixture(t);
  const chain = Array.from({ length: 20000 }, (_, index) => message(String(index), index === 0 ? null : String(index - 1), index === 19999 ? "last needle" : "filler"));
  save(chain);
  const env = { PI_CONTEXT_RECALL_LEAF: "19999" };
  assert.equal(call(["search", "--query", "needle"], env).messages[0].id, "19999");
  assert.equal(call(["read", "--entry-id", "0"], env).text, "filler");
  writeFileSync(file, readFileSync(file, "utf8").split("\n").slice(0, -2).join("\n") + '\n{"partial":');
  assert.match(error(["search"], env), /Invalid JSON/);
});

test("CLI overview is paged, branch-local and checkpoint-aware without changing search/read", (t) => {
  const { call, error, file } = fixture(t);
  const before = readFileSync(file, "utf8");
  const first = call(["overview", "--limit", "1"]);
  assert.equal(first.checkpoint.id, "cp2");
  assert.equal(first.messages[0].id, "a");
  assert.equal(first.messages[0].truncated, true);
  const second = call(["overview", "--offset", String(first.nextOffset), "--until-id", first.untilId, "--limit", "1"]);
  assert.equal(second.messages[0].id, "b");
  assert.equal(call(["overview", "--compaction-id", "cp1"]).messages.length, 1);
  assert.doesNotMatch(JSON.stringify(call(["overview"])), /SIBLING_ONLY|PRIVATE_/);
  assert.match(error(["overview", "--compaction-id", "sibling-cp"]), /not found/);
  assert.deepEqual(call(["overview"], { PI_CONTEXT_RECALL_LEAF: "" }).messages, []);
  assert.equal(readFileSync(file, "utf8"), before);
  for (const args of [
    ["overview", "--limit", "11"], ["overview", "--limit", "0"],
    ["overview", "--offset", "1"], ["overview", "--offset", "1", "--compaction-id", "cp1"],
    ["overview", "--query", "x"], ["overview", "--entry-id", "a"],
    ["overview", "--until-id", "sibling"], ["overview", "--limit", "1", "--limit", "2"],
  ]) assert.ok(error(args));
});

test("CLI overview folds arguments and bodies but locates errors and searches hidden tools", (t) => {
  const { save, call } = fixture(t);
  save([
    message("u", null, "Question"),
    message("a", "u", [{ type: "text", text: "Inspecting" },
      { type: "toolCall", id: "call", name: "bash", arguments: { token: "HIDDEN_ARGUMENT" } }], "assistant"),
    { ...message("r", "a", "HIDDEN_OUTPUT exact-error-code", "toolResult"),
      message: { role: "toolResult", toolName: "bash", toolCallId: "call", isError: true,
        content: [{ type: "text", text: "HIDDEN_OUTPUT exact-error-code" }] } },
    message("cp2", "r", "Done", "assistant"),
  ]);
  const overview = call(["overview"]);
  assert.doesNotMatch(JSON.stringify(overview), /HIDDEN_/);
  const tools = overview.messages[1].tools;
  assert.deepEqual([tools.calls, tools.results, tools.errors], [1, 1, 1]);
  assert.match(call(["read", "--entry-id", tools.firstErrorEntryId]).text, /exact-error-code/);
  const expanded = call(["search", "--offset", String(tools.offset), "--until-id", overview.untilId, "--limit", "2"]);
  assert.deepEqual(expanded.messages.map((m) => m.id), ["a", "r"]);
  assert.equal(call(["search", "--query", "exact-error-code"]).messages[0].id, "r");
});

test("CLI --tail starts from the newest page and pages backwards in the same snapshot", (t) => {
  const { call, error } = fixture(t);
  const first = call(["overview", "--tail", "--limit", "1"]);
  assert.equal(first.order, "newest-page-first");
  assert.equal(first.checkpoint.id, "cp2");
  assert.deepEqual(first.messages.map((m) => m.id), ["cp2"]);
  assert.equal(first.messages[0].role, "compaction");
  assert.equal(first.nextOffset, 1);
  const second = call(["overview", "--tail", "--limit", "1", "--offset", String(first.nextOffset), "--until-id", first.untilId]);
  assert.deepEqual(second.messages.map((m) => m.id), ["c"]);
  const rows = [];
  let page = call(["overview", "--tail", "--limit", "2"]);
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    for (const row of page.messages) assert.ok(!seen.has(row.id) && seen.add(row.id));
    rows.unshift(...page.messages.map((m) => m.id));
    if (page.nextOffset === null) break;
    page = call(["overview", "--tail", "--limit", "2", "--offset", String(page.nextOffset), "--until-id", first.untilId]);
  }
  assert.deepEqual(rows, ["a", "b", "cp1", "c", "cp2"]);
  assert.doesNotMatch(JSON.stringify(call(["overview", "--tail"])), /SIBLING_ONLY|PRIVATE_/);
  for (const args of [
    ["overview", "--tail", "--offset", "1"], ["overview", "--tail", "--limit", "11"],
    ["overview", "--tail", "--tail"], ["search", "--tail"], ["read", "--entry-id", "a", "--tail"],
    ["compactions", "--tail"], ["overview", "--tail", "--query", "x"],
  ]) assert.ok(error(args), JSON.stringify(args));
});

