import assert from "node:assert/strict";
import test from "node:test";
import { queryHistory } from "../history.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const message = (id, content, role = "user") => ({
  type: "message", id, parentId: null, timestamp,
  message: { role, content, timestamp: 0 },
});
const compact = (id, firstKeptEntryId, summary = "checkpoint") => ({
  type: "compaction", id, parentId: null, timestamp, firstKeptEntryId,
  summary, tokensBefore: 10000,
});
const branch = [
  message("a", "original decision: PostgreSQL"),
  message("b", "old tool output", "toolResult"),
  message("c", "retained tail"),
  compact("cp1", "c", "first summary"),
  message("d", "later decision"),
  compact("cp2", "d", "second summary"),
  message("e", "current request"),
];

test("lists repeated compactions; pages summaries without dumping them", () => {
  const first = queryHistory(branch, { action: "compactions", limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.compactions[0].id, "cp1");
  assert.equal(first.nextOffset, 1);
  const second = queryHistory(branch, { action: "compactions", offset: first.nextOffset });
  assert.equal(second.compactions[0].id, "cp2");
  assert.equal(second.nextOffset, null);
  assert.equal(queryHistory(branch, { action: "read", entryId: "cp1" }).text, "first summary");
});

test("firstKeptEntryId excludes kept tail; subsequent archives include earlier originals", () => {
  const first = queryHistory(branch, { action: "messages", compactionId: "cp1" });
  assert.deepEqual(first.messages.map((m) => m.id), ["a", "b"]);
  const second = queryHistory(branch, { action: "messages", compactionId: "cp2" });
  assert.deepEqual(second.messages.map((m) => m.id), ["a", "b", "c", "cp1"]);
  const noneKept = [...branch, compact("cp3", "cp3")];
  assert.equal(queryHistory(noneKept, { action: "messages", compactionId: "cp3" }).messages.at(-1).id, "e");
});

test("literal, case-insensitive search returns a usable offset deep in a message", () => {
  const text = "x".repeat(1000) + " Chosen [PostgreSQL]. ✅";
  const entries = [message("match", text), message("no-match", "postgresql")];
  const result = queryHistory(entries, { action: "messages", query: "[POSTGRESQL]." });
  assert.equal(result.messages.length, 1);
  const hit = result.messages[0];
  assert.match(hit.preview, /Chosen \[PostgreSQL\]/);
  const needle = "[PostgreSQL].";
  assert.equal(text.slice(hit.matchOffset, hit.matchOffset + needle.length), needle);
  assert.equal(queryHistory(entries, { action: "read", entryId: hit.id, offset: hit.matchOffset, limit: needle.length }).text, needle);
});

test("search escapes every regex metacharacter and preserves Unicode offsets", () => {
  const needle = ".*+?^${}()|[]\\\\";
  const text = "İ😀 前文 " + needle;
  const result = queryHistory([message("literal", text)], { action: "messages", query: needle });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].matchOffset, text.indexOf(needle));
});

test("empty archive when the first kept entry is the earliest message", () => {
  assert.deepEqual(queryHistory([message("first", "kept"), compact("cp", "first")], {
    action: "messages", compactionId: "cp",
  }).messages, []);
});

test("worst-case escaped text keeps each result below Pi's 50 KiB output bound", () => {
  const entries = Array.from({ length: 20 }, (_, i) => message(`m${i}`, "\u0001".repeat(10000)));
  const messages = queryHistory(entries, { action: "messages", limit: 20 });
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) < 50 * 1024);
  const compactions = entries.map((_, i) => compact(`cp${i}`, `cp${i}`, "\u0001".repeat(10000)));
  assert.ok(Buffer.byteLength(JSON.stringify(queryHistory(compactions, { action: "compactions", limit: 20 }))) < 50 * 1024);
  const read = queryHistory(entries, { action: "read", entryId: "m0", limit: 6000 });
  assert.ok(Buffer.byteLength(JSON.stringify(read)) < 50 * 1024);
});

test("messages pagination cursor counts raw entries, not just matches", () => {
  const entries = [
    { type: "custom", id: "hidden", timestamp, data: "secret" },
    message("a", "needle"), message("b", "irrelevant"), message("c", "needle"),
  ];
  const first = queryHistory(entries, { action: "messages", query: "needle", limit: 1 });
  assert.equal(first.nextOffset, 2);
  const second = queryHistory(entries, { action: "messages", query: "needle", offset: first.nextOffset, untilId: first.untilId });
  assert.deepEqual(second.messages.map((m) => m.id), ["c"]);
  assert.equal(second.nextOffset, null);
});

