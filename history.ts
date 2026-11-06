import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface HistoryParams {
  action: "overview" | "compactions" | "messages" | "read";
  compactionId?: string;
  entryId?: string;
  untilId?: string;
  query?: string;
  offset?: number;
  tail?: boolean;
  limit?: number;
}

function pageNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`Expected an integer between ${min} and ${max}.`);
  }
  return n;
}

// Never serialize entire entries: they contain binary data, signatures and private extension state.
function contentText(content: string | readonly {
  type: string; text?: string; name?: string; arguments?: unknown; mimeType?: string;
}[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => {
    switch (block.type) {
      case "text": return block.text ?? "";
      case "toolCall": return `[tool call: ${block.name}] ${JSON.stringify(block.arguments)}`;
      case "image": return `[image: ${block.mimeType ?? "unknown"}; binary omitted]`;
      case "thinking": return "[thinking omitted]";
      default: return `[${block.type} omitted]`;
    }
  }).join("\n");
}

function transcript(entry: SessionEntry): { role: string; text: string } | undefined {
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return { role: entry.type, text: entry.summary };
  }
  if (entry.type === "custom_message") {
    return { role: `custom:${entry.customType}`, text: contentText(entry.content) };
  }
  if (entry.type !== "message") return undefined;
  const m = entry.message;
  switch (m.role) {
    case "user": case "assistant": case "custom":
      return { role: m.role, text: contentText(m.content) };
    case "toolResult":
      return { role: `toolResult:${m.toolName}`, text: contentText(m.content) };
    case "bashExecution":
      return { role: m.role, text: `$ ${m.command}\n${m.output}` };
    case "branchSummary": case "compactionSummary":
      return { role: m.role, text: m.summary };
    default: return undefined;
  }
}

function archivedPrefix(branch: readonly SessionEntry[], compactionId: string): readonly SessionEntry[] {
  const index = branch.findIndex((e) => e.id === compactionId && e.type === "compaction");
  if (index < 0) throw new Error("Compaction not found on the current branch.");
  const compaction = branch[index];
  if (compaction.type !== "compaction") throw new Error("Expected compaction.");
  if (compaction.firstKeptEntryId === compaction.id) return branch.slice(0, index);
  const keptIndex = branch.findIndex((e) => e.id === compaction.firstKeptEntryId);
  if (keptIndex < 0 || keptIndex >= index) {
    throw new Error("Invalid compaction boundary: firstKeptEntryId is not an ancestor.");
  }
  return branch.slice(0, keptIndex);
}

function checkpointInfo(entry: Extract<SessionEntry, { type: "compaction" }>) {
  return {
    id: entry.id, timestamp: entry.timestamp, firstKeptEntryId: entry.firstKeptEntryId,
    tokensBefore: entry.tokensBefore, summaryPreview: entry.summary.slice(0, 300),
    summaryChars: entry.summary.length,
  };
}

type ToolCounts = { calls: number; results: number; errors: number };
type OverviewRow = {
  id: string; timestamp: string; role: string;
  preview?: string; truncated?: boolean;
  tools?: ToolCounts & {
    firstEntryId: string; lastEntryId: string; offset: number; firstErrorEntryId: string | null;
    byName: (ToolCounts & { name: string })[]; other: ToolCounts;
  };
};

