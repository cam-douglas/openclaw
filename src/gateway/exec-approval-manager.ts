import { randomUUID } from "node:crypto";
import type {
  ExecApprovalDecision,
  ExecApprovalRequestPayload as InfraExecApprovalRequestPayload,
} from "../infra/exec-approvals.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";

// Grace period to keep resolved entries for late awaitDecision calls
const RESOLVED_ENTRY_GRACE_MS = 15_000;

export type ExecApprovalRequestPayload = InfraExecApprovalRequestPayload;

export type ExecApprovalRecord<TPayload = ExecApprovalRequestPayload> = {
  id: string;
  request: TPayload;
  createdAtMs: number;
  expiresAtMs: number;
  // Caller metadata (best-effort). Used to prevent other clients from replaying an approval id.
  requestedByConnId?: string | null;
  requestedByDeviceId?: string | null;
  requestedByClientId?: string | null;
  resolvedAtMs?: number;
  decision?: ExecApprovalDecision;
  resolvedBy?: string | null;
};

type PendingEntry<TPayload = ExecApprovalRequestPayload> = {
  record: ExecApprovalRecord<TPayload>;
  resolve: (decision: ExecApprovalDecision | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<ExecApprovalDecision | null>;
};

type BatchSessionState = {
  active: boolean;
  queuedIds: string[];
};

export type ExecApprovalIdLookupResult =
  | { kind: "exact" | "prefix"; id: string }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "none" };

export class ExecApprovalManager<TPayload = ExecApprovalRequestPayload> {
  private pending = new Map<string, PendingEntry<TPayload>>();
  private batchSessions = new Map<string, BatchSessionState>();

  private normalizeBatchSessionKey(sessionKey: string | null | undefined): string | null {
    if (typeof sessionKey !== "string") {
      return null;
    }
    const trimmed = sessionKey.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private getRecordSessionKey(record: ExecApprovalRecord<TPayload>): string | null {
    const request = record.request;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return null;
    }
    const raw = (request as { sessionKey?: unknown }).sessionKey;
    return typeof raw === "string" ? this.normalizeBatchSessionKey(raw) : null;
  }

  private removeFromBatchQueues(recordId: string): void {
    for (const state of this.batchSessions.values()) {
      const before = state.queuedIds.length;
      if (before === 0) {
        continue;
      }
      state.queuedIds = state.queuedIds.filter((id) => id !== recordId);
    }
  }

  private queueForActiveBatch(record: ExecApprovalRecord<TPayload>): void {
    const sessionKey = this.getRecordSessionKey(record);
    if (!sessionKey) {
      return;
    }
    const state = this.batchSessions.get(sessionKey);
    if (!state?.active) {
      return;
    }
    if (!state.queuedIds.includes(record.id)) {
      state.queuedIds.push(record.id);
    }
  }

  isBatchActive(sessionKey: string | null | undefined): boolean {
    const normalized = this.normalizeBatchSessionKey(sessionKey);
    if (!normalized) {
      return false;
    }
    return this.batchSessions.get(normalized)?.active === true;
  }

  startBatch(sessionKey: string | null | undefined): {
    active: boolean;
    sessionKey: string | null;
    queued: ExecApprovalRecord<TPayload>[];
  } {
    const normalized = this.normalizeBatchSessionKey(sessionKey);
    if (!normalized) {
      return { active: false, sessionKey: null, queued: [] };
    }
    const existing = this.batchSessions.get(normalized);
    const state: BatchSessionState = existing ?? { active: true, queuedIds: [] };
    state.active = true;
    this.batchSessions.set(normalized, state);
    const pendingForSession = [...this.pending.values()]
      .map((entry) => entry.record)
      .filter(
        (record) =>
          record.resolvedAtMs === undefined && this.getRecordSessionKey(record) === normalized,
      )
      .toSorted((left, right) => left.createdAtMs - right.createdAtMs);
    for (const record of pendingForSession) {
      if (!state.queuedIds.includes(record.id)) {
        state.queuedIds.push(record.id);
      }
    }
    return { active: true, sessionKey: normalized, queued: this.getBatchQueue(normalized).queued };
  }

