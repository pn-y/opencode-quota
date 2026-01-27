/**
 * Firmware API key configuration resolver
 *
 * Resolution priority (first wins):
 * 1. Environment variable: FIRMWARE_AI_API_KEY or FIRMWARE_API_KEY
 * 2. opencode.json/opencode.jsonc: provider.firmware.options.apiKey
 *    - Supports {env:VAR_NAME} syntax for environment variable references
 * 3. auth.json: firmware.key (legacy/fallback)
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { readAuthFile } from "./opencode-auth.js";

/** Result of firmware API key resolution */
export interface FirmwareApiKeyResult {
  key: string;
  source: FirmwareKeySource;
}

/** Source of the resolved API key */
export type FirmwareKeySource =
  | "env:FIRMWARE_AI_API_KEY"
  | "env:FIRMWARE_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

/**
 * Strip JSONC comments (// and /* ... *​/) from a string.
 * This is a simple implementation that handles common cases.
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
        // Skip until end of line
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
        i += 2; // Skip closing */
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Parse JSON or JSONC content
 */
function parseJsonOrJsonc(content: string, isJsonc: boolean): unknown {
  const toParse = isJsonc ? stripJsonComments(content) : content;
  return JSON.parse(toParse);
}

/**
 * Resolve {env:VAR_NAME} syntax in a string value
 */
function resolveEnvTemplate(value: string): string | null {
  const match = value.match(/^\{env:([^}]+)\}$/);
  if (!match) return value;

  const envVar = match[1];
  const envValue = process.env[envVar];
  return envValue && envValue.trim().length > 0 ? envValue.trim() : null;
}

/**
 * Extract firmware API key from opencode config object
 *
 * Looks for: provider.firmware.options.apiKey
 */
function extractFirmwareKeyFromConfig(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;

  const root = config as Record<string, unknown>;
  const provider = root.provider;
  if (!provider || typeof provider !== "object") return null;

  const firmware = (provider as Record<string, unknown>).firmware;
  if (!firmware || typeof firmware !== "object") return null;

  const options = (firmware as Record<string, unknown>).options;
  if (!options || typeof options !== "object") return null;

  const apiKey = (options as Record<string, unknown>).apiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) return null;

  // Resolve {env:VAR_NAME} syntax
  return resolveEnvTemplate(apiKey.trim());
}

/**
 * Get candidate paths for opencode.json/opencode.jsonc files
 */
export function getOpencodeConfigCandidatePaths(): Array<{ path: string; isJsonc: boolean }> {
  const cwd = process.cwd();
  const configBaseDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

  // Order: local overrides first, then global fallback
  // Check both .json and .jsonc variants
  return [
    { path: join(cwd, "opencode.jsonc"), isJsonc: true },
    { path: join(cwd, "opencode.json"), isJsonc: false },
    { path: join(configBaseDir, "opencode", "opencode.jsonc"), isJsonc: true },
    { path: join(configBaseDir, "opencode", "opencode.json"), isJsonc: false },
  ];
}

/**
 * Read and parse opencode config file
 */
async function readOpencodeConfig(
  filePath: string,
  isJsonc: boolean,
): Promise<{ config: unknown; path: string; isJsonc: boolean } | null> {
  try {
    if (!existsSync(filePath)) return null;
    const content = await readFile(filePath, "utf-8");
    const config = parseJsonOrJsonc(content, isJsonc);
    return { config, path: filePath, isJsonc };
  } catch {
    return null;
  }
}

/**
 * Resolve Firmware API key from all available sources.
 *
 * Priority (first wins):
 * 1. Environment variable: FIRMWARE_AI_API_KEY or FIRMWARE_API_KEY
 * 2. opencode.json/opencode.jsonc: provider.firmware.options.apiKey
 * 3. auth.json: firmware.key
 *
 * @returns API key and source, or null if not found
 */
export async function resolveFirmwareApiKey(): Promise<FirmwareApiKeyResult | null> {
  // 1. Check environment variables (highest priority)
  const envKey1 = process.env.FIRMWARE_AI_API_KEY?.trim();
  if (envKey1 && envKey1.length > 0) {
    return { key: envKey1, source: "env:FIRMWARE_AI_API_KEY" };
  }

  const envKey2 = process.env.FIRMWARE_API_KEY?.trim();
  if (envKey2 && envKey2.length > 0) {
    return { key: envKey2, source: "env:FIRMWARE_API_KEY" };
  }

  // 2. Check opencode.json/opencode.jsonc files
  const candidates = getOpencodeConfigCandidatePaths();
  for (const candidate of candidates) {
    const result = await readOpencodeConfig(candidate.path, candidate.isJsonc);
    if (!result) continue;

    const key = extractFirmwareKeyFromConfig(result.config);
    if (key) {
      return {
        key,
        source: result.isJsonc ? "opencode.jsonc" : "opencode.json",
      };
    }
  }

  // 3. Fallback to auth.json
  const auth = await readAuthFile();
  const fw = auth?.firmware;
  if (fw && fw.type === "api" && fw.key && fw.key.trim().length > 0) {
    return { key: fw.key.trim(), source: "auth.json" };
  }

  return null;
}

/**
 * Check if a Firmware API key is configured in any source
 */
export async function hasFirmwareApiKey(): Promise<boolean> {
  const result = await resolveFirmwareApiKey();
  return result !== null;
}

/**
 * Get diagnostic info about firmware API key configuration
 */
export async function getFirmwareKeyDiagnostics(): Promise<{
  configured: boolean;
  source: FirmwareKeySource | null;
  checkedPaths: string[];
}> {
  const checkedPaths: string[] = [];

  // Track env vars checked
  if (process.env.FIRMWARE_AI_API_KEY !== undefined) {
    checkedPaths.push("env:FIRMWARE_AI_API_KEY");
  }
  if (process.env.FIRMWARE_API_KEY !== undefined) {
    checkedPaths.push("env:FIRMWARE_API_KEY");
  }

  // Track config files checked
  const candidates = getOpencodeConfigCandidatePaths();
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      checkedPaths.push(candidate.path);
    }
  }

  const result = await resolveFirmwareApiKey();

  return {
    configured: result !== null,
    source: result?.source ?? null,
    checkedPaths,
  };
}
