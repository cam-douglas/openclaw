import { createSubsystemLogger } from "../../logging/subsystem.js";

type RateLimitWindow = "second" | "minute" | "day" | "month";

type UsageSample = {
  atMs: number;
  inputTokens: number;
};

type ParsedRateLimitDetail = {
  limit: number;
  unit: string;
  window: RateLimitWindow;
};

const log = createSubsystemLogger("embedded-run").child("rate-limit");
const WINDOW_ORDER: RateLimitWindow[] = ["second", "minute", "day", "month"];
const WINDOW_MS: Record<Exclude<RateLimitWindow, "day" | "month">, number> = {
  second: 1_000,
  minute: 60_000,
};
const WARN_COOLDOWN_MS = 30_000;
const DEFAULT_WARN_PERCENT = 70;
const DEFAULT_LIMITS: Record<RateLimitWindow, number | undefined> = {
  second: undefined,
  minute: 30_000,
  day: undefined,
  month: undefined,
};

const samplesByProvider = new Map<string, UsageSample[]>();
const observedLimitsByProvider = new Map<string, Map<RateLimitWindow, number>>();
const lastWarnAtByKey = new Map<string, number>();

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function resolveWarnPercent(): number {
  const parsed = parsePositiveInt(process.env.OPENCLAW_RATE_LIMIT_WARN_PERCENT);
  if (!parsed) {
    return DEFAULT_WARN_PERCENT;
  }
  return Math.max(1, Math.min(parsed, 99));
}

function resolveConfiguredLimit(window: RateLimitWindow): number | undefined {
  const envName =
    window === "second"
      ? "OPENCLAW_RATE_LIMIT_INPUT_PER_SECOND"
      : window === "minute"
        ? "OPENCLAW_RATE_LIMIT_INPUT_PER_MINUTE"
        : window === "day"
          ? "OPENCLAW_RATE_LIMIT_INPUT_PER_DAY"
          : "OPENCLAW_RATE_LIMIT_INPUT_PER_MONTH";
  return parsePositiveInt(process.env[envName]) ?? DEFAULT_LIMITS[window];
}

function resolveDayStartMs(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function resolveMonthStartMs(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function pruneProviderSamples(provider: string, nowMs: number): UsageSample[] {
  const existing = samplesByProvider.get(provider) ?? [];
  const monthStartMs = resolveMonthStartMs(nowMs);
  const pruned = existing.filter((sample) => sample.atMs >= monthStartMs);
  samplesByProvider.set(provider, pruned);
  return pruned;
}

function sumUsage(samples: UsageSample[], fromMs: number): number {
  let total = 0;
  for (const sample of samples) {
    if (sample.atMs >= fromMs) {
      total += sample.inputTokens;
    }
  }
  return total;
}

function parseRateLimitWindow(raw: string): RateLimitWindow | undefined {
  const lower = raw.toLowerCase();
  if (lower.includes("per second")) {
    return "second";
  }
  if (lower.includes("per minute")) {
    return "minute";
  }
  if (lower.includes("per day") || lower.includes("daily")) {
    return "day";
  }
  if (lower.includes("per month") || lower.includes("monthly")) {
    return "month";
  }
  return undefined;
}

function parseProviderRateLimitDetail(rawError: string): ParsedRateLimitDetail | undefined {
  if (!rawError) {
    return undefined;
  }
  const match = rawError.match(
    /rate limit of\s*([\d,]+)\s+([a-z ]+?)\s+per\s+(second|minute|day|month)/i,
  );
  if (!match) {
    return undefined;
  }
  const limit = Number.parseInt(match[1].replaceAll(",", ""), 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    return undefined;
  }
  const window = parseRateLimitWindow(`per ${match[3]}`);
  if (!window) {
    return undefined;
  }
  return {
    limit,
    unit: match[2].trim(),
    window,
  };
}

export const __rateLimitObserverForTests = {
  parseProviderRateLimitDetail,
  reset(): void {
    samplesByProvider.clear();
    observedLimitsByProvider.clear();
    lastWarnAtByKey.clear();
  },
};

function shouldWarn(key: string, nowMs: number): boolean {
  const last = lastWarnAtByKey.get(key);
  if (typeof last === "number" && nowMs - last < WARN_COOLDOWN_MS) {
    return false;
  }
  lastWarnAtByKey.set(key, nowMs);
  return true;
}

function resolveWindowLimit(provider: string, window: RateLimitWindow): number | undefined {
  const observed = observedLimitsByProvider.get(provider)?.get(window);
  return observed ?? resolveConfiguredLimit(window);
}

export function observeProviderRateLimitError(params: {
  provider: string;
  model: string;
  runId: string;
  rawError: string;
}): void {
  const detail = parseProviderRateLimitDetail(params.rawError);
  if (!detail) {
    return;
  }
  const byWindow =
    observedLimitsByProvider.get(params.provider) ?? new Map<RateLimitWindow, number>();
  byWindow.set(detail.window, detail.limit);
  observedLimitsByProvider.set(params.provider, byWindow);
  log.warn("provider rate-limit error detail", {
    event: "provider_rate_limit_detail",
    tags: ["rate_limit", "provider_detail"],
    provider: params.provider,
    model: params.model,
    runId: params.runId,
    limit: detail.limit,
    unit: detail.unit,
    window: detail.window,
    consoleMessage:
      `provider rate-limit detail: ${params.provider}/${params.model} ` +
      `window=${detail.window} limit=${detail.limit} unit="${detail.unit}"`,
  });
}

export function observeRateLimitUsage(params: {
  provider: string;
  model: string;
  runId: string;
  inputTokens: number | undefined;
}): void {
  const inputTokens = params.inputTokens ?? 0;
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) {
    return;
  }
  const nowMs = Date.now();
  const samples = pruneProviderSamples(params.provider, nowMs);
  samples.push({ atMs: nowMs, inputTokens });
  samplesByProvider.set(params.provider, samples);
  const warnPercent = resolveWarnPercent();

  for (const window of WINDOW_ORDER) {
    const limit = resolveWindowLimit(params.provider, window);
    if (!limit || limit <= 0) {
      continue;
    }
    const used =
      window === "second"
        ? sumUsage(samples, nowMs - WINDOW_MS.second)
        : window === "minute"
          ? sumUsage(samples, nowMs - WINDOW_MS.minute)
          : window === "day"
            ? sumUsage(samples, resolveDayStartMs(nowMs))
            : sumUsage(samples, resolveMonthStartMs(nowMs));
    const usedPercent = (used / limit) * 100;
    if (usedPercent < warnPercent || usedPercent >= 100) {
      continue;
    }
    const key = `${params.provider}:${window}`;
    if (!shouldWarn(key, nowMs)) {
      continue;
    }
    const remaining = Math.max(0, limit - used);
    log.warn("rate-limit approaching threshold", {
      event: "rate_limit_approaching",
      tags: ["rate_limit", "warning", "preemptive"],
      provider: params.provider,
      model: params.model,
      runId: params.runId,
      window,
      limitTokens: limit,
      usedTokens: used,
      remainingTokens: remaining,
      usedPercent: Math.round(usedPercent * 10) / 10,
      thresholdPercent: warnPercent,
      consoleMessage:
        `rate-limit warning: ${params.provider}/${params.model} window=${window} ` +
        `used=${used}/${limit} (${Math.round(usedPercent)}%) remaining=${remaining}`,
    });
  }
}
