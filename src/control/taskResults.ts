import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { appendEvent } from "../persistence/fileStore.js";
import type { ExecutionResult, VerificationResult } from "../runtime/types.js";
import { boundedTaskResult, normalizeTaskResult } from "../runtime/taskResult.js";
import { artifactRefSchema, canonicalHash, ControlProtocolError, idSchema, type ArtifactRefV1, type StartEnvelopeV3 } from "./protocol.js";
import { readAccepted } from "./store.js";
import { MAX_TASK_RESULT_EVIDENCE_BYTES, MAX_TASK_RESULT_FILE_BYTES, MAX_TASK_RESULT_FILES, publishTaskResultIndex, readCapturedTaskResultEvidence, readTaskResultFile, safeTaskResultPath, TaskResultFileError, writeTaskResultEvidence } from "./taskResultEvidence.js";
export const TASK_RESULT_MANIFEST_SCHEMA = "ccloop-task-result-manifest-v1";
export const TASK_RESULT_COLLECTION_SCHEMA = "ccloop-task-results-v1";
export const TASK_RESULT_VERIFICATION_STARTED_SCHEMA = "ccloop-task-result-verification-started-v1";
const safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), positive = safe.refine(n => n > 0), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const taskResultIdentitySchema = z.object({
    groupId: idSchema, workItemId: idSchema, taskId: idSchema.nullable(), runId: idSchema, generation: positive, graphVersion: safe, targetVersion: safe, executionId: idSchema, envelopeHash: hash
}).strict();
export const taskResultVerificationStartedSchema = z.object({
    schema: z.literal(TASK_RESULT_VERIFICATION_STARTED_SCHEMA),
    attempt: positive,
    status: z.literal("in-progress"),
}).strict();
export type TaskResultIdentityV1 = z.infer<typeof taskResultIdentitySchema>;
export const taskResultOutputSchema = z.object({
    id: idSchema, path: z.string().max(1024), label: z.string().max(256), origin: z.enum(["reported", "changed"]), status: z.enum(["available", "missing", "deleted", "symlink", "binary", "too-large", "changed", "unsafe", "unavailable"]), byteLength: safe.max(MAX_TASK_RESULT_FILE_BYTES).nullable(), ref: artifactRefSchema.nullable()
}).strict().refine(o => (o.status === "available" || o.status === "binary") ? o.ref !== null && o.byteLength !== null : o.ref === null && o.byteLength === null);
export type TaskResultOutputV1 = z.infer<typeof taskResultOutputSchema>;
export const taskResultManifestSchema = z.object({
    schema: z.literal(TASK_RESULT_MANIFEST_SCHEMA), identity: taskResultIdentitySchema, attempt: positive, revision: positive, stage: z.enum(["execution", "verification"]), explanation: z.object({
        status: z.enum(["missing", "invalid", "available"]), reason: z.string().max(256).nullable(), ref: artifactRefSchema.nullable()
    }).strict(), executionRef: artifactRefSchema.nullable(), verificationRef: artifactRefSchema.nullable(), outputs: z.array(taskResultOutputSchema).max(MAX_TASK_RESULT_FILES)
}).strict().refine(m => m.stage !== "execution" || m.verificationRef === null).refine(m => new Set(m.outputs.map(o => o.id)).size === m.outputs.length);
export type TaskResultManifestV1 = z.infer<typeof taskResultManifestSchema>;
const observationSchema = z.object({
    revision: positive, ref: artifactRefSchema
}).strict();
export const taskResultCollectionSchema = z.object({
    schema: z.literal(TASK_RESULT_COLLECTION_SCHEMA), identity: taskResultIdentitySchema, currentAttempt: safe, revision: safe, manifests: z.array(observationSchema).max(64), nextRevision: safe
}).strict().refine(c => c.nextRevision <= c.revision && c.manifests.every((m, i) => m.revision <= c.nextRevision && (i === 0 || c.manifests[i - 1]!.revision < m.revision)));
export type TaskResultCollectionV1 = z.infer<typeof taskResultCollectionSchema>;
const observationKindSchema = z.enum(["execution", "verification-started", "verification-completed"]);
const indexObservationSchema = observationSchema.extend({
    kind: observationKindSchema.optional()
});
const indexSchema = z.object({
    schema: z.literal("ccloop-task-result-index-v1"), identity: taskResultIdentitySchema, revision: safe, manifests: z.array(indexObservationSchema)
}).strict().refine(i => i.revision === i.manifests.length && i.manifests.every((m, n) => m.revision === n + 1));
type Index = z.infer<typeof indexSchema>;
const indexPath = (source: string) => join(source, "run", "task-result-captures", "index.json");
const sameRef = (a: ArtifactRefV1, b: ArtifactRefV1) => a.artifactId === b.artifactId && a.hash === b.hash;
function refuse(): never { throw new ControlProtocolError("control-task-result-authority-invalid"); }
async function acceptedIdentity(input: StartEnvelopeV3): Promise<TaskResultIdentityV1> {
    const accepted = await readAccepted(input.work.sourceDir);
    if (accepted.envelopeHash !== canonicalHash(input) || accepted.generation !== input.claim.generation || accepted.configHash !== input.claim.configHash)
        throw new ControlProtocolError("control-envelope-conflict");
    const { groupId, workItemId, taskId, runId, generation, graphVersion, targetVersion } = input.claim;
    return taskResultIdentitySchema.parse({
        groupId, workItemId, taskId, runId, generation, graphVersion, targetVersion, executionId: accepted.executionId, envelopeHash: accepted.envelopeHash
    });
}
async function readIndex(input: StartEnvelopeV3, identity: TaskResultIdentityV1): Promise<Index | null> {
    let bytes: Buffer;
    try {
        bytes = await readTaskResultFile(input.work.sourceDir, indexPath(input.work.sourceDir), MAX_TASK_RESULT_EVIDENCE_BYTES);
    }
    catch (error) {
        if (error instanceof TaskResultFileError && error.status === "missing")
            return null;
        throw error;
    }
    const parsed = indexSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success || canonicalHash(parsed.data.identity) !== canonicalHash(identity))
        refuse();
    return parsed.data;
}
async function loadManifest(input: StartEnvelopeV3, index: Index, ref: ArtifactRefV1): Promise<TaskResultManifestV1> {
    const observation = index.manifests.find(m => sameRef(m.ref, ref));
    if (!observation)
        refuse();
    const parsed = taskResultManifestSchema.safeParse(JSON.parse((await readCapturedTaskResultEvidence(input.work.sourceDir, ref)).toString("utf8")));
    if (!parsed.success || canonicalHash(parsed.data.identity) !== canonicalHash(index.identity) || parsed.data.revision !== observation.revision)
        refuse();
    return parsed.data;
}
/** Live reads depend only on accepted authority, progress, and the published index. They never capture or create files. */
export async function collectTaskResults(input: StartEnvelopeV3, afterRevision: number): Promise<TaskResultCollectionV1> {
    if (!safe.safeParse(afterRevision).success)
        throw new ControlProtocolError("control-task-result-cursor-invalid");
    const identity = await acceptedIdentity(input), index = await readIndex(input, identity);
    let currentAttempt = 0;
    try {
        const state = JSON.parse((await readTaskResultFile(input.work.sourceDir, join(input.work.sourceDir, "run", "loop-state.json"), MAX_TASK_RESULT_EVIDENCE_BYTES)).toString("utf8"));
        currentAttempt = safe.parse(state.currentAttempt);
    }
    catch (error) {
        if (!(error instanceof TaskResultFileError && error.status === "missing"))
            throw error;
    }
    const revision = index?.revision ?? 0;
    if (afterRevision > revision)
        throw new ControlProtocolError("control-task-result-cursor-invalid");
    const manifests = index?.manifests.filter(m => m.revision > afterRevision).slice(0, 64)
        .map(({ revision, ref }) => ({
        revision, ref
    })) ?? [];
    for (const m of manifests)
        await loadManifest(input, index!, m.ref);
    return {
        schema: TASK_RESULT_COLLECTION_SCHEMA, identity, currentAttempt, revision, manifests, nextRevision: manifests.at(-1)?.revision ?? afterRevision
    };
}
export async function readTaskResultEvidence(input: StartEnvelopeV3, manifestRef: ArtifactRefV1, ref: ArtifactRefV1): Promise<Buffer> {
    const identity = await acceptedIdentity(input), index = await readIndex(input, identity);
    if (!index)
        refuse();
    const m = await loadManifest(input, index, manifestRef);
    const authorized = [manifestRef, m.explanation.ref, m.executionRef, m.verificationRef, ...m.outputs.map(o => o.ref)].filter((r): r is ArtifactRefV1 => r !== null);
    if (!authorized.some(r => sameRef(r, ref)))
        refuse();
    return await readCapturedTaskResultEvidence(input.work.sourceDir, ref);
}
export interface TaskResultCaptureInput {
    input: StartEnvelopeV3;
    runDir: string;
    worktreePath: string;
    attempt: number;
    execution: ExecutionResult;
    verification?: VerificationResult;
    /** Actual controller verification entry, never Agent metadata. */
    verificationStarted?: boolean;
    assertHeld: () => Promise<void>;
}
const exec = promisify(execFile);
async function capture(input: TaskResultCaptureInput): Promise<void> {
    const envelope = input.input, source = envelope.work.sourceDir;
    if (input.runDir !== join(source, "run") || !positive.safeParse(input.attempt).success)
        refuse();
    await input.assertHeld();
    const identity = await acceptedIdentity(envelope), old = await readIndex(envelope, identity);
    const index: Index = old ?? {
        schema: "ccloop-task-result-index-v1", identity, revision: 0, manifests: []
    };
    const kind = input.verificationStarted === true ? "verification-started"
        : input.verification !== undefined ? "verification-completed" : "execution";
    let executionStage: TaskResultManifestV1 | undefined;
    for (const observation of index.manifests) {
        const manifest = await loadManifest(envelope, index, observation.ref);
        if (manifest.attempt !== input.attempt)
            continue;
        // Original private rows predate actual-start observations; their verification stage was completed capture.
        const previousKind = observation.kind ?? (manifest.stage === "execution" ? "execution" : "verification-completed");
        if (previousKind === kind)
            return;
        if (manifest.stage === "execution")
            executionStage = manifest;
    }
    if (kind !== "execution" && !executionStage)
        throw new Error("task-result-execution-snapshot-unavailable");
    const write = (bytes: Buffer) => writeTaskResultEvidence(source, bytes, input.assertHeld);
    const optional = async (value: unknown) => { try {
        return await write(Buffer.from(JSON.stringify(value)));
    }
    catch (error) {
        await input.assertHeld();
        await appendEvent(input.runDir, {
            type: "task_result_capture_failed", at: new Date().toISOString(), detail: `attempt ${input.attempt}: supplemental evidence unavailable (${error instanceof Error ? error.message : "capture failed"})`
        }).catch(() => undefined);
        return null;
    } };
    let manifest: TaskResultManifestV1;
    if (kind !== "execution") {
        const evidence = kind === "verification-started"
            ? taskResultVerificationStartedSchema.parse({
                schema: TASK_RESULT_VERIFICATION_STARTED_SCHEMA, attempt: input.attempt, status: "in-progress",
            }) : input.verification;
        manifest = {
            ...executionStage!, revision: index.revision + 1, stage: "verification", verificationRef: await optional(evidence),
        };
    }
    else {
        const normalized = normalizeTaskResult(input.execution.taskResult), raw = boundedTaskResult(input.execution.taskResult);
        const reportRef = raw === undefined ? null : await optional(raw);
        const explanation = {
            status: normalized.status, reason: raw !== undefined && reportRef === null ? "task-result-evidence-unavailable" : normalized.reason, ref: reportRef
        };
        const { taskResult: _metadata, ...core } = input.execution;
        const outputs: TaskResultOutputV1[] = [];
        const paths = new Map<string, {
            label: string;
            origin: "reported" | "changed";
        }>();
        for (const output of normalized.report?.outputs ?? [])
            paths.set(output.path, {
                label: output.label, origin: "reported"
            });
        // Git status is the controller's changed-path observation; no report-derived path grants authority to another file.
        const { stdout } = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
            cwd: input.worktreePath, maxBuffer: 1024 * 1024, timeout: 1000
        });
        const entries = stdout.split("\0");
        const deleted = new Set<string>();
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]!;
            if (!entry)
                continue;
            const status = entry.slice(0, 2), path = entry.slice(3);
            if (!paths.has(path))
                paths.set(path, {
                    label: path.slice(0, 256), origin: "changed"
                });
            if (status.includes("D"))
                deleted.add(path);
            if (/[RC]/.test(status))
                i++;
        }
        for (const [path, metadata] of [...paths].slice(0, MAX_TASK_RESULT_FILES)) {
            const output: TaskResultOutputV1 = {
                id: `output-${outputs.length + 1}`, path: path.slice(0, 1024), ...metadata, status: "unavailable", byteLength: null, ref: null
            };
            if (!safeTaskResultPath(path))
                output.status = "unsafe";
            else
                try {
                    const bytes = await readTaskResultFile(input.worktreePath, join(input.worktreePath, path), MAX_TASK_RESULT_FILE_BYTES);
                    output.ref = await write(bytes);
                    output.byteLength = bytes.length;
                    try {
                        new TextDecoder("utf-8", {
                            fatal: true
                        }).decode(bytes);
                        output.status = bytes.includes(0) ? "binary" : "available";
                    }
                    catch {
                        output.status = "binary";
                    }
                }
                catch (error) {
                    await input.assertHeld();
                    output.status = error instanceof TaskResultFileError ? error.status : "unavailable";
                    if (output.status === "missing" && deleted.has(path))
                        output.status = "deleted";
                }
            outputs.push(output);
        }
        manifest = {
            schema: TASK_RESULT_MANIFEST_SCHEMA, identity, attempt: input.attempt, revision: index.revision + 1, stage: "execution", explanation, executionRef: await optional(core), verificationRef: null, outputs
        };
    }
    const ref = await write(Buffer.from(JSON.stringify(taskResultManifestSchema.parse(manifest))));
    const next = indexSchema.parse({
        ...index, revision: manifest.revision, manifests: [...index.manifests, {
                revision: manifest.revision, ref, kind
            }]
    });
    await publishTaskResultIndex(source, indexPath(source), Buffer.from(JSON.stringify(next)), input.assertHeld);
}
/** Optional metadata failures are diagnosed, but a lost owner/lease always follows the core controller's handling. */
export async function captureTaskResult(input: TaskResultCaptureInput): Promise<void> {
    try {
        await capture(input);
    }
    catch (error) {
        await input.assertHeld();
        await appendEvent(input.runDir, {
            type: "task_result_capture_failed", at: new Date().toISOString(), detail: `attempt ${input.attempt} ${input.verificationStarted || input.verification ? "verification" : "execution"}: ${error instanceof Error ? error.message : "capture failed"}`
        }).catch(() => undefined);
    }
}
