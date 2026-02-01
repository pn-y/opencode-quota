import { readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";

export type CostBuckets = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
};

export type PricingSourceConfig = {
  pricingSource?: "bundled" | "network";
  pricingUrl?: string;
};

type Snapshot = {
  _meta: {
    source: string;
    generatedAt: number;
    providers: string[];
    units: string;
  };
  providers: Record<string, Record<string, CostBuckets>>;
};

let SNAPSHOT: Snapshot | null = null;
let REFRESH_IN_FLIGHT: Promise<void> | null = null;

const MODELSDEV_API_URL = "https://models.dev/api.json";
const MODELSDEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODELSDEV_REQUEST_TIMEOUT_MS = 8000;
const PROVIDER_ALLOWLIST = new Set(["anthropic", "google", "moonshotai", "openai", "zai"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!isRecord(value)) return false;
  const meta = value["_meta"];
  const providers = value["providers"];
  if (!isRecord(meta) || !isRecord(providers)) return false;
  if (typeof meta["source"] !== "string") return false;
  if (typeof meta["generatedAt"] !== "number") return false;
  if (!Array.isArray(meta["providers"])) return false;
  if (typeof meta["units"] !== "string") return false;
  return true;
}

function getCacheBaseDir(): string {
  const home = homedir();
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  }
  return process.env.XDG_CACHE_HOME || join(home, ".cache");
}

function getSnapshotCachePath(): string {
  return join(getCacheBaseDir(), "opencode-quota", "modelsdev-pricing.json");
}

function resolvePricingConfig(config?: PricingSourceConfig): {
  source: "bundled" | "network";
  url: string;
} {
  const source =
    config?.pricingSource === "bundled" || config?.pricingSource === "network"
      ? config.pricingSource
      : "network";

  const rawUrl = typeof config?.pricingUrl === "string" ? config.pricingUrl.trim() : "";
  if (rawUrl) {
    try {
      return { source, url: new URL(rawUrl).toString() };
    } catch {
      return { source, url: MODELSDEV_API_URL };
    }
  }

  return { source, url: MODELSDEV_API_URL };
}

function readSnapshotFromFile(pathOrUrl: string | URL): Snapshot | null {
  try {
    const raw = readFileSync(pathOrUrl, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isSnapshot(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function buildSnapshotFromApi(payload: unknown, sourceUrl: string): Snapshot | null {
  if (!isRecord(payload)) return null;

  const providers: Record<string, Record<string, CostBuckets>> = {};

  for (const [providerId, providerValue] of Object.entries(payload)) {
    if (!PROVIDER_ALLOWLIST.has(providerId)) continue;
    if (!isRecord(providerValue)) continue;
    const models = providerValue["models"];
    if (!isRecord(models)) continue;

    const modelCosts: Record<string, CostBuckets> = {};
    for (const [modelId, modelValue] of Object.entries(models)) {
      if (!isRecord(modelValue)) continue;
      const cost = modelValue["cost"];
      if (!isRecord(cost)) continue;

      const input = typeof cost["input"] === "number" ? cost["input"] : undefined;
      const output = typeof cost["output"] === "number" ? cost["output"] : undefined;
      if (input === undefined && output === undefined) continue;

      modelCosts[modelId] = { input, output };
    }

    if (Object.keys(modelCosts).length > 0) {
      providers[providerId] = modelCosts;
    }
  }

  const providerList = Object.keys(providers);
  if (providerList.length === 0) return null;

  return {
    _meta: {
      source: sourceUrl,
      generatedAt: Date.now(),
      providers: providerList,
      units: "USD per 1M tokens",
    },
    providers,
  };
}

function shouldRefresh(snapshot: Snapshot | null, sourceUrl: string): boolean {
  if (!snapshot) return true;
  if (typeof snapshot._meta.generatedAt !== "number") return true;
  if (snapshot._meta.source !== sourceUrl) return true;
  return Date.now() - snapshot._meta.generatedAt > MODELSDEV_CACHE_TTL_MS;
}

async function refreshSnapshotFromModelsDev(sourceUrl: string): Promise<void> {
  if (REFRESH_IN_FLIGHT) return REFRESH_IN_FLIGHT;

  REFRESH_IN_FLIGHT = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MODELSDEV_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(sourceUrl, { signal: controller.signal });
      if (!response.ok) return;
      const payload = (await response.json()) as unknown;
      const snapshot = buildSnapshotFromApi(payload, sourceUrl);
      if (!snapshot) return;
      const path = getSnapshotCachePath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(snapshot), "utf-8");
      SNAPSHOT = snapshot;
    } catch {
      // ignore refresh failures
    } finally {
      clearTimeout(timeoutId);
      REFRESH_IN_FLIGHT = null;
    }
  })();

  return REFRESH_IN_FLIGHT;
}

