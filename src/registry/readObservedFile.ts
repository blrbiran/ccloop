// L2 run registry — the I/O layer beneath observeFields. Reads one observed file, decides
// absent vs. parse-failure vs. permission-failure, and retries a bounded number of times for
// files marked `atomic: false` in OBSERVED_FILES. That flag no longer means "written
// non-atomically": every writer of those files now publishes by rename. It is kept false so
// this retry survives as defence in depth — see the comments on the flags in observeFields.ts.
// See docs/superpowers/specs/2026-07-28-run-registry-design.md §8.1, §11.

import { readRunState, readOwnerRecordWithoutRecovery, readOwnerTransferRecord } from "../persistence/fileStore.js";
import { LEASE_VERIFY_READ_ATTEMPTS, LEASE_VERIFY_RETRY_DELAY_MS } from "../ownership/lease.js";
import { observeFields } from "./observeFields.js";
import type { FieldObservation, FileObservation, ObservedFileSpec } from "./types.js";

export type RunFileReaders = {
  readRunState(runDir: string): Promise<unknown>;
  readOwnerRecordWithoutRecovery(runDir: string): Promise<unknown>;
  readOwnerTransferRecord(runDir: string): Promise<unknown>;
};

export type ObserveDeps = {
  readers: RunFileReaders;
  sleep(ms: number): Promise<void>;
  now(): Date;
};

// Bound production to the same verified-pure readers fileStore already exercises, so no
// second JSON-reading implementation exists to drift from the first (spec §7.2). Never bind
// readOwnerRecord here — it runs crash recovery and would turn this read-only layer into a
// writer (spec §7.1).
export const defaultObserveDeps: ObserveDeps = {
  readers: {
    readRunState,
    readOwnerRecordWithoutRecovery,
    readOwnerTransferRecord,
  },
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

function pickReader(readers: RunFileReaders, file: string): (runDir: string) => Promise<unknown> {
  switch (file) {
    case "loop-state.json":
      return readers.readRunState;
    case "owner-record.json":
      return readers.readOwnerRecordWithoutRecovery;
    case "owner-transfer.json":
      return readers.readOwnerTransferRecord;
    default:
      throw new Error(`readObservedFile: no reader bound for ${file}`);
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniformObservation(
  spec: ObservedFileSpec,
  build: (fieldName: string) => FieldObservation,
): FileObservation {
  const fields: Record<string, FieldObservation> = {};
  for (const fieldSpec of spec.fields) {
    fields[fieldSpec.name] = build(fieldSpec.name);
  }
  return { file: spec.file, fields };
}

// Requirement: ENOENT resolves immediately to `absent`, no retry (spec §8.1, §11).
function absentObservation(spec: ObservedFileSpec): FileObservation {
  return uniformObservation(spec, () => ({ kind: "absent" }));
}

// Requirement: a read failure that is neither ENOENT nor a parse failure (e.g. EACCES) is
// `unreadable(io)`, no retry — it must not fall through to `absent`, which would report a
// present-but-forbidden file as missing (spec §11).
function ioUnreadableObservation(spec: ObservedFileSpec, error: unknown): FileObservation {
  const detail = describeError(error);
  return uniformObservation(spec, () => ({ kind: "unreadable", reason: "io", detail }));
}

// Requirement: parse failure, retry exhausted (or atomic file, no retry) → `unreadable(parse)`
// (spec §8.1, §11).
function parseUnreadableObservation(spec: ObservedFileSpec, error: unknown): FileObservation {
  const detail = describeError(error);
  return uniformObservation(spec, () => ({ kind: "unreadable", reason: "parse", detail }));
}

export async function readObservedFile(
  runDir: string,
  spec: ObservedFileSpec,
  deps: ObserveDeps,
): Promise<FileObservation> {
  const reader = pickReader(deps.readers, spec.file);
  // Retry applies to parse failure on non-atomic files only; an atomic file (written by
  // rename) is read once (spec §8.1).
  const maxAttempts = spec.atomic ? 1 : LEASE_VERIFY_READ_ATTEMPTS;

  let lastParseError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const parsed = await reader(runDir);
      return observeFields(parsed, spec);
    } catch (error) {
      if (isEnoent(error)) {
        return absentObservation(spec);
      }

      if (!(error instanceof SyntaxError)) {
        return ioUnreadableObservation(spec, error);
      }

      lastParseError = error;
      if (attempt < maxAttempts) {
        await deps.sleep(LEASE_VERIFY_RETRY_DELAY_MS);
      }
    }
  }

  return parseUnreadableObservation(spec, lastParseError);
}
