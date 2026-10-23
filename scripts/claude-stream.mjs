// Orca claude stream usage (2026-09-27), spec docs/superpowers/specs/2026-09-27-claude-stream-usage-design.md in
// the Orca repository: the claude phase runner reads claude's `--output-format stream-json` line by line. This
// module holds the parts that need no process: the usage measure (moved here unchanged from the runner), the line
// splitter, and the observation of usage streamed before a phase ends.
import { closeSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";

const USAGE_FIELDS = ["input_tokens", "inputTokens", "output_tokens", "outputTokens"];
// Orca paid claude round (2026-09-27), human ruling on its findings ("B1–B3 按你推荐"): claude's input_tokens leaves
// out the prompt it wrote to or read from its cache, which in that round was about 145,000 tokens against 1,329
// counted, so the token budget barely bound real claude. Codex's input_tokens already includes its cached input. Both
// cache counts are now whitelisted and added to the total; any other usage property is still never copied.
const CACHE_USAGE_FIELDS = ["cache_creation_input_tokens", "cache_read_input_tokens"];

function inspectUsageField(usage, field) {
  if (!Object.prototype.hasOwnProperty.call(usage, field)) {
    return { status: "absent" };
  }

  const value = usage[field];
  if (typeof value !== "number") {
    return { status: "invalid_type" };
  }

  if (!Number.isFinite(value)) {
    return { status: "non_finite" };
  }

  return { status: "finite", value };
}

export function buildUsageEvidence(envelope) {
  const rawUsage = envelope && typeof envelope === "object" ? envelope.usage : undefined;
  const usageStatus = rawUsage === undefined
    ? "absent"
    : rawUsage !== null && typeof rawUsage === "object" && !Array.isArray(rawUsage)
      ? "present"
      : "invalid";
  const usage = usageStatus === "present" ? rawUsage : {};
  const fields = Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, inspectUsageField(usage, field)]),
  );
  const selectedInputField = fields.input_tokens.status === "finite"
    ? "input_tokens"
    : fields.inputTokens.status === "finite"
      ? "inputTokens"
      : null;
  const selectedOutputField = fields.output_tokens.status === "finite"
    ? "output_tokens"
    : fields.outputTokens.status === "finite"
      ? "outputTokens"
      : null;
  const selectedValues = [selectedInputField, selectedOutputField]
    .filter((field) => field !== null)
    .map((field) => fields[field].value);
  const cacheFields = Object.fromEntries(
    CACHE_USAGE_FIELDS.map((field) => [field, inspectUsageField(usage, field)]),
  );
  const cacheValues = CACHE_USAGE_FIELDS
    .filter((field) => cacheFields[field].status === "finite")
    .map((field) => cacheFields[field].value);
  const total = [...selectedValues, ...cacheValues].reduce((sum, value) => sum + value, 0);
  const normalizedTotal = selectedValues.length > 0 && Number.isFinite(total) && total > 0
    ? total
    : null;

  return {
    usageStatus,
    fields,
    cacheFields,
    selectedInputField,
    selectedOutputField,
    normalizedTotal,
  };
}

export const OBSERVED_USAGE_SCHEMA = "ccloop-claude-observed-usage-v1";

/**
 * Feed text chunks; `onLine` gets each complete line. A line longer than `maxLineBytes` is dropped, not kept.
 * Live transcript (Orca spec 2026-10-23 §10.2.1): `onDropped(bytes)`, when given, hears of every dropped line and its
 * size in UTF-8 bytes, so the transcript can say a line was there (nothing is dropped silently).
 */
