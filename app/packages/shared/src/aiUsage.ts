// AI usage, models and limits (migration 0138, Elise 2026-11-14).
//
// Every call OBI makes to Claude belongs to one FEATURE (the assistant, the AI
// quote draft, Improve on a message). Dashboard › AI usage picks the model each
// feature runs on, how many times one person may use it a day and how much
// it may spend in a month, and shows what each feature and each person cost.
// Since the same day it is a tab of the Dashboard, for super admins only
// (Elise: the rest do not see it until it is finished).
//
// Pure: the API and the browser share these figures, so the page and the
// refusal sentences say the same thing.

export const AI_FEATURES = ['assistant', 'quote_draft', 'message_improve'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
  assistant: 'Assistant',
  quote_draft: 'AI quote draft',
  message_improve: 'Improve message',
};

export const AI_FEATURE_DESCRIPTIONS: Record<AiFeature, string> = {
  assistant: 'Answers questions about OBI and its records (the sparkle button in the top bar). One use = one question.',
  quote_draft: 'Drafts a quote from a call transcript (Tech Hub › Technician calls, Import transcript). One use = one draft.',
  message_improve: 'Rewrites a message before it is posted (Improve on the Messages tab). One use = one suggestion.',
};

export function isAiFeature(v: unknown): v is AiFeature {
  return typeof v === 'string' && (AI_FEATURES as readonly string[]).includes(v);
}

// ── Models ───────────────────────────────────────────────────────────────────

export interface AiModelInfo {
  id: string;
  label: string;
  /** US dollars per million tokens (Anthropic's first-party API rates). */
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** Haiku 5.5 bills a request whose prompt is above this many tokens at
      `long_input` / `long_output` instead. */
  long_context_over?: number;
  long_input?: number;
  long_output?: number;
  /** Takes `output_config.effort` (Haiku 4.5 refuses it). */
  effort: boolean;
  /** Takes the server-side refusal fallback (`fallbacks: "default"`). */
  fallback: boolean;
  hint: string;
}

/** The models an administrator may pick, cheapest first. Prices as published
    by Anthropic (cached 2026-10-06); cache writes are 1.25 × input (5-minute
    cache). Change a price here and every cost from then on uses it — rows
    already recorded keep the figure they were stored with. */
export const AI_MODELS: AiModelInfo[] = [
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    input: 0.1,
    output: 0.5,
    cache_read: 0.01,
    cache_write: 0.125,
    long_context_over: 100_000,
    long_input: 0.5,
    long_output: 2.5,
    effort: true,
    fallback: false,
    hint: 'Fastest and cheapest. Plenty for polishing or shortening a message.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    input: 1,
    output: 5,
    cache_read: 0.1,
    cache_write: 1.25,
    effort: false,
    fallback: false,
    hint: 'The previous Haiku. Ten times the price of Haiku 5.5.',
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    input: 2,
    output: 10,
    cache_read: 0.2,
    cache_write: 2.5,
    effort: true,
    fallback: true,
    hint: 'Better wording and judgement, a few times the cost of Haiku.',
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    input: 4,
    output: 20,
    cache_read: 0.2,
    cache_write: 5,
    effort: true,
    fallback: true,
    hint: 'The most capable and the most expensive.',
  },
];

export const AI_MODEL_IDS = AI_MODELS.map((m) => m.id);

export function aiModelInfo(id: string | null | undefined): AiModelInfo | null {
  if (!id) return null;
  // A response names the model it ran on, sometimes with a date suffix.
  return AI_MODELS.find((m) => id === m.id || id.startsWith(`${m.id}-`)) ?? null;
}

export function aiModelLabel(id: string | null | undefined): string {
  return aiModelInfo(id)?.label ?? id ?? '—';
}

/** Used for a feature nobody has set in Dashboard › AI usage. The API's own
    defaults (env QUOTE_AI_MODEL / ASSISTANT_AI_MODEL) win over these for the
    two features that had one. */
export const AI_DEFAULT_MODEL: Record<AiFeature, string> = {
  assistant: 'claude-opus-5-5',
  quote_draft: 'claude-haiku-4-5',
  message_improve: 'claude-haiku-5-5',
};

