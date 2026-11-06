import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

assert.ok(process.env.PI_PACKAGE_DIR, "Set PI_PACKAGE_DIR to the installed Pi package directory.");
const host = resolve(process.env.PI_PACKAGE_DIR);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = await import(pathToFileURL(join(host, "dist/index.js")));
const { loadExtensions } = await import(pathToFileURL(join(host, "dist/core/extensions/loader.js")));
const { ExtensionRunner } = await import(pathToFileURL(join(host, "dist/core/extensions/runner.js")));
const { createBashToolDefinition } = await import(pathToFileURL(join(host, "dist/core/tools/bash.js")));
const loaded = await loadExtensions([join(root, "index.ts")], root);
assert.deepEqual(loaded.errors, []);
assert.deepEqual(loaded.warnings ?? [], []);
assert.equal(loaded.extensions.length, 1);
const user = (content) => ({ role: "user", content, timestamp: Date.now() });
const assistant = (text) => ({
  role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(),
  api: "openai-completions", provider: "test", model: "test", stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-recall-integration 'quoted'-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, sm: sdk.SessionManager.create(dir, dir) };
}
async function bash(sm, command, runner, signal) {
  runner ??= new ExtensionRunner(loaded.extensions, loaded.runtime, root, sm, {});
  const event = { type: "tool_call", toolName: "bash", toolCallId: "integration", input: { command, timeout: 10 } };
  assert.equal(await runner.emitToolCall(event), undefined);
  return createBashToolDefinition(root).execute("integration", event.input, signal, undefined, { sessionManager: sm, cwd: root });
}
async function call(sm, args) {
  const result = await bash(sm, [process.execPath, join(root, "recall.mjs"), ...args].map(quote).join(" "));
  const output = result.content.map((e) => e.text ?? "").join("\n");
  assert.ok(!result.isError, output);
  return JSON.parse(output);
}
async function errorCall(sm, args) {
  const result = await bash(sm, [process.execPath, join(root, "recall.mjs"), ...args].map(quote).join(" "));
  assert.equal(result.isError, true);
  return JSON.parse(result.content[0].text.split("\n")[0]).error;
}

test("real Pi loader registers no tools and discovers bundled Skill through the package manifest", async (t) => {
  const { dir } = fixture(t);
  assert.equal(loaded.extensions[0].tools.size, 0);
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: sdk.SettingsManager.inMemory({}),
    noExtensions: true, additionalExtensionPaths: [root], noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.equal(loader.getExtensions().extensions[0].tools.size, 0);
  assert.deepEqual(loader.getSkills().diagnostics, []);
  assert.deepEqual(loader.getSkills().skills.map((s) => s.name), ["context-recall"]);
  const skill = loader.getSkills().skills[0];
  assert.equal(resolve(dirname(skill.filePath), "../../recall.mjs"), join(root, "recall.mjs"));
});

test("real hook → local bash → CLI: repeated compaction and retain-none preserve original text", async (t) => {
  const { sm } = fixture(t);
  const old = sm.appendMessage(user("original PostgreSQL decision"));
  const kept = sm.appendMessage(assistant("kept tail"));
  const first = sm.appendCompaction("first checkpoint", kept, 9000);
  assert.ok(!sm.buildContextEntries().some((e) => e.id === old));
  assert.equal((await call(sm, ["read", "--entry-id", old])).text, "original PostgreSQL decision");
  const second = sm.appendCompaction("second checkpoint", null, 10000);
  const archive = await call(sm, ["search", "--compaction-id", second]);
  assert.deepEqual(archive.messages.map((m) => m.id), [old, kept, first]);
  assert.equal((await call(sm, ["compactions"])).total, 2);
});