// Never split a surrogate pair in a preview; a lone half renders as a broken glyph.
function clip(text: string, length: number): string {
  const cut = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function overview(entries: readonly SessionEntry[], offset: number, limit: number, tail = false) {
  const messages: OverviewRow[] = [];
  const cap = tail ? Infinity : limit;
  let cursor = tail ? 0 : Math.min(offset, entries.length);
  for (; cursor < entries.length; cursor++) {
    const entry = entries[cursor];
    // Checkpoints and summaries are part of the timeline, not invisible gaps.
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (messages.length === cap) break;
      messages.push({ id: entry.id, timestamp: entry.timestamp, role: entry.type,
        preview: clip(entry.summary, 300), truncated: entry.summary.length > 300 });
      continue;
    }
    if (entry.type === "custom_message") {
      const text = contentText(entry.content);
      if (messages.length === cap) break;
      messages.push({ id: entry.id, timestamp: entry.timestamp, role: `custom:${entry.customType}`,
        preview: clip(text, 300), truncated: text.length > 300 });
      continue;
    }
    if (entry.type !== "message") continue;
    const m = entry.message;
    const events: (ToolCounts & { name: string })[] = [];
    if (m.role === "user" || m.role === "assistant" || m.role === "custom") {
      const text = typeof m.content === "string" ? m.content
        : contentText(m.content.filter((block) => block.type === "text" || block.type === "image"));
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === "toolCall") events.push({ name: String(block.name ?? "unknown"), calls: 1, results: 0, errors: 0 });
        }
      }
      if (text || m.role === "user") {
        if (messages.length === cap) break;
        messages.push({ id: entry.id, timestamp: entry.timestamp, role: m.role,
          preview: clip(text, 300), truncated: text.length > 300 });
      }
    } else if (m.role === "branchSummary" || m.role === "compactionSummary") {
      if (messages.length === cap) break;
      messages.push({ id: entry.id, timestamp: entry.timestamp, role: m.role,
        preview: clip(m.summary, 300), truncated: m.summary.length > 300 });
    } else if (m.role === "toolResult") {
      // Old or foreign sessions may omit toolName; fold under a label instead of crashing.
      events.push({ name: String(m.toolName ?? "unknown"), calls: 0, results: 1, errors: Number(m.isError === true) });
    } else if (m.role === "bashExecution") {
      events.push({ name: "bash", calls: 1, results: 1,
        errors: Number(m.cancelled || (m.exitCode !== undefined && m.exitCode !== 0)) });
    }
    if (!events.length) continue;
    let row = messages.at(-1);
    // Only assistant output absorbs tool activity; summaries and user turns stay separate.
    if (!row || (row.role !== "assistant" && row.role !== "tools")) {
      if (messages.length === cap) break;
      row = { id: entry.id, timestamp: entry.timestamp, role: "tools" };
      messages.push(row);
    }
    const tools = row.tools ??= {
      calls: 0, results: 0, errors: 0, firstEntryId: entry.id, lastEntryId: entry.id,
      offset: cursor, firstErrorEntryId: null, byName: [], other: { calls: 0, results: 0, errors: 0 },
    };
    tools.lastEntryId = entry.id;
    for (const event of events) {
      let counts: ToolCounts | undefined = tools.byName.find((item) => item.name === event.name);
      if (!counts && tools.byName.length < 5) {
        const named = { name: event.name, calls: 0, results: 0, errors: 0 };
        tools.byName.push(named);
        counts = named;
      }
      counts ??= tools.other;
      for (const key of ["calls", "results", "errors"] as const) {
        tools[key] += event[key];
        counts[key] += event[key];
      }
      if (event.errors && !tools.firstErrorEntryId) tools.firstErrorEntryId = entry.id;
    }
  }
  // Tool names are previews too; full names remain available in original reads.
  for (const row of messages) {
    for (const item of row.tools?.byName ?? []) item.name = clip(item.name, 40);
  }
  return { messages, nextOffset: cursor < entries.length ? cursor : null };
}

// Newest page first: offset counts rows back from the end, not raw entries.
function tailPage(rows: readonly OverviewRow[], offset: number, limit: number) {
  const end = Math.max(0, rows.length - offset);
  const start = Math.max(0, end - limit);
  const messages = rows.slice(start, end);
  return { messages, nextOffset: start > 0 ? offset + messages.length : null };
}