/** Uses per person per Chicago day when nobody has set a limit. */
export const AI_DEFAULT_DAILY_LIMIT: Record<AiFeature, number> = {
  assistant: 100,
  quote_draft: 30,
  message_improve: 100,
};

export const AI_DAILY_LIMIT_MAX = 10_000;
export const AI_MONTHLY_BUDGET_MAX = 100_000;

// ── Cost ─────────────────────────────────────────────────────────────────────

export interface AiTokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * What ONE model response cost in US dollars. An unknown model costs 0 and
 * the row says so (`model` is kept), rather than guessing a price.
 * Sum responses one by one: Haiku 5.5's long-context price is decided per
 * request, so a total over several requests would price them wrongly.
 */
export function aiCostUsd(model: string | null | undefined, usage: AiTokenUsage | null | undefined): number {
  const m = aiModelInfo(model);
  if (!m || !usage) return 0;
  const input = n(usage.input_tokens);
  const output = n(usage.output_tokens);
  const read = n(usage.cache_read_input_tokens);
  const write = n(usage.cache_creation_input_tokens);
  const long = m.long_context_over !== undefined && input + read + write > m.long_context_over;
  const inRate = long && m.long_input !== undefined ? m.long_input : m.input;
  const outRate = long && m.long_output !== undefined ? m.long_output : m.output;
  const scale = inRate / m.input; // cache prices follow the input price
  const usd =
    (input * inRate + output * outRate + read * m.cache_read * scale + write * m.cache_write * scale) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** "$0.0031", "$1.24", "$1,204" — small figures keep enough digits to read. */
export function formatUsd(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '$0.00';
  const abs = Math.abs(v);
  if (abs < 0.01) return `$${v.toFixed(4)}`;
  if (abs < 1000) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

// ── Settings and limits ──────────────────────────────────────────────────────

export interface AiFeatureSetting {
  feature: AiFeature;
  model: string;
  /** Uses per person per Chicago day; null = no limit. */
  daily_limit: number | null;
  /** US dollars per calendar month (Chicago) for the whole team; null = none. */
  monthly_budget_usd: number | null;
}

export interface AiFeatureSettingView extends AiFeatureSetting {
  label: string;
  description: string;
  updated_by: { id: string; name: string } | null;
  updated_at: string | null;
}

export interface AiSettingInput {
  model: string;
  daily_limit: number | null;
  monthly_budget_usd: number | null;
}

/** Why a setting cannot be saved, or null. */
export function aiSettingProblem(input: AiSettingInput): string | null {
  if (!AI_MODEL_IDS.includes(input.model)) return `Pick one of: ${AI_MODELS.map((m) => m.label).join(', ')}`;
  if (input.daily_limit !== null && (!Number.isInteger(input.daily_limit) || input.daily_limit < 0 || input.daily_limit > AI_DAILY_LIMIT_MAX)) {
    return `The daily limit is a whole number from 0 to ${AI_DAILY_LIMIT_MAX.toLocaleString('en-US')}, or blank for no limit`;
  }
  if (
    input.monthly_budget_usd !== null &&
    (!Number.isFinite(input.monthly_budget_usd) || input.monthly_budget_usd < 0 || input.monthly_budget_usd > AI_MONTHLY_BUDGET_MAX)
  ) {
    return `The monthly budget is from $0 to $${AI_MONTHLY_BUDGET_MAX.toLocaleString('en-US')}, or blank for none`;
  }
  return null;
}

export const AI_DAILY_LIMIT_CODE = 'AI_DAILY_LIMIT';
export const AI_BUDGET_CODE = 'AI_MONTHLY_BUDGET';
export const AI_OFF_CODE = 'AI_OFF';

export function aiDailyLimitSentence(feature: AiFeature, limit: number): string {
  if (limit === 0) return `${AI_FEATURE_LABELS[feature]} is switched off for everyone (daily limit 0 in Dashboard › AI usage).`;
  const unit = feature === 'assistant' ? 'questions' : feature === 'quote_draft' ? 'drafts' : 'suggestions';
  return `You have used ${limit} ${AI_FEATURE_LABELS[feature]} ${unit} today, which is the daily limit. It resets at midnight (Central).`;
}

export function aiBudgetSentence(feature: AiFeature, budget: number): string {
  return `${AI_FEATURE_LABELS[feature]} has reached its monthly budget of ${formatUsd(budget)}. A super admin can raise it in Dashboard › AI usage; otherwise it comes back on the 1st.`;
}

// ── The usage report ─────────────────────────────────────────────────────────

export const AI_USAGE_PERIODS = ['today', 'month', 'last_month', '30d'] as const;
export type AiUsagePeriod = (typeof AI_USAGE_PERIODS)[number];
export const AI_USAGE_PERIOD_LABELS: Record<AiUsagePeriod, string> = {
  today: 'Today',
  month: 'This month',
  last_month: 'Last month',
  '30d': 'Last 30 days',
};

export interface AiFeatureUsage {
  feature: AiFeature;
  calls: number;
  errors: number;
  cost_usd: number;
  people: number;
  /** This calendar month, whatever the period: what the budget is measured on. */
  month_cost_usd: number;
}

export interface AiPersonUsage {
  principal_id: string;
  name: string;
  role_label: string | null;
  calls: number;
  cost_usd: number;
  by_feature: Partial<Record<AiFeature, { calls: number; cost_usd: number }>>;
  /** Uses today per feature, to set beside the daily limit. */
  today: Partial<Record<AiFeature, number>>;
  /** Days in the period on which they reached a feature's daily limit. */
  limit_days: number;
  last_at: string | null;
}

export interface AiUsageDay {
  day: string; // YYYY-MM-DD, Chicago
  calls: number;
  cost_usd: number;
}

export interface AiUsageResponse {
  period: AiUsagePeriod;
  from: string;
  to: string;
  totals: { calls: number; cost_usd: number; people: number };
  features: AiFeatureUsage[];
  people: AiPersonUsage[];
  days: AiUsageDay[];
  settings: AiFeatureSettingView[];
  models: AiModelInfo[];
  /** The first recorded use, or null — tracking starts with 0138. */
  tracking_since: string | null;
  configured: boolean;
  can_edit: boolean;
}

/**
 * Why a person's use stands out, or null. Reaching a daily limit is the plain
 * signal; besides that, one person spending three times the team's median
 * (with at least three people using AI and over a dollar spent by them).
 */
export function aiHeavyUseReason(person: AiPersonUsage, everyone: AiPersonUsage[]): string | null {
  if (person.limit_days > 0) return person.limit_days === 1 ? 'Reached a daily limit once' : `Reached a daily limit on ${person.limit_days} days`;
  if (everyone.length < 3 || person.cost_usd < 1) return null;
  const costs = everyone.map((p) => p.cost_usd).sort((a, b) => a - b);
  const mid = Math.floor(costs.length / 2);
  const median = costs.length % 2 ? costs[mid] : (costs[mid - 1] + costs[mid]) / 2;
  if (median > 0 && person.cost_usd >= median * 3) return `${Math.round(person.cost_usd / median)}× the team’s median`;
  return null;
}

// ── What the browser asks before drawing an AI button ────────────────────────

export interface AiFeatureState {
  available: boolean;
  /** Why not, in a sentence the button's title can carry. */
  reason: string | null;
  /** AI_OFF (switched off / no key: the button is not drawn), AI_DAILY_LIMIT
      or AI_MONTHLY_BUDGET (drawn locked with the reason); null when available. */
  code: string | null;
  daily_limit: number | null;
  used_today: number;
}

export type AiStatusResponse = Record<AiFeature, AiFeatureState>;

// ── Improve message ──────────────────────────────────────────────────────────

export const AI_IMPROVE_MODES = ['polish', 'formal', 'shorter', 'friendlier', 'custom'] as const;
export type AiImproveMode = (typeof AI_IMPROVE_MODES)[number];
export const AI_IMPROVE_MODE_LABELS: Record<AiImproveMode, string> = {
  polish: 'Polish',
  formal: 'More formal',
  shorter: 'Shorter',
  friendlier: 'Friendlier',
  custom: 'Custom…',
};
export const AI_IMPROVE_INSTRUCTION_MAX = 300;

export interface AiImproveInput {
  body: string;
  mode: AiImproveMode;
  instruction?: string;
  client_visible: boolean;
}

export interface AiImproveResponse {
  text: string;
  model: string;
}