export function createLineSplitter(onLine, maxLineBytes = 10 * 1024 * 1024, onDropped = () => {}) {
  let buffer = "";
  let dropping = false;
  let droppedBytes = 0;
  const emit = (line) => { if (line.trim() !== "") onLine(line); };
  return {
    push(chunk) {
      let text = chunk;
      for (;;) {
        const newline = text.indexOf("\n");
        if (newline < 0) break;
        const line = buffer + text.slice(0, newline);
        buffer = "";
        if (dropping) onDropped(droppedBytes + Buffer.byteLength(line));
        else if (Buffer.byteLength(line) <= maxLineBytes) emit(line);
        else onDropped(Buffer.byteLength(line));
        dropping = false;
        droppedBytes = 0;
        text = text.slice(newline + 1);
      }
      if (dropping) { droppedBytes += Buffer.byteLength(text); return; }
      buffer += text;
      if (Buffer.byteLength(buffer) > maxLineBytes) { droppedBytes = Buffer.byteLength(buffer); buffer = ""; dropping = true; }
    },
    end() {
      if (dropping) onDropped(droppedBytes);
      else if (buffer !== "") emit(buffer);
      buffer = "";
      dropping = false;
      droppedBytes = 0;
    },
  };
}

/** Live transcript (Orca spec 2026-10-23 §10.2.2): a call's transcript stops recording at this many bytes. */
export const TRANSCRIPT_LIMIT = 128 * 1024 * 1024;

/**
 * Live transcript (Orca spec 2026-10-23 §10.2.1-§10.2.2): the call's transcript.jsonl, written by the runner. Every complete
 * stream line is appended except a `stream_event` whose inner event is `content_block_delta` (deltas repeat the final
 * message and multiply the size; message_start and message_delta stay, they are small and carry usage). Writes go through
 * a kept-open descriptor with writeSync, because the adapter SIGKILLs the runner's group: every line handed here is in the
 * file when line() returns. Lines are written whole, so at the cap the file already ends at a line end; one
 * `ccloop.transcript-truncated` line then says where, and nothing more is written. A write error is reported once on
 * stderr and stops the transcript, never the call. No path (no CCLOOP_CLAUDE_TRANSCRIPT_PATH) writes nothing.
 */
export function createTranscriptWriter(path, cap = TRANSCRIPT_LIMIT) {
  if (!path) return { line() {}, dropped() {}, close() {} };
  let fd = null;
  let size = 0;
  let stopped = false;
  const fail = (error) => { stopped = true; process.stderr.write(`claude-runner: transcript not written: ${String(error)}\n`); };
  try { fd = openSync(path, "a", 0o600); } catch (error) { fail(error); }
  const writeAll = (bytes) => { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset); };
  // The line goes out as a string (writeSync encodes it), so no copy of a long line is made here; a short write, which a
  // regular file does not do in practice, is completed from its encoded bytes.
  const writeText = (text) => {
    const length = Buffer.byteLength(text, "utf8");
    const written = writeSync(fd, text, null, "utf8");
    if (written < length) writeAll(Buffer.from(text, "utf8").subarray(written));
    return length;
  };
  const put = (text) => {
    if (stopped) return;
    try {
      if (size + Buffer.byteLength(text, "utf8") + 1 > cap) {
        stopped = true;
        writeText(`${JSON.stringify({ type: "ccloop.transcript-truncated", atBytes: size })}\n`);
        return;
      }
      size += writeText(`${text}\n`);
    } catch (error) { fail(error); }
  };
  return {
    line(text, event) {
      if (event && typeof event === "object" && event.type === "stream_event" && event.event && event.event.type === "content_block_delta") return;
      put(text);
    },
    dropped(bytes) { put(JSON.stringify({ type: "ccloop.line-dropped", bytes })); },
    close() { if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } fd = null; } stopped = true; },
  };
}

/** One message's count: the fields buildUsageEvidence would count, skipping any that are not finite and >= 0. */
function messageTotal(usage) {
  const evidence = buildUsageEvidence({ usage });
  const values = [
    evidence.selectedInputField && evidence.fields[evidence.selectedInputField].value,
    evidence.selectedOutputField && evidence.fields[evidence.selectedOutputField].value,
    ...Object.values(evidence.cacheFields).filter((field) => field.status === "finite").map((field) => field.value),
  ].filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return values.reduce((sum, value) => sum + value, 0);
}

