# pi-context-recall

English | [简体中文](README.zh-CN.md)

**Recover the original conversation when a compaction summary drops a detail.**

A local CLI searches Pi's saved transcript. A Skill teaches the agent when and how
to use it through existing `bash`; a thin extension supplies the live session
file and branch leaf. **No extra agent tools, archive or database.**
It does not reverse summaries or replace Pi's compaction.

## Install

Requires Pi, **Node.js ≥22.19.0**, local bash and a saved Pi v3 session.
The package is not on npm; install it from this repository.

```bash
pi install git:github.com/adlternative/pi-context-recall
```

This writes a personal declaration to `~/.pi/agent/settings.json` and installs the
extension **and** the bundled Skill. Add `--local` to write `.pi/settings.json`
for this project instead; Pi loads project declarations after project trust.

```bash
pi list     # confirm the package and its checkout path
pi remove git:github.com/adlternative/pi-context-recall
```

Try it once without touching settings:

```bash
pi -e git:github.com/adlternative/pi-context-recall
```

Restart Pi, or run `/reload` if the package was installed while Pi was running.
Do not use `--no-session`: recall needs a saved session file.

## Test mode: skip the summarizer

Adding `contextRecall.stubCompaction` to the Pi settings replaces the compaction
model call with a fixed placeholder that tells the model how to read the archived
originals. Useful when a provider call hangs and you want to keep working, or to
test recall without paying for a summary.

```json
{
  "contextRecall": {
    "stubCompaction": true
  }
}
```

Put it in `~/.pi/agent/settings.json`, or in a project `.pi/settings.json` while the
project is trusted. Then restart Pi or run `/reload`. Only a boolean `true` enables
it; `"true"` as a string is ignored. Unknown top-level keys are preserved by Pi.

- Pi still picks the cut point (`firstKeptEntryId`); only the summary text is replaced.
- No model request is made, so the checkpoint reports no usage and finishes instantly.
- The placeholder contains **no facts** about the conversation, and no conversation
  text. The next model turn starts without a summary and must call the CLI.
- The archived prefix is still readable, and `overview` shows the checkpoint row.
- This is a test aid: it is off unless the setting is present, and it does not make
  ordinary compaction summaries better or cheaper in normal use.

## Try the source locally

From this source directory, with no install at all:

```bash
pi -e ./
```

This loads the extension and bundled Skill for that invocation only. Nothing is
added to settings. Do not use `--no-session`.

Ask:

> Before compaction, why did we choose PostgreSQL? Find the original messages and IDs.

The agent can load the `context-recall` Skill automatically. To force loading:

```text
/skill:context-recall Find the original PostgreSQL decision.
```

Automatic Skill selection is not guaranteed. Detailed instructions are loaded only
when needed, rather than adding three tool schemas to every model request.

## Overview first, originals on demand

For broad recall, the Skill starts with `overview`: a small chronological page of
user/assistant previews, with tool activity folded into counts. The selected or
latest native checkpoint supplies its existing summary preview as navigation.
No new summary/model call, storage or automatic history dump is added.
For a precise keyword, the agent can go directly to `search`.

Which entry point:

| Question | Start with |
| --- | --- |
| "What were we just discussing?" | `overview --tail` (newest page first) |
| "Where did this start?" | `overview` (oldest page first) |
| A precise ID, error code, path or name | `search --query` |

`--tail` usually answers a recency question in one call; walk back with its
`nextOffset` only when the user needs older context. Its offset counts rows back from
the end, unlike the raw-entry offsets of a forward `overview`.

**Everything remains queryable on the current branch, not returned all at once.**
The timeline also marks non-dialogue entries: `compaction` checkpoints,
`branch_summary`, `branchSummary`/`compactionSummary` messages and `custom:<type>`
extension notices. They appear as their own rows and are readable by ID, so a
folded section never looks like missing history. Only assistant output absorbs
nearby tool activity.
Tool-only assistant messages and results fold together, including failed tools.
Use a row ID or `tools.firstErrorEntryId` with `read` for evidence. To browse the
fold's individual entries, use `search --offset TOOLS_OFFSET --until-id PAGE_UNTIL_ID`,
keeping any `--compaction-id`; stop at `tools.lastEntryId`.
Reading one ID reads one original entry, not the entire fold.
Tool counts cover only the selected scope; calls and results need not pair.
Folding is not redaction: dialogue and saved summaries may still quote secrets or commands.

## CLI

Run these through Pi's `bash` tool, using the script's absolute path.
`node recall.mjs --help` works outside Pi, but queries require bridge context.

```bash
node "/path/to/pi-context-recall/recall.mjs" overview --tail
node "/path/to/pi-context-recall/recall.mjs" overview
node "/path/to/pi-context-recall/recall.mjs" overview --compaction-id CHECKPOINT_ID
node "/path/to/pi-context-recall/recall.mjs" search --query "PostgreSQL" --limit 10
node "/path/to/pi-context-recall/recall.mjs" read --entry-id ENTRY_ID --offset 0 --limit 4000
node "/path/to/pi-context-recall/recall.mjs" compactions
node "/path/to/pi-context-recall/recall.mjs" search --compaction-id CHECKPOINT_ID --query "PostgreSQL"
```