test("fixed snapshot ends pagination while queries append new entries", () => {
  const entries = [message("a", "first"), message("b", "second"), message("c", "third")];
  let page = queryHistory(entries, { action: "messages", limit: 1 });
  const seen = page.messages.map((m) => m.id);
  for (let turn = 0; page.nextOffset !== null && turn < 10; turn++) {
    entries.push(message(`call${turn}`, "history tool call", "assistant"), message(`result${turn}`, "history result", "toolResult"));
    page = queryHistory(entries, { action: "messages", limit: 1, offset: page.nextOffset, untilId: page.untilId });
    seen.push(...page.messages.map((m) => m.id));
  }
  assert.equal(page.nextOffset, null);
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.throws(() => queryHistory(entries, { action: "messages", offset: 1 }), /requires the untilId/);
  assert.throws(() => queryHistory(entries, { action: "messages", untilId: "other-branch" }), /untilId not found/);
});

test("read reconstructs large Unicode text in bounded pages", () => {
  const text = "中文✅😀\n".repeat(4000);
  const entries = [message("long", text)];
  let reconstructed = "";
  let offset = 0;
  do {
    const page = queryHistory(entries, { action: "read", entryId: "long", offset, limit: 6000 });
    assert.ok(page.text.length <= 6000);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 50 * 1024);
    reconstructed += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(reconstructed, text);
  assert.equal(queryHistory(entries, { action: "read", entryId: "long", offset: text.length + 1 }).text, "");
});

test("serializes only transcript content, omitting system/state/binary/signatures/thinking", () => {
  const entries = [
    message("sys", "PRIVATE_SYSTEM", "system"),
    { type: "custom", id: "state", timestamp, data: "PRIVATE_STATE" },
    message("blocks", [
      { type: "text", text: "visible", textSignature: "PRIVATE_SIGNATURE" },
      { type: "thinking", thinking: "PRIVATE_THINKING", thinkingSignature: "PRIVATE_SIGNATURE" },
      { type: "image", data: "PRIVATE_BINARY", mimeType: "image/png" },
      { type: "toolCall", id: "call", name: "bash", arguments: { command: "pwd" } },
    ], "assistant"),
    { type: "custom_message", id: "extension", timestamp, customType: "notice", content: "visible custom", details: "PRIVATE_DETAILS" },
    { type: "branch_summary", id: "branch-summary", timestamp, fromId: "elsewhere", summary: "visible branch summary" },
    { ...message("bash", "", "bashExecution"), message: { role: "bashExecution", command: "pwd", output: "/tmp" } },
  ];
  const result = queryHistory(entries, { action: "messages" });
  assert.deepEqual(result.messages.map((m) => m.id), ["blocks", "extension", "branch-summary", "bash"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  const read = queryHistory(entries, { action: "read", entryId: "blocks" });
  assert.match(read.text, /tool call: bash/);
  assert.match(read.text, /"command":"pwd"/);
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE_/);
  assert.throws(() => queryHistory(entries, { action: "read", entryId: "sys" }), /not found/);
});

test("works before compaction and exposes originals rather than context_edit replacements", () => {
  const entries = [message("a", "original"), { type: "context_edit", id: "edit", timestamp, targetId: "a", replacement: null }];
  assert.equal(queryHistory(entries, { action: "compactions" }).total, 0);
  assert.equal(queryHistory(entries, { action: "read", entryId: "a" }).text, "original");
});

test("rejects other-branch IDs, corrupt boundaries, invalid actions and unbounded inputs", () => {
  for (const params of [
    { action: "read", entryId: "other-branch" },
    { action: "messages", compactionId: "other-branch" },
    { action: "read" }, { action: "unknown" },
    { action: "messages", limit: 21 }, { action: "read", entryId: "a", limit: 6001 },
    { action: "messages", offset: -1 }, { action: "messages", offset: 0.5 },
    { action: "messages", offset: Infinity }, { action: "messages", limit: 0 },
    { action: "messages", query: " " }, { action: "messages", query: "x".repeat(201) },
  ]) assert.throws(() => queryHistory(branch, params));
  assert.throws(() => queryHistory([...branch, compact("broken", "missing")], { action: "messages", compactionId: "broken" }), /Invalid compaction boundary/);
  assert.deepEqual(queryHistory([], { action: "messages" }).messages, []);
});
