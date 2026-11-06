import assert from "node:assert/strict";
import test from "node:test";
import { queryHistory } from "../history.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
let seed = 0x5eed1234;
const random = (max) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
const words = ["中文😀", "Needle", "[literal].", "line\nbreak", "e\u0301", "İ", "\u0001"];
const message = (id, text, role = "user") => ({
  type: "message", id, parentId: null, timestamp, message: { role, content: text, timestamp: 0 },
});

test("seeded 200-case property check: filtered paging neither loses nor duplicates entries", () => {
  for (let trial = 0; trial < 200; trial++) {
    const branch = Array.from({ length: 1 + random(120) }, (_, index) => {
      const id = `${trial}-${index}`;
      return random(5) === 0 ? { type: "custom", id, parentId: null, timestamp, data: "private" }
        : message(id, words[random(words.length)] + " " + words[random(words.length)], random(2) ? "user" : "assistant");
    });
    const query = words[random(3)];
    const expected = branch.filter((e) => e.type === "message" && e.message.content.toLowerCase().includes(query.toLowerCase()));
    const limit = 1 + random(20);
    const seen = [];
    let offset = 0, untilId;
    for (let step = 0; step <= branch.length; step++) {
      const page = queryHistory(branch, { action: "messages", query, offset, untilId, limit });
      assert.ok(page.messages.length <= limit);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 50 * 1024);
      seen.push(...page.messages.map((m) => m.id));
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset, `seeded trial ${trial}: cursor must advance`);
      offset = page.nextOffset;
      untilId = page.untilId;
      assert.ok(step < branch.length, "paging must terminate");
    }
    assert.deepEqual(seen, expected.map((e) => e.id), `trial ${trial}`);
    assert.equal(new Set(seen).size, seen.length);
  }
});

test("seeded 100-case UTF-16 read reconstruction including surrogate splits and control bytes", () => {
  for (let trial = 0; trial < 100; trial++) {
    const text = Array.from({ length: 30 + random(300) }, () => words[random(words.length)]).join("");
    const branch = [message("text", text)];
    let offset = 0, reconstructed = "";
    const limit = 1 + random(25);
    do {
      const page = queryHistory(branch, { action: "read", entryId: "text", offset, limit });
      reconstructed += JSON.parse(JSON.stringify(page)).text;
      assert.ok(page.text.length <= limit);
      if (page.nextOffset !== null) assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(reconstructed, text, `trial ${trial}`);
  }
});

test("200 cumulative compactions: retained metadata boundaries and retain-none do not overlap tail", () => {
  const branch = [message("original", "oldest original")];
  for (let index = 0; index < 200; index++) {
    const kept = message(`tail${index}`, `retained ${index}`);
    const metadata = { type: "label", id: `label${index}`, parentId: null, timestamp, targetId: kept.id, label: "cutoff" };
    branch.push(metadata, kept);
    const cp = { type: "compaction", id: `cp${index}`, parentId: null, timestamp,
      firstKeptEntryId: index % 2 ? `cp${index}` : metadata.id, summary: "summary", tokensBefore: 10000 };
    branch.push(cp);
    const result = queryHistory(branch, { action: "messages", compactionId: cp.id, query: "oldest" });
    assert.deepEqual(result.messages.map((m) => m.id), ["original"]);
    assert.throws(() => queryHistory(branch, { action: "messages", compactionId: cp.id, untilId: kept.id }), /not found/);
  }
  const all = [];
  let offset = 0;
  do {
    const page = queryHistory(branch, { action: "compactions", offset, limit: 7 });
    all.push(...page.compactions.map((e) => e.id));
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(all.length, 200);
  assert.equal(new Set(all).size, 200);
});

test("large branch stays iterative, read-only and bounded; missing matches and extreme offsets terminate", () => {
  const branch = Array.from({ length: 50000 }, (_, i) => message(String(i), i === 49999 ? "last needle" : "filler"));
  const original = JSON.stringify(branch[0]);
  assert.equal(queryHistory(branch, { action: "messages", query: "needle" }).messages[0].id, "49999");
  assert.deepEqual(queryHistory(branch, { action: "messages", query: "absent" }).messages, []);
  assert.equal(queryHistory(branch, { action: "messages", untilId: "49999", offset: Number.MAX_SAFE_INTEGER }).nextOffset, null);
  assert.equal(queryHistory(branch, { action: "read", entryId: "49999", offset: Number.MAX_SAFE_INTEGER }).text, "");
  assert.equal(JSON.stringify(branch[0]), original);
});