test("/tree changes use live leaf, not last JSONL entry; provenance and /new do not leak", async (t) => {
  const { sm, dir } = fixture(t);
  const shared = sm.appendMessage(user("shared"));
  const privateId = sm.appendMessage(assistant("abandoned sibling"));
  const cp = sm.appendCompaction("sibling checkpoint", null, 10000);
  sm.branch(shared);
  sm.appendMessage(user("new branch"));
  const branchSummary = sm.branchWithSummary(shared, "summary of sibling");
  assert.equal(sm.getEntry(branchSummary).fromId, sm.getEntries().find((e) => e.type === "message" && e.message.content === "new branch").id);
  assert.match(await errorCall(sm, ["read", "--entry-id", privateId]), /not found/);
  assert.match(await errorCall(sm, ["search", "--compaction-id", cp]), /not found/);
  assert.equal((await call(sm, ["compactions"])).total, 0);
  sm.branch(cp);
  assert.equal((await call(sm, ["read", "--entry-id", privateId])).text, "abandoned sibling");
  sm.branch(shared);
  assert.deepEqual((await call(sm, ["search"])).messages.map((m) => m.id), [shared]);
  sm.resetLeaf();
  assert.deepEqual((await call(sm, ["search"])).messages, []);
  const fresh = sdk.SessionManager.create(dir, dir);
  fresh.appendMessage(user("other session"));
  assert.match(await errorCall(fresh, ["read", "--entry-id", shared]), /not found/);
  assert.match(await errorCall(sdk.SessionManager.inMemory(dir), ["search"]), /Missing current-session context/);
});

test("growing session pagination terminates at initial snapshot and rejects removed snapshot", async (t) => {
  const { sm } = fixture(t);
  const ids = [sm.appendMessage(user("first")), sm.appendMessage(assistant("second")), sm.appendMessage(user("third"))];
  let page = await call(sm, ["search", "--limit", "1"]);
  const seen = page.messages.map((m) => m.id);
  for (let turn = 0; page.nextOffset !== null && turn < 10; turn++) {
    sm.appendMessage(user("recall query and result added after first page"));
    page = await call(sm, ["search", "--offset", String(page.nextOffset), "--until-id", page.untilId, "--limit", "1"]);
    seen.push(...page.messages.map((m) => m.id));
  }
  assert.equal(page.nextOffset, null);
  assert.deepEqual(seen, ids);
  sm.branch(ids[0]);
  assert.match(await errorCall(sm, ["search", "--until-id", ids[2]]), /untilId not found/);
});

test("context_edit affects projection, not persisted originals; query leaves source JSONL unchanged", async (t) => {
  const { sm } = fixture(t);
  const id = sm.appendMessage(user("original saved content"));
  sm.appendContextEdit(id, { content: "replacement" });
  assert.ok(sm.buildSessionContext().messages.some((m) => m.content === "replacement"));
  const before = readFileSync(sm.getSessionFile(), "utf8");
  assert.equal((await call(sm, ["read", "--entry-id", id])).text, "original saved content");
  assert.equal(readFileSync(sm.getSessionFile(), "utf8"), before);
  sm.appendContextEdit(id, null);
  assert.equal(sm.buildSessionContext().messages.length, 0);
  assert.equal((await call(sm, ["read", "--entry-id", id])).text, "original saved content");
});

test("reopen and /fork follow current file, preserve originals and remap label cutoffs", async (t) => {
  const { sm, dir } = fixture(t);
  const original = sm.appendMessage(user("durable original"));
  sm.appendMessage(assistant("reply before cutoff"));
  const label = sm.appendLabelChange(original, "bookmark");
  const retained = sm.appendMessage(user("retained after label"));
  const cp = sm.appendCompaction("saved checkpoint", label, 10000);
  const source = sm.getSessionFile();
  const before = readFileSync(source, "utf8");
  const reopened = sdk.SessionManager.open(source, dir);
  assert.equal((await call(reopened, ["read", "--entry-id", original])).text, "durable original");
  assert.notEqual(reopened.createBranchedSession(cp), source);
  assert.equal(reopened.getEntry(cp).firstKeptEntryId, retained);
  assert.equal((await call(reopened, ["read", "--entry-id", original])).text, "durable original");
  const archived = await call(reopened, ["search", "--compaction-id", cp]);
  assert.ok(archived.messages.some((e) => e.id === original));
  assert.ok(!archived.messages.some((e) => e.id === retained));
  assert.equal(readFileSync(source, "utf8"), before);
});