/** Raw persisted transcript, never a reconstruction of provider-hook transformations. */
export function queryHistory(branch: readonly SessionEntry[], params: HistoryParams) {
  const offset = pageNumber(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (params.tail && params.action !== "overview") throw new Error("tail is only supported by overview.");
  if (params.untilId) {
    const end = branch.findIndex((e) => e.id === params.untilId);
    if (end < 0) throw new Error("untilId not found on the current branch; restart pagination.");
    branch = branch.slice(0, end + 1);
  }
  const untilId = branch.at(-1)?.id ?? null;
  if (params.action === "overview") {
    const limit = pageNumber(params.limit, 5, 1, 10);
    if (params.query !== undefined) throw new Error("Use search for literal queries, not overview.");
    if (offset > 0 && !params.untilId) {
      throw new Error("overview continuation requires the untilId returned by the first page.");
    }
    const entries = params.compactionId ? archivedPrefix(branch, params.compactionId) : branch;
    const checkpoint = params.compactionId
      ? branch.find((entry) => entry.id === params.compactionId && entry.type === "compaction")
      : branch.findLast((entry) => entry.type === "compaction");
    // shortcut: --tail scans the whole scope per page; cache row offsets if it gets slow.
    const page = params.tail
      ? tailPage(overview(entries, 0, limit, true).messages, offset, limit)
      : overview(entries, offset, limit);
    return {
      untilId, scope: params.compactionId ? `archived before ${params.compactionId}` : "current branch (raw)",
      order: params.tail ? "newest-page-first" : "oldest-first",
      checkpoint: checkpoint?.type === "compaction" ? checkpointInfo(checkpoint) : null,
      ...page,
    };
  }
  if (params.action === "compactions") {
    const limit = pageNumber(params.limit, 10, 1, 20);
    const entries = branch.filter((e) => e.type === "compaction");
    return {
      untilId, total: entries.length,
      compactions: entries.slice(offset, offset + limit).map(checkpointInfo),      nextOffset: offset + limit < entries.length ? offset + limit : null,
    };
  }

  if (params.action === "messages") {
    const limit = pageNumber(params.limit, 10, 1, 20);
    if (offset > 0 && !params.compactionId && !params.untilId) {
      throw new Error("messages continuation requires the untilId returned by the first page.");
    }
    if (params.query !== undefined && (!params.query.trim() || params.query.length > 200)) {
      throw new Error("query must contain 1–200 characters, not only whitespace.");
    }
    const entries = params.compactionId ? archivedPrefix(branch, params.compactionId) : branch;
    const pattern = params.query === undefined ? undefined
      : new RegExp(params.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
    // shortcut: linear scan; add an index only if large sessions make recall slow.
    const messages = [];
    let cursor = Math.min(offset, entries.length);
    for (; cursor < entries.length && messages.length < limit; cursor++) {
      const e = entries[cursor];
      const record = transcript(e);
      if (!record) continue;
      const matchOffset = pattern ? record.text.search(pattern) : 0;
      if (matchOffset < 0) continue;
      const previewOffset = Math.max(0, matchOffset - 100);
      messages.push({
        id: e.id, timestamp: e.timestamp, role: record.role, chars: record.text.length,
        matchOffset, previewOffset, preview: record.text.slice(previewOffset, previewOffset + 300),
      });
    }
    return {
      untilId,
      scope: params.compactionId ? `archived before ${params.compactionId}` : "current branch (raw)",
      messages, nextOffset: cursor < entries.length ? cursor : null,
    };
  }

  if (params.action === "read") {
    if (!params.entryId) throw new Error("entryId is required for read.");
    const limit = pageNumber(params.limit, 4000, 1, 6000);
    const e = branch.find((e) => e.id === params.entryId);
    const record = e && transcript(e);
    if (!e || !record) throw new Error("Readable entry not found on the current branch.");
    return {
      id: e.id, timestamp: e.timestamp, role: record.role, chars: record.text.length, offset,
      text: record.text.slice(offset, offset + limit),
      nextOffset: offset + limit < record.text.length ? offset + limit : null,
    };
  }
  throw new Error("Unknown history action.");
}
