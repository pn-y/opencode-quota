/**
 * Normalized quota output model.
 *
 * Providers should map their internal quota shapes into these types so that
 * formatting and toast display stays universal across providers.
 */

export interface QuotaToastEntry {
  /**
   * Display label (already human-friendly), e.g. "Copilot" or "Claude (abc..gmail)".
   */
  name: string;

  /** Remaining quota as a percentage [0..100]. */
  percentRemaining: number;

  /** Optional ISO reset timestamp (shown only when percentRemaining is 0). */
  resetTimeIso?: string;
}

export interface QuotaToastError {
  /** Short label that will be rendered as "label: message". */
  label: string;
  message: string;
}

/** Per-model token summary for current session (toast display). */
export interface SessionTokenModel {
  modelID: string;
  input: number;
  output: number;
}

/** Session tokens data for toast display. */
export interface SessionTokensData {
  models: SessionTokenModel[];
  totalInput: number;
  totalOutput: number;
}

export interface QuotaProviderResult {
  /** True when provider had enough configuration to attempt a query. */
  attempted: boolean;
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
}

export interface QuotaProviderContext {
  client: {
    config: {
      providers: () => Promise<{ data?: { providers: Array<{ id: string }> } }>;
      get: () => Promise<{ data?: { model?: string } }>;
    };
  };
  config: {
    googleModels: string[];
    toastStyle?: "classic" | "grouped";
  };
}

export interface QuotaProvider {
  /** Stable id used by config.enabledProviders */
  id: string;

  /** Best-effort availability check (no network if possible) */
  isAvailable: (ctx: QuotaProviderContext) => Promise<boolean>;

  /** Fetch and normalize quota for this provider */
  fetch: (ctx: QuotaProviderContext) => Promise<QuotaProviderResult>;

  /** Optional provider match for onlyCurrentModel filtering */
  matchesCurrentModel?: (model: string) => boolean;
}