  getBatchQueue(sessionKey: string | null | undefined): {
    active: boolean;
    sessionKey: string | null;
    queued: ExecApprovalRecord<TPayload>[];
  } {
    const normalized = this.normalizeBatchSessionKey(sessionKey);
    if (!normalized) {
      return { active: false, sessionKey: null, queued: [] };
    }
    const state = this.batchSessions.get(normalized);
    if (!state) {
      return { active: false, sessionKey: normalized, queued: [] };
    }
    const queued: ExecApprovalRecord<TPayload>[] = [];
    const nextIds: string[] = [];
    for (const id of state.queuedIds) {
      const record = this.getSnapshot(id);
      if (!record || record.resolvedAtMs !== undefined) {
        continue;
      }
      queued.push(record);
      nextIds.push(id);
    }
    state.queuedIds = nextIds;
    return { active: state.active, sessionKey: normalized, queued };
  }

  endBatch(sessionKey: string | null | undefined): void {
    const normalized = this.normalizeBatchSessionKey(sessionKey);
    if (!normalized) {
      return;
    }
    this.batchSessions.delete(normalized);
  }

  create(request: TPayload, timeoutMs: number, id?: string | null): ExecApprovalRecord<TPayload> {
    const now = Date.now();
    const resolvedId = id && id.trim().length > 0 ? id.trim() : randomUUID();
    const record: ExecApprovalRecord<TPayload> = {
      id: resolvedId,
      request,
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
    };
    return record;
  }

  /**
   * Register an approval record and return a promise that resolves when the decision is made.
   * This separates registration (synchronous) from waiting (async), allowing callers to
   * confirm registration before the decision is made.
   */
  register(
    record: ExecApprovalRecord<TPayload>,
    timeoutMs: number,
  ): Promise<ExecApprovalDecision | null> {
    const existing = this.pending.get(record.id);
    if (existing) {
      // Idempotent: return existing promise if still pending
      if (existing.record.resolvedAtMs === undefined) {
        return existing.promise;
      }
      // Already resolved - don't allow re-registration
      throw new Error(`approval id '${record.id}' already resolved`);
    }
    let resolvePromise: (decision: ExecApprovalDecision | null) => void;
    let rejectPromise: (err: Error) => void;
    const promise = new Promise<ExecApprovalDecision | null>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // Create entry first so we can capture it in the closure (not re-fetch from map)
    const entry: PendingEntry<TPayload> = {
      record,
      resolve: resolvePromise!,
      reject: rejectPromise!,
      timer: null as unknown as ReturnType<typeof setTimeout>,
      promise,
    };
    entry.timer = setTimeout(() => {
      this.expire(record.id);
    }, timeoutMs);
    this.pending.set(record.id, entry);
    this.queueForActiveBatch(record);
    return promise;
  }

  /**
   * @deprecated Use register() instead for explicit separation of registration and waiting.
   */
  async waitForDecision(
    record: ExecApprovalRecord<TPayload>,
    timeoutMs: number,
  ): Promise<ExecApprovalDecision | null> {
    return this.register(record, timeoutMs);
  }

  resolve(recordId: string, decision: ExecApprovalDecision, resolvedBy?: string | null): boolean {
    const pending = this.pending.get(recordId);
    if (!pending) {
      return false;
    }
    // Prevent double-resolve (e.g., if called after timeout already resolved)
    if (pending.record.resolvedAtMs !== undefined) {
      return false;
    }
    clearTimeout(pending.timer);
    pending.record.resolvedAtMs = Date.now();
    pending.record.decision = decision;
    pending.record.resolvedBy = resolvedBy ?? null;
    this.removeFromBatchQueues(recordId);
    // Resolve the promise first, then delete after a grace period.
    // This allows in-flight awaitDecision calls to find the resolved entry.
    pending.resolve(decision);
    setTimeout(() => {
      // Only delete if the entry hasn't been replaced
      if (this.pending.get(recordId) === pending) {
        this.pending.delete(recordId);
      }
    }, RESOLVED_ENTRY_GRACE_MS);
    return true;
  }

  expire(recordId: string, resolvedBy?: string | null): boolean {
    const pending = this.pending.get(recordId);
    if (!pending) {
      return false;
    }
    if (pending.record.resolvedAtMs !== undefined) {
      return false;
    }
    clearTimeout(pending.timer);
    pending.record.resolvedAtMs = Date.now();
    pending.record.decision = undefined;
    pending.record.resolvedBy = resolvedBy ?? null;
    this.removeFromBatchQueues(recordId);
    pending.resolve(null);
    setTimeout(() => {
      if (this.pending.get(recordId) === pending) {
        this.pending.delete(recordId);
      }
    }, RESOLVED_ENTRY_GRACE_MS);
    return true;
  }