function ensureLoaded(): Snapshot {
  if (SNAPSHOT) return SNAPSHOT;

  const { source, url } = resolvePricingConfig();

  if (source === "bundled") {
    const bundledUrl = new URL("../data/modelsdev-pricing.min.json", import.meta.url);
    const bundled = readSnapshotFromFile(bundledUrl);
    SNAPSHOT =
      bundled ??
      ({
        _meta: {
          source: "(unknown)",
          generatedAt: 0,
          providers: [],
          units: "USD per 1M tokens",
        },
        providers: {},
      } satisfies Snapshot);
    return SNAPSHOT;
  }

  const cached = readSnapshotFromFile(getSnapshotCachePath());
  if (cached) {
    SNAPSHOT = cached;
  } else {
    const bundledUrl = new URL("../data/modelsdev-pricing.min.json", import.meta.url);
    const bundled = readSnapshotFromFile(bundledUrl);
    SNAPSHOT =
      bundled ??
      ({
        _meta: {
          source: "(unknown)",
          generatedAt: 0,
          providers: [],
          units: "USD per 1M tokens",
        },
        providers: {},
      } satisfies Snapshot);
  }

  if (shouldRefresh(SNAPSHOT, url)) {
    void refreshSnapshotFromModelsDev(url);
  }

  return SNAPSHOT;
}

export function getPricingSnapshotMeta(config?: PricingSourceConfig): Snapshot["_meta"] {
  return ensureLoadedWithConfig(config)._meta;
}

export function hasProvider(providerId: string, config?: PricingSourceConfig): boolean {
  return !!ensureLoadedWithConfig(config).providers[providerId];
}

export function getProviderModelCount(providerId: string, config?: PricingSourceConfig): number {
  return Object.keys(ensureLoadedWithConfig(config).providers[providerId] || {}).length;
}

export function listProviders(config?: PricingSourceConfig): string[] {
  return Object.keys(ensureLoadedWithConfig(config).providers);
}

export function lookupCost(
  providerId: string,
  modelId: string,
  config?: PricingSourceConfig,
): CostBuckets | null {
  const p = ensureLoadedWithConfig(config).providers[providerId];
  if (!p) return null;
  const c = p[modelId];
  if (!c) return null;
  return c;
}

function ensureLoadedWithConfig(config?: PricingSourceConfig): Snapshot {
  if (!config) return ensureLoaded();

  const { source, url } = resolvePricingConfig(config);

  if (source === "bundled") {
    const bundledUrl = new URL("../data/modelsdev-pricing.min.json", import.meta.url);
    const bundled = readSnapshotFromFile(bundledUrl);
    return (
      bundled ?? {
        _meta: {
          source: "(unknown)",
          generatedAt: 0,
          providers: [],
          units: "USD per 1M tokens",
        },
        providers: {},
      }
    );
  }

  const cached = readSnapshotFromFile(getSnapshotCachePath());
  if (cached) {
    if (shouldRefresh(cached, url)) {
      void refreshSnapshotFromModelsDev(url);
    }
    return cached;
  }

  const bundledUrl = new URL("../data/modelsdev-pricing.min.json", import.meta.url);
  const bundled = readSnapshotFromFile(bundledUrl);
  const fallback =
    bundled ??
    ({
      _meta: {
        source: "(unknown)",
        generatedAt: 0,
        providers: [],
        units: "USD per 1M tokens",
      },
      providers: {},
    } satisfies Snapshot);

  if (shouldRefresh(fallback, url)) {
    void refreshSnapshotFromModelsDev(url);
  }

  return fallback;
}