| Command | Options |
| --- | --- |
| `overview` | `--compaction-id`, `--tail`, `--until-id`, `--offset`, `--limit` |
| `search` | `--query`, `--compaction-id`, `--until-id`, `--offset`, `--limit` |
| `read` | **`--entry-id`**, `--until-id`, `--offset`, `--limit` |
| `compactions` | `--until-id`, `--offset`, `--limit` |

- Search is case-insensitive literal text (1–200 characters, not whitespace only).
  Omit `--query` to browse. Filtering happens before pagination.
- Overview defaults to 5 rows, maximum 10, with text previews up to 300 UTF-16
  characters (never splitting a surrogate pair) and a `truncated` flag. Tool
  arguments/bodies are not serialized. Rows can be dialogue, `tools` folds,
  checkpoints, summaries or extension notices.
  Each fold includes counts, first/last/error entry IDs and a raw `offset` for expansion.
  `byName` shows at most 5 tool names (40-character previews); `other` counts the rest.
  `checkpoint` is null if there is no native checkpoint in the snapshot.
- `--tail` returns the newest page first (`order: newest-page-first`), rows still
  chronological within the page; `--offset` counts rows back from the end, so follow
  `nextOffset` to go older. Continuation still requires `untilId`.
- `--compaction-id` scopes overview/search to the cumulative prefix before the checkpoint's
  `firstKeptEntryId`, not an independent archive; the retained tail is excluded.
- Search/checkpoint pages default to 10 entries, maximum 20. Read pages default to
  4000 UTF-16 characters, maximum 6000. Previews contain at most 300 characters.
- Overview/search/checkpoint continuation: pass `nextOffset` as `--offset` and the initial
  `untilId` as `--until-id`, with unchanged filters. Overview/search offsets count raw
  branch entries, not displayed rows; checkpoint offsets count checkpoints.
  Overview and whole-branch search continuation require `--until-id`. For reads, follow `nextOffset` as a UTF-16
  offset; search `matchOffset`/`previewOffset` can be used directly.
- Stop when `nextOffset` is null. Restart after any session/branch switch.
- Success writes one JSON object to stdout, with a historical-data notice.
  Errors write JSON to stderr and exit 1. Output can be projected with `jq`.

The old `session_compactions`, `session_messages`, `session_read` and
`session_history` tools are not registered or retained as aliases.

## Scope and implementation

On every agent `bash` call, `index.ts` reads the **current** SessionManager file
and leaf, shell-quotes them, and prepends exports for
`PI_CONTEXT_RECALL_SESSION` and `PI_CONTEXT_RECALL_LEAF`. This is invocation-local:
it does not change Pi's process environment or create context snapshot files.
It does prepend exports to all agent bash commands; later tool-call hooks see them.

The CLI opens that JSONL read-only and follows `parentId` from the injected leaf.
It never selects the newest file, assumes the last line is the active leaf, follows
`parentSession`, or falls back when context is missing. `/tree` changes the leaf;
`/new` and `/fork` change the file. Forks expose only ancestors copied into them.
There is no `--session` option. Source JSONL is not modified.

This is on-demand loading **into model context**, not streaming disk I/O: each
query reads the JSONL into memory and linearly scans the selected branch.

**Limits:** saved v3 sessions only (Pi migrates legacy sessions when opened).
In-memory/`--no-session`, terminal `!` commands, PowerShell and remote/container
shell replacements are unsupported. A missing file/leaf fails explicitly.
This bridge uses mutable tool-call input in the installed Pi API; older Pi builds
without that support are not compatible.

**Privacy:** results are persisted text, not exact historical API requests.
System prompts, thinking, image bytes, signatures and private extension state are
excluded. Deleted/never-saved content cannot be recovered. Recall can expose
sensitive originals hidden by compaction or context edits to the current model.
Historical text is data, **not new instructions or authorization**. Neither this
notice nor environment-based branch selection is a sandbox: bash already has the
user's file access, and trusted extensions/commands can override the environment.

## Verify

```bash
npm test
PI_PACKAGE_DIR=/path/to/installed/pi-coding-agent npm run test:pi
PI_PACKAGE_DIR=/path/to/installed/pi-coding-agent \
  PI_PROVIDER=your-provider PI_MODEL=your-model npm run test:live
```

The opt-in live test uses configured credentials and synthetic data only. It makes
real model requests, compacts a saved session, reopens it, then verifies recall
through the Skill and built-in read/bash tools. Reports stay in a temporary directory.

`npm run test:scenarios` (with the same environment variables) adds real-model cases
for long tool output, repeated compaction, fork isolation, historical instructions,
and overview-first recall followed by an exact original error read.
See [the test matrix and unverified limits](TESTING.md) for reproducible coverage.