/**
 * Spec §2 (claude 2.1.283, measured): input and cache counts are per message and add up across messages; a
 * message_start carries an opening snapshot whose output is low, and the message_delta that follows it carries the
 * message's final usage. So each message counts once, by its latest usage. `assistant` events repeat the
 * message_start usage and are not counted.
 *
 * Orca backlog #12(b) (2026-09-29): "follows it" is per stream. Every stream event names the agent that streamed it
 * in `parent_tool_use_id` (null, or absent, for the main agent; a subagent's Task tool call id otherwise), so the
 * open message is tracked per stream and a message_delta closes only its own stream's. A subagent's messages are
 * still counted, each once: they are spent tokens too.
 */
export function createUsageObserver() {
  const messages = new Map();
  const current = new Map();
  return {
    observe(event) {
      const inner = event && event.type === "stream_event" ? event.event : null;
      if (!inner || typeof inner !== "object") return false;
      const stream = typeof event.parent_tool_use_id === "string" ? event.parent_tool_use_id : null;
      if (inner.type === "message_start" && inner.message && typeof inner.message.id === "string" && inner.message.usage && typeof inner.message.usage === "object") {
        current.set(stream, inner.message.id);
        messages.set(inner.message.id, { id: inner.message.id, state: "open", fields: inner.message.usage });
        return true;
      }
      const open = current.get(stream);
      if (inner.type === "message_delta" && open !== undefined && messages.has(open) && inner.usage && typeof inner.usage === "object") {
        messages.set(open, { id: open, state: "closed", fields: inner.usage });
        return true;
      }
      return false;
    },
    snapshot() {
      const list = [...messages.values()];
      const sum = list.reduce((total, message) => total + messageTotal(message.fields), 0);
      return { total: Number.isSafeInteger(sum) && sum > 0 ? sum : null, messages: list, openMessage: list.some((message) => message.state === "open") };
    },
  };
}

/** Temp file in the same directory, then rename: a reader sees the previous version or this one, never half. */
export function writeObservation(path, snapshot) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify({ schema: OBSERVED_USAGE_SCHEMA, total: snapshot.total, messages: snapshot.messages, source: "stream-before-abort", lowerBound: true, openMessage: snapshot.openMessage }), { mode: 0o600 });
  renameSync(temporary, path);
}

const MODEL_USAGE_FIELDS = [
  ["input", "inputTokens"],
  ["output", "outputTokens"],
  ["cacheRead", "cacheReadInputTokens"],
  ["cacheWrite", "cacheCreationInputTokens"],
];

/**
 * Orca accounts plan, Part B Task B2 (2026-10-07): claude's result envelope keys `modelUsage` by model. Each value's four
 * counts become one entry, sorted by model (JS code-unit order, as ccloop's byModelSchema checks it); `input` is
 * claude's non-cached input. A breakdown read only in part would under-report some model, so any value that is not an
 * object of four non-negative safe integers, or a model name the usage event cannot carry, makes the whole of it null;
 * so does a map that is absent or empty. Anything else in a value (costUSD, ...) is never copied.
 */
export function buildModelUsage(envelope) {
  const map = envelope && typeof envelope === "object" ? envelope.modelUsage : undefined;
  if (map === null || typeof map !== "object" || Array.isArray(map)) return null;
  const entries = [];
  for (const [model, value] of Object.entries(map)) {
    if (model.length === 0 || model.length > 200) return null;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const entry = { model };
    for (const [name, field] of MODEL_USAGE_FIELDS) {
      const count = value[field];
      if (!Number.isSafeInteger(count) || count < 0) return null;
      entry[name] = count;
    }
    entries.push(entry);
  }
  if (entries.length === 0) return null;
  return entries.sort((left, right) => (left.model < right.model ? -1 : left.model > right.model ? 1 : 0));
}