test("bridge shell-quotes context, keeps existing command exit semantics and ignores other tools", async (t) => {
  const { sm } = fixture(t);
  sm.appendMessage(user("file path contains spaces and quotes"));
  const snapshot = { file: process.env.PI_CONTEXT_RECALL_SESSION, leaf: process.env.PI_CONTEXT_RECALL_LEAF };
  const result = await bash(sm, "node -e 'console.log(JSON.stringify([process.env.PI_CONTEXT_RECALL_SESSION,process.env.PI_CONTEXT_RECALL_LEAF]))'");
  assert.deepEqual(JSON.parse(result.content[0].text), [sm.getSessionFile(), sm.getLeafId()]);
  assert.deepEqual({ file: process.env.PI_CONTEXT_RECALL_SESSION, leaf: process.env.PI_CONTEXT_RECALL_LEAF }, snapshot);
  assert.equal((await bash(sm, "exit 7")).isError, true);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, sm, {});
  const input = { path: "untouched" };
  await runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "read", input });
  assert.deepEqual(input, { path: "untouched" });
});

test("same loaded runner tracks /tree and /fork without cached file or leaf", async (t) => {
  const { sm } = fixture(t);
  const shared = sm.appendMessage(user("shared"));
  const left = sm.appendMessage(assistant("left"));
  sm.branch(shared);
  const right = sm.appendMessage(assistant("right"));
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, sm, {});
  const command = "node -e 'console.log(JSON.stringify([process.env.PI_CONTEXT_RECALL_SESSION,process.env.PI_CONTEXT_RECALL_LEAF]))'";
  const check = async (file, leaf) => {
    const result = await bash(sm, command, runner);
    assert.ok(!result.isError);
    assert.deepEqual(JSON.parse(result.content[0].text), [file, leaf]);
  };
  await check(sm.getSessionFile(), right);
  sm.branch(left);
  await check(sm.getSessionFile(), left);
  sm.createBranchedSession(left);
  await check(sm.getSessionFile(), left);
  sm.resetLeaf();
  await check(sm.getSessionFile(), "");
});

test("concurrent prepared calls keep separate branch snapshots and do not mutate parent environment", async (t) => {
  const { sm, dir } = fixture(t);
  const shared = sm.appendMessage(user("shared"));
  const left = sm.appendMessage(assistant("left"));
  sm.branch(shared);
  const right = sm.appendMessage(assistant("right"));
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, sm, {});
  const envBefore = [process.env.PI_CONTEXT_RECALL_SESSION, process.env.PI_CONTEXT_RECALL_LEAF];
  const inputs = [];
  for (const leaf of [left, right]) {
    sm.branch(leaf);
    const input = { command: [process.execPath, join(root, "recall.mjs"), "search"].map(quote).join(" "), timeout: 10 };
    await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: leaf, input });
    inputs.push(input);
  }
  const other = sdk.SessionManager.create(dir, dir);
  const otherId = other.appendMessage(user("other session"));
  const results = await Promise.all([
    ...inputs.map((input) => createBashToolDefinition(root).execute("parallel", input, undefined, undefined, { sessionManager: sm, cwd: root })),
    call(other, ["search"]),
  ]);
  assert.deepEqual(JSON.parse(results[0].content[0].text).messages.map((e) => e.id), [shared, left]);
  assert.deepEqual(JSON.parse(results[1].content[0].text).messages.map((e) => e.id), [shared, right]);
  assert.deepEqual(results[2].messages.map((e) => e.id), [otherId]);
  assert.deepEqual([process.env.PI_CONTEXT_RECALL_SESSION, process.env.PI_CONTEXT_RECALL_LEAF], envBefore);
});