  getSnapshot(recordId: string): ExecApprovalRecord<TPayload> | null {
    const entry = this.pending.get(recordId);
    return entry?.record ?? null;
  }

  consumeAllowOnce(recordId: string): boolean {
    const entry = this.pending.get(recordId);
    if (!entry) {
      return false;
    }
    const record = entry.record;
    if (record.decision !== "allow-once") {
      return false;
    }
    // One-time approvals must be consumed atomically so the same runId
    // cannot be replayed during the resolved-entry grace window.
    record.decision = undefined;
    return true;
  }

  /**
   * Wait for decision on an already-registered approval.
   * Returns the decision promise if the ID is pending, null otherwise.
   */
  awaitDecision(recordId: string): Promise<ExecApprovalDecision | null> | null {
    const entry = this.pending.get(recordId);
    return entry?.promise ?? null;
  }

  lookupPendingId(input: string): ExecApprovalIdLookupResult {
    const normalized = input.trim();
    if (!normalized) {
      return { kind: "none" };
    }

    const exact = this.pending.get(normalized);
    if (exact) {
      return exact.record.resolvedAtMs === undefined
        ? { kind: "exact", id: normalized }
        : { kind: "none" };
    }

    const lowerPrefix = normalized.toLowerCase();
    const matches: string[] = [];
    for (const [id, entry] of this.pending.entries()) {
      if (entry.record.resolvedAtMs !== undefined) {
        continue;
      }
      if (id.toLowerCase().startsWith(lowerPrefix)) {
        matches.push(id);
      }
    }

    if (matches.length === 1) {
      return { kind: "prefix", id: matches[0] };
    }
    if (matches.length > 1) {
      return { kind: "ambiguous", ids: matches };
    }
    return { kind: "none" };
  }

  getPendingForSession(sessionKey: string | null | undefined): ExecApprovalRecord<TPayload>[] {
    const normalized = this.normalizeBatchSessionKey(sessionKey);
    if (!normalized) {
      return [];
    }
    return [...this.pending.values()]
      .map((entry) => entry.record)
      .filter(
        (record) =>
          record.resolvedAtMs === undefined && this.getRecordSessionKey(record) === normalized,
      )
      .toSorted((left, right) => left.createdAtMs - right.createdAtMs);
  }

  getLatestPendingForSession(
    sessionKey: string | null | undefined,
  ): ExecApprovalRecord<TPayload> | null {
    const pending = this.getPendingForSession(sessionKey);
    return pending.length > 0 ? pending[pending.length - 1] : null;
  }

  /**
   * Pending exec approvals whose `agentId` or session key resolves to the same agent id.
   * Used when the operator replies in a chat/session that does not match the pending approval
   * (for example subagent runs) so natural-language yes/no can still resolve the latest request.
   */
  getPendingForAgent(agentId: string | null | undefined): ExecApprovalRecord<TPayload>[] {
    const normalized =
      typeof agentId === "string" && agentId.trim() ? normalizeAgentId(agentId) : null;
    if (!normalized) {
      return [];
    }
    return [...this.pending.values()]
      .map((entry) => entry.record)
      .filter((record) => {
        if (record.resolvedAtMs !== undefined) {
          return false;
        }
        const request = record.request as { agentId?: unknown; sessionKey?: unknown };
        const rid = typeof request.agentId === "string" ? normalizeAgentId(request.agentId) : null;
        if (rid === normalized) {
          return true;
        }
        const sk = this.getRecordSessionKey(record);
        if (sk && resolveAgentIdFromSessionKey(sk) === normalized) {
          return true;
        }
        return false;
      })
      .toSorted((left, right) => left.createdAtMs - right.createdAtMs);
  }

  getLatestPendingForAgent(
    agentId: string | null | undefined,
  ): ExecApprovalRecord<TPayload> | null {
    const pending = this.getPendingForAgent(agentId);
    return pending.length > 0 ? pending[pending.length - 1] : null;
  }
}
