/**
 * Configuration loader for opencode-quota plugin
 *
 * Primary: reads configuration from OpenCode's merged config via the SDK client.
 * Fallback: reads local config files directly.
 */

import type { QuotaToastConfig, GoogleModelId } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export interface LoadConfigMeta {
  source: "sdk" | "files" | "defaults";
  paths: string[];
}

export function createLoadConfigMeta(): LoadConfigMeta {
  return { source: "defaults", paths: [] };
}

/**
 * Validates and normalizes a Google model ID
 */
function isValidGoogleModelId(id: unknown): id is GoogleModelId {
  return typeof id === "string" && ["G3PRO", "G3FLASH", "CLAUDE", "G3IMAGE"].includes(id);
}

/**
 * Load plugin configuration from OpenCode config
 *
 * @param client - OpenCode SDK client
 * @returns Merged configuration with defaults
 */
export async function loadConfig(
  client: {
    config: {
      get: () => Promise<{ data?: { experimental?: { quotaToast?: Partial<QuotaToastConfig> } } }>;
    };
  },
  meta?: LoadConfigMeta,
): Promise<QuotaToastConfig> {
  function normalize(
    quotaToastConfig: Partial<QuotaToastConfig> | undefined | null,
  ): QuotaToastConfig {
    if (!quotaToastConfig) return DEFAULT_CONFIG;

    const config: QuotaToastConfig = {
      enabled:
        typeof quotaToastConfig.enabled === "boolean"
          ? quotaToastConfig.enabled
          : DEFAULT_CONFIG.enabled,

      enableToast:
        typeof quotaToastConfig.enableToast === "boolean"
          ? quotaToastConfig.enableToast
          : DEFAULT_CONFIG.enableToast,

      toastStyle:
        quotaToastConfig.toastStyle === "grouped" || quotaToastConfig.toastStyle === "classic"
          ? quotaToastConfig.toastStyle
          : DEFAULT_CONFIG.toastStyle,
      minIntervalMs:
        typeof quotaToastConfig.minIntervalMs === "number" && quotaToastConfig.minIntervalMs > 0
          ? quotaToastConfig.minIntervalMs
          : DEFAULT_CONFIG.minIntervalMs,

      debug:
        typeof quotaToastConfig.debug === "boolean" ? quotaToastConfig.debug : DEFAULT_CONFIG.debug,

      enabledProviders: Array.isArray(quotaToastConfig.enabledProviders)
        ? quotaToastConfig.enabledProviders.filter((p) => typeof p === "string")
        : DEFAULT_CONFIG.enabledProviders,
      googleModels: Array.isArray(quotaToastConfig.googleModels)
        ? quotaToastConfig.googleModels.filter(isValidGoogleModelId)
        : DEFAULT_CONFIG.googleModels,
      showOnIdle:
        typeof quotaToastConfig.showOnIdle === "boolean"
          ? quotaToastConfig.showOnIdle
          : DEFAULT_CONFIG.showOnIdle,
      showOnQuestion:
        typeof quotaToastConfig.showOnQuestion === "boolean"
          ? quotaToastConfig.showOnQuestion
          : DEFAULT_CONFIG.showOnQuestion,
      showOnCompact:
        typeof quotaToastConfig.showOnCompact === "boolean"
          ? quotaToastConfig.showOnCompact
          : DEFAULT_CONFIG.showOnCompact,
      showOnBothFail:
        typeof quotaToastConfig.showOnBothFail === "boolean"
          ? quotaToastConfig.showOnBothFail
          : DEFAULT_CONFIG.showOnBothFail,
      toastDurationMs:
        typeof quotaToastConfig.toastDurationMs === "number" && quotaToastConfig.toastDurationMs > 0
          ? quotaToastConfig.toastDurationMs
          : DEFAULT_CONFIG.toastDurationMs,
      onlyCurrentModel:
        typeof quotaToastConfig.onlyCurrentModel === "boolean"
          ? quotaToastConfig.onlyCurrentModel
          : DEFAULT_CONFIG.onlyCurrentModel,
      showSessionTokens:
        typeof quotaToastConfig.showSessionTokens === "boolean"
          ? quotaToastConfig.showSessionTokens
          : DEFAULT_CONFIG.showSessionTokens,
      pricingSource:
        quotaToastConfig.pricingSource === "bundled" || quotaToastConfig.pricingSource === "network"
          ? quotaToastConfig.pricingSource
          : DEFAULT_CONFIG.pricingSource,
      pricingUrl:
        typeof quotaToastConfig.pricingUrl === "string" && quotaToastConfig.pricingUrl.trim()
          ? quotaToastConfig.pricingUrl
          : DEFAULT_CONFIG.pricingUrl,
      layout: {
        maxWidth:
          typeof quotaToastConfig.layout?.maxWidth === "number" &&
          quotaToastConfig.layout.maxWidth > 0
            ? quotaToastConfig.layout.maxWidth
            : DEFAULT_CONFIG.layout.maxWidth,
        narrowAt:
          typeof quotaToastConfig.layout?.narrowAt === "number" &&
          quotaToastConfig.layout.narrowAt > 0
            ? quotaToastConfig.layout.narrowAt
            : DEFAULT_CONFIG.layout.narrowAt,
        tinyAt:
          typeof quotaToastConfig.layout?.tinyAt === "number" && quotaToastConfig.layout.tinyAt > 0
            ? quotaToastConfig.layout.tinyAt
            : DEFAULT_CONFIG.layout.tinyAt,
      },
    };

    // enabledProviders is intentionally allowed to be empty (providers OFF by default).

    // Ensure at least one Google model is configured
    if (config.googleModels.length === 0) {
      config.googleModels = DEFAULT_CONFIG.googleModels;
    }

    return config;
  }

  /**
   * Strip JSONC comments (// and /* ... *​/) from a string.
   */
  function stripJsonComments(content: string): string {
    let result = "";
    let i = 0;
    let inString = false;
    let stringChar = "";

    while (i < content.length) {
      const char = content[i];
      const nextChar = content[i + 1];

      // Handle string boundaries
      if ((char === '"' || char === "'") && (i === 0 || content[i - 1] !== "\\")) {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
        }
        result += char;
        i++;
        continue;
      }

      // Skip comments only when not in a string
      if (!inString) {
        // Single-line comment
        if (char === "/" && nextChar === "/") {
          while (i < content.length && content[i] !== "\n") {
            i++;
          }
          continue;
        }

        // Multi-line comment
        if (char === "/" && nextChar === "*") {
          i += 2;
          while (i < content.length - 1 && !(content[i] === "*" && content[i + 1] === "/")) {
            i++;
          }
          i += 2;
          continue;
        }
      }

      result += char;
      i++;
    }

    return result;
  }

  async function readJson(path: string): Promise<unknown | null> {
    try {
      const content = await readFile(path, "utf-8");
      // Support JSONC (JSON with comments) for .jsonc files
      const isJsonc = path.endsWith(".jsonc");
      const toParse = isJsonc ? stripJsonComments(content) : content;
      return JSON.parse(toParse) as unknown;
    } catch {
      return null;
    }
  }

  async function loadFromFiles(): Promise<QuotaToastConfig> {
    const cwd = process.cwd();
    const configBaseDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

    // Order: global first, then local overrides.
    // Check both .jsonc and .json variants (jsonc takes precedence within each location).
    const candidates = [
      join(configBaseDir, "opencode", "opencode.jsonc"),
      join(configBaseDir, "opencode", "opencode.json"),
      join(cwd, "opencode.jsonc"),
      join(cwd, "opencode.json"),
    ];

    const quota: Partial<QuotaToastConfig> = {};
    const usedPaths: string[] = [];

    for (const p of candidates) {
      if (!existsSync(p)) continue;
      const parsed = await readJson(p);
      if (!parsed || typeof parsed !== "object") continue;

      const root = parsed as any;

      const picks: Array<{ key: string; value: unknown }> = [
        { key: "experimental.quotaToast", value: root?.experimental?.quotaToast },
      ];

      const usedKeys: string[] = [];
      for (const pick of picks) {
        if (!pick.value || typeof pick.value !== "object") continue;
        Object.assign(quota, pick.value);
        usedKeys.push(pick.key);
      }

      if (usedKeys.length > 0) {
        usedPaths.push(`${p} (${usedKeys.join(", ")})`);
      }
    }

    if (meta) {
      meta.source = usedPaths.length > 0 ? "files" : "defaults";
      meta.paths = usedPaths;
    }

    return normalize(Object.keys(quota).length > 0 ? quota : null);
  }

  try {
    const response = await client.config.get();

    // OpenCode config schema is strict; plugin-specific config must live under
    // experimental.* to avoid "unrecognized key" validation errors.
    const quotaToastConfig = (response.data as any)?.experimental?.quotaToast as
      | Partial<QuotaToastConfig>
      | undefined;

    if (quotaToastConfig && typeof quotaToastConfig === "object") {
      if (meta) {
        meta.source = "sdk";
        meta.paths = ["client.config.get"];
      }
      return normalize(quotaToastConfig);
    }

    return await loadFromFiles();
  } catch {
    return await loadFromFiles();
  }
}