test("reload keeps one hook and no tools; unusual shell characters are values, never executable syntax", async (t) => {
  const { sm } = fixture(t);
  sm.appendMessage(user("saved"));
  const again = await loadExtensions([join(root, "index.ts")], root);
  assert.deepEqual(again.errors, []);
  assert.equal(again.extensions[0].tools.size, 0);
  const file = "/tmp/space 'quoted' \\ $(printf SHOULD_NOT_EXECUTE);\nnext.jsonl";
  const leaf = "'; printf SHOULD_NOT_EXECUTE; #";
  const manager = { getSessionFile: () => file, getLeafId: () => leaf, getSessionId: () => "shell-quoting-test" };
  const runner = new ExtensionRunner(again.extensions, again.runtime, root, manager, {});
  const result = await bash(manager, "node -e 'console.log(JSON.stringify([process.env.PI_CONTEXT_RECALL_SESSION,process.env.PI_CONTEXT_RECALL_LEAF]))'", runner);
  assert.deepEqual(JSON.parse(result.content[0].text), [file, leaf]);
  const handlers = again.extensions[0].handlers.get("tool_call");
  assert.equal(handlers.length, 1);
});

test("aborted bash remains aborted through the bridge", async (t) => {
  const { sm } = fixture(t);
  sm.appendMessage(user("saved"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(bash(sm, "node -e 'setTimeout(()=>{},30000)'", undefined, controller.signal), /abort/i);
});

test("legacy v2 JSONL fails explicitly until Pi migrates it on open", async (t) => {
  const { sm, dir } = fixture(t);
  const id = sm.appendMessage(user("legacy original"));
  const file = sm.getSessionFile();
  const records = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  records[0].version = 2;
  writeFileSync(file, records.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.match(await errorCall(sm, ["read", "--entry-id", id]), /v3/);
  const migrated = sdk.SessionManager.open(file, dir);
  assert.equal(JSON.parse(readFileSync(file, "utf8").split("\n")[0]).version, 3);
  assert.equal((await call(migrated, ["read", "--entry-id", id])).text, "legacy original");
});

test("real Pi bridge overview folds tools and follows fork/tree scope without exposing siblings", async (t) => {
  const { sm } = fixture(t);
  const question = sm.appendMessage(user("Overview question"));
  const inspecting = sm.appendMessage({ ...assistant("Inspecting"), content: [
    { type: "text", text: "Inspecting" },
    { type: "toolCall", id: "call", name: "bash", arguments: { command: "HIDDEN_COMMAND" } },
  ] });
  const failure = sm.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "bash", timestamp: Date.now(),
    isError: true, content: [{ type: "text", text: "HIDDEN_RESULT exact failure" }] });
  const shared = sm.appendMessage(assistant("Done"));
  sm.appendMessage(user("SIBLING_PRIVATE"));
  sm.appendMessage(assistant("Sibling answer"));
  sm.branch(shared);
  sm.appendMessage(user("Current branch"));
  sm.createBranchedSession(sm.getLeafId());
  const page = await call(sm, ["overview"]);
  assert.equal(page.messages[0].id, question);
  assert.equal(page.messages[1].id, inspecting);
  assert.equal(page.messages[1].tools.firstErrorEntryId, failure);
  assert.equal(page.messages[1].tools.errors, 1);
  assert.doesNotMatch(JSON.stringify(page), /HIDDEN_|SIBLING_PRIVATE/);
  assert.match((await call(sm, ["read", "--entry-id", failure])).text, /exact failure/);
  sm.branch(question);
  const beforeTools = await call(sm, ["overview"]);
  assert.deepEqual(beforeTools.messages.map((m) => m.id), [question]);
  assert.match(await errorCall(sm, ["overview", "--until-id", shared]), /untilId not found/);
});



