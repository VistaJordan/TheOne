// 0138 · AI usage, models and limits (Elise, 2026-11-14).
//
// Three halves, one per question an AI feature asks before and after it calls
// Claude:
//   - WHICH MODEL, and may this person use it now? `aiGate(feature, id)` reads
//     the feature's `ai_setting` row (a feature nobody set falls back to the
//     env default it always had), then refuses — 409 with `details.code` —
//     when the Claude switch is off, the key is unset, the person has used up
//     today's limit or the team has spent the month's budget.
//   - WHAT IT COST: `recordAiUse` writes one `ai_usage` row per use, the cost
//     summed response by response at the price on file (shared `aiCostUsd`).
//     It never throws: a failed write must not fail the answer.
//   - THE PAGE: the Dashboard's AI usage tab, super admins only (Elise
//     2026-11-14: nobody else sees it until it is finished), reads the totals
//     per feature and per person and saves the settings (audited as
//     `ai_setting_updated`).
//
// A refused use writes no row, so it neither costs nor counts.

import {
  AI_BUDGET_CODE,
  AI_DAILY_LIMIT_CODE,
  AI_DEFAULT_DAILY_LIMIT,
  AI_DEFAULT_MODEL,
  AI_FEATURES,
  AI_FEATURE_DESCRIPTIONS,
  AI_FEATURE_LABELS,
  AI_MODELS,
  AI_OFF_CODE,
  aiBudgetSentence,
  aiCostUsd,
  aiDailyLimitSentence,
  aiSettingProblem,
  type AiFeature,
  type AiFeatureSetting,
  type AiFeatureSettingView,
  type AiFeatureUsage,
  type AiPersonUsage,
  type AiSettingInput,
  type AiStatusResponse,
  type AiTokenUsage,
  type AiUsageDay,
  type AiUsagePeriod,
  type AiUsageResponse,
} from '@theone/shared';
import { config } from '../config.js';
import { query } from '../db.js';
import { ApiError, conflict } from '../errors.js';
import { logAdminEvent } from './adminAudit.js';
import { integrationOn } from './integrations.js';
import type { PermissionBearer } from './permissions.js';

const TZ = `'America/Chicago'`;

type Admin = PermissionBearer & { id: string };

/** The page is a super admin's (the person whose rights count: the viewed
    person while viewing as, so viewing as a dispatcher shows what they see). */
function requireSuperAdmin(user: Admin): void {
  if (!user.isSuperAdmin) throw new ApiError('FORBIDDEN', 'AI usage is open to super admins only for now');
}

// ── Settings ─────────────────────────────────────────────────────────────────

/** What a feature runs on when nobody has saved a row for it. The two
    features that had an env setting keep it (QUOTE_AI_MODEL,
    ASSISTANT_AI_MODEL, ASSISTANT_DAILY_LIMIT). */
export function aiDefaults(feature: AiFeature): AiFeatureSetting {
  if (feature === 'assistant') {
    return { feature, model: config.assistant.model, daily_limit: config.assistant.dailyLimit, monthly_budget_usd: null };
  }
  if (feature === 'quote_draft') {
    return { feature, model: config.quoteAiModel, daily_limit: AI_DEFAULT_DAILY_LIMIT.quote_draft, monthly_budget_usd: null };
  }
  return { feature, model: AI_DEFAULT_MODEL[feature], daily_limit: AI_DEFAULT_DAILY_LIMIT[feature], monthly_budget_usd: null };
}

type SettingRow = {
  feature: AiFeature;
  model: string;
  daily_limit: number | null;
  monthly_budget_usd: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_at: Date;
};

async function settingRows(): Promise<Map<AiFeature, SettingRow>> {
  const res = await query<SettingRow>(
    `SELECT s.feature, s.model, s.daily_limit, s.monthly_budget_usd::text AS monthly_budget_usd,
            s.updated_by::text AS updated_by, p.display_name AS updated_by_name, s.updated_at
       FROM ai_setting s LEFT JOIN principal p ON p.id = s.updated_by`,
  );
  return new Map(res.rows.map((r) => [r.feature, r]));
}

function fromRow(feature: AiFeature, row: SettingRow | undefined): AiFeatureSetting {
  if (!row) return aiDefaults(feature);
  return {
    feature,
    model: row.model,
    daily_limit: row.daily_limit,
    monthly_budget_usd: row.monthly_budget_usd === null ? null : Number(row.monthly_budget_usd),
  };
}

/** The feature's setting now. Before 0138 has run the defaults stand. */
export async function aiSettingFor(feature: AiFeature): Promise<AiFeatureSetting> {
  try {
    const res = await query<SettingRow>(
      `SELECT feature, model, daily_limit, monthly_budget_usd::text AS monthly_budget_usd FROM ai_setting WHERE feature = $1`,
      [feature],
    );
    return fromRow(feature, res.rows[0]);
  } catch {
    return aiDefaults(feature);
  }
}

// ── The gate ─────────────────────────────────────────────────────────────────

const TODAY_SQL = `(created_at AT TIME ZONE ${TZ})::date = (now() AT TIME ZONE ${TZ})::date`;
const THIS_MONTH_SQL = `date_trunc('month', created_at AT TIME ZONE ${TZ}) = date_trunc('month', now() AT TIME ZONE ${TZ})`;

export async function aiUsedToday(feature: AiFeature, principalId: string): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ai_usage WHERE feature = $1 AND principal_id = $2 AND ${TODAY_SQL}`,
    [feature, principalId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

async function spentThisMonth(feature: AiFeature): Promise<number> {
  const res = await query<{ usd: string | null }>(
    `SELECT sum(cost_usd)::text AS usd FROM ai_usage WHERE feature = $1 AND ${THIS_MONTH_SQL}`,
    [feature],
  );
  return Number(res.rows[0]?.usd ?? 0);
}

/** Why the feature cannot be used right now (switch, key, budget), before
    looking at the person. Null = it can. */
async function featureClosed(feature: AiFeature, setting: AiFeatureSetting): Promise<{ code: string; message: string } | null> {
  if (!integrationOn('claude')) {
    return { code: AI_OFF_CODE, message: 'Claude is switched off in Admin › Integrations' };
  }
  if (!config.anthropicApiKey) {
    return { code: AI_OFF_CODE, message: 'AI is not set up on this server (ANTHROPIC_API_KEY is unset)' };
  }
  if (setting.daily_limit === 0) {
    return { code: AI_DAILY_LIMIT_CODE, message: aiDailyLimitSentence(feature, 0) };
  }
  if (setting.monthly_budget_usd !== null && (await spentThisMonth(feature)) >= setting.monthly_budget_usd) {
    return { code: AI_BUDGET_CODE, message: aiBudgetSentence(feature, setting.monthly_budget_usd) };
  }
  return null;
}

/**
 * Ask before calling Claude. Returns the setting (the model to use); throws a
 * 409 `CONFLICT` with `details.code` = AI_OFF / AI_DAILY_LIMIT /
 * AI_MONTHLY_BUDGET otherwise. `principalId` is the person whose allowance it
 * is — the person signed in.
 */
export async function aiGate(feature: AiFeature, principalId: string): Promise<AiFeatureSetting> {
  const setting = await aiSettingFor(feature);
  const closed = await featureClosed(feature, setting);
  if (closed) throw conflict(closed.message, { code: closed.code });
  if (setting.daily_limit !== null && (await aiUsedToday(feature, principalId)) >= setting.daily_limit) {
    throw conflict(aiDailyLimitSentence(feature, setting.daily_limit), { code: AI_DAILY_LIMIT_CODE });
  }
  return setting;
}

/** Per feature: may this person use it now, and how much of today is left.
    Drawn by the buttons before a click (`GET /ai/status`). */
export async function aiStatus(principalId: string): Promise<AiStatusResponse> {
  const out = {} as AiStatusResponse;
  for (const feature of AI_FEATURES) {
    const setting = await aiSettingFor(feature);
    let used = 0;
    let closed: { code: string; message: string } | null;
    try {
      closed = await featureClosed(feature, setting);
      used = await aiUsedToday(feature, principalId);
    } catch {
      closed = { code: AI_OFF_CODE, message: 'AI usage could not be read' };
    }
    const overToday = !closed && setting.daily_limit !== null && used >= setting.daily_limit;
    out[feature] = {
      available: !closed && !overToday,
      reason: closed?.message ?? (overToday ? aiDailyLimitSentence(feature, setting.daily_limit as number) : null),
      code: closed?.code ?? (overToday ? AI_DAILY_LIMIT_CODE : null),
      daily_limit: setting.daily_limit,
      used_today: used,
    };
  }
  return out;
}

// ── Recording ────────────────────────────────────────────────────────────────

export interface AiResponseUsage {
  model: string | null;
  usage: AiTokenUsage | null | undefined;
}

/** One row for one use. Costs are summed response by response (a model loop
    makes several). Never throws. */
export async function recordAiUse(e: {
  feature: AiFeature;
  principalId: string;
  responses: AiResponseUsage[];
  status: 'ok' | 'error';
  taskId?: string | null;
  /** The model asked for, when no response came back to name one. */
  model?: string | null;
}): Promise<void> {
  const sum = (k: keyof AiTokenUsage) => e.responses.reduce((t, r) => t + Math.max(0, Number(r.usage?.[k] ?? 0) || 0), 0);
  const cost = e.responses.reduce((t, r) => t + aiCostUsd(r.model, r.usage), 0);
  const model = [...e.responses].reverse().find((r) => r.model)?.model ?? e.model ?? null;
  try {
    await query(
      `INSERT INTO ai_usage (feature, principal_id, model, status, input_tokens, output_tokens,
                             cache_read_tokens, cache_write_tokens, cost_usd, task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.feature,
        e.principalId,
        model,
        e.status,
        sum('input_tokens'),
        sum('output_tokens'),
        sum('cache_read_input_tokens'),
        sum('cache_creation_input_tokens'),
        Math.round(cost * 1_000_000) / 1_000_000,
        e.taskId ?? null,
      ],
    );
  } catch (err) {
    console.warn('[ai-usage] could not record a use:', (err as Error).message);
  }
}

// ── Dashboard › AI usage ─────────────────────────────────────────────────────────

function periodBoundsSql(period: AiUsagePeriod): string {
  const local = `(now() AT TIME ZONE ${TZ})`;
  switch (period) {
    case 'today':
      return `SELECT date_trunc('day', ${local}) AT TIME ZONE ${TZ} AS f, now() AS t`;
    case 'last_month':
      return `SELECT (date_trunc('month', ${local}) - interval '1 month') AT TIME ZONE ${TZ} AS f,
                     date_trunc('month', ${local}) AT TIME ZONE ${TZ} AS t`;
    case '30d':
      return `SELECT (date_trunc('day', ${local}) - interval '29 days') AT TIME ZONE ${TZ} AS f, now() AS t`;
    default:
      return `SELECT date_trunc('month', ${local}) AT TIME ZONE ${TZ} AS f, now() AS t`;
  }
}

export async function aiSettingsView(): Promise<AiFeatureSettingView[]> {
  const rows = await settingRows();
  return AI_FEATURES.map((feature) => {
    const row = rows.get(feature);
    return {
      ...fromRow(feature, row),
      label: AI_FEATURE_LABELS[feature],
      description: AI_FEATURE_DESCRIPTIONS[feature],
      updated_by: row?.updated_by ? { id: row.updated_by, name: row.updated_by_name ?? 'Someone' } : null,
      updated_at: row ? new Date(row.updated_at).toISOString() : null,
    };
  });
}

export async function aiUsageReport(user: Admin, period: AiUsagePeriod): Promise<AiUsageResponse> {
  requireSuperAdmin(user);
  const bounds = (await query<{ f: Date; t: Date }>(periodBoundsSql(period))).rows[0];
  const range = [bounds.f, bounds.t];
  const IN_RANGE = `created_at >= $1::timestamptz AND created_at < $2::timestamptz + interval '1 second'`;

  const [settings, features, month, people, today, perDay, days, since] = await Promise.all([
    aiSettingsView(),
    query<{ feature: AiFeature; calls: number; errors: number; cost: string; people: number }>(
      `SELECT feature, count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS errors,
              COALESCE(sum(cost_usd), 0)::text AS cost, count(DISTINCT principal_id)::int AS people
         FROM ai_usage WHERE ${IN_RANGE} GROUP BY feature`,
      range,
    ),
    query<{ feature: AiFeature; cost: string }>(
      `SELECT feature, COALESCE(sum(cost_usd), 0)::text AS cost FROM ai_usage WHERE ${THIS_MONTH_SQL} GROUP BY feature`,
    ),
    query<{ id: string; name: string | null; role_label: string | null; feature: AiFeature; calls: number; cost: string; last_at: Date }>(
      `SELECT u.principal_id::text AS id, p.display_name AS name, r.label AS role_label, u.feature,
              count(*)::int AS calls, COALESCE(sum(u.cost_usd), 0)::text AS cost, max(u.created_at) AS last_at
         FROM ai_usage u
         LEFT JOIN principal p ON p.id = u.principal_id
         LEFT JOIN role r ON r.code = p.role
        WHERE u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz + interval '1 second'
        GROUP BY u.principal_id, p.display_name, r.label, u.feature`,
      range,
    ),
    query<{ id: string; feature: AiFeature; n: number }>(
      `SELECT principal_id::text AS id, feature, count(*)::int AS n FROM ai_usage WHERE ${TODAY_SQL} GROUP BY principal_id, feature`,
    ),
    query<{ id: string; feature: AiFeature; day: string; n: number }>(
      `SELECT principal_id::text AS id, feature, to_char((created_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM ai_usage WHERE ${IN_RANGE} GROUP BY 1, 2, 3`,
      range,
    ),
    query<{ day: string; calls: number; cost: string }>(
      `SELECT to_char((created_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, count(*)::int AS calls,
              COALESCE(sum(cost_usd), 0)::text AS cost
         FROM ai_usage WHERE ${IN_RANGE} GROUP BY 1 ORDER BY 1`,
      range,
    ),
    query<{ at: Date | null }>(`SELECT min(created_at) AS at FROM ai_usage`),
  ]);

  const limitOf = new Map(settings.map((s) => [s.feature, s.daily_limit]));
  const byPerson = new Map<string, AiPersonUsage>();
  for (const r of people.rows) {
    const p =
      byPerson.get(r.id) ??
      ({ principal_id: r.id, name: r.name ?? 'Unknown account', role_label: r.role_label, calls: 0, cost_usd: 0, by_feature: {}, today: {}, limit_days: 0, last_at: null } as AiPersonUsage);
    const cost = Number(r.cost);
    p.calls += r.calls;
    p.cost_usd += cost;
    p.by_feature[r.feature] = { calls: r.calls, cost_usd: cost };
    const last = new Date(r.last_at).toISOString();
    if (!p.last_at || last > p.last_at) p.last_at = last;
    byPerson.set(r.id, p);
  }
  for (const r of today.rows) {
    const p = byPerson.get(r.id);
    if (p) p.today[r.feature] = r.n;
  }
  // A day counts once however many features hit their limit on it.
  const limitDays = new Map<string, Set<string>>();
  for (const r of perDay.rows) {
    const limit = limitOf.get(r.feature);
    if (limit === null || limit === undefined || limit === 0 || r.n < limit) continue;
    const set = limitDays.get(r.id) ?? new Set<string>();
    set.add(r.day);
    limitDays.set(r.id, set);
  }
  for (const [id, set] of limitDays) {
    const p = byPerson.get(id);
    if (p) p.limit_days = set.size;
  }

  const monthCost = new Map(month.rows.map((r) => [r.feature, Number(r.cost)]));
  const featureRows = new Map(features.rows.map((r) => [r.feature, r]));
  const featureUsage: AiFeatureUsage[] = AI_FEATURES.map((feature) => {
    const r = featureRows.get(feature);
    return {
      feature,
      calls: r?.calls ?? 0,
      errors: r?.errors ?? 0,
      cost_usd: Number(r?.cost ?? 0),
      people: r?.people ?? 0,
      month_cost_usd: monthCost.get(feature) ?? 0,
    };
  });

  const everyone = [...byPerson.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls);
  const dayRows: AiUsageDay[] = days.rows.map((d) => ({ day: d.day, calls: d.calls, cost_usd: Number(d.cost) }));
  return {
    period,
    from: new Date(bounds.f).toISOString(),
    to: new Date(bounds.t).toISOString(),
    totals: {
      calls: featureUsage.reduce((t, f) => t + f.calls, 0),
      cost_usd: featureUsage.reduce((t, f) => t + f.cost_usd, 0),
      people: everyone.length,
    },
    features: featureUsage,
    people: everyone,
    days: dayRows,
    settings,
    models: AI_MODELS,
    tracking_since: since.rows[0]?.at ? new Date(since.rows[0].at).toISOString() : null,
    configured: config.anthropicApiKey !== null && integrationOn('claude'),
    can_edit: user.isSuperAdmin,
  };
}

/** Save one feature's model, daily limit and monthly budget. Logged as
    `ai_setting_updated` with whole before / after snapshots; a save that
    changes nothing logs nothing. */
export async function saveAiSetting(user: Admin, feature: AiFeature, input: AiSettingInput): Promise<AiFeatureSettingView[]> {
  requireSuperAdmin(user);
  const problem = aiSettingProblem(input);
  if (problem) throw new ApiError('BAD_REQUEST', problem, { code: 'VALIDATION' });

  const before = await aiSettingFor(feature);
  const snap = (s: AiFeatureSetting) => ({
    name: AI_FEATURE_LABELS[feature],
    model: s.model,
    daily_limit: s.daily_limit,
    monthly_budget_usd: s.monthly_budget_usd,
  });
  await query(
    `INSERT INTO ai_setting (feature, model, daily_limit, monthly_budget_usd, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (feature) DO UPDATE
        SET model = EXCLUDED.model, daily_limit = EXCLUDED.daily_limit,
            monthly_budget_usd = EXCLUDED.monthly_budget_usd,
            updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [feature, input.model, input.daily_limit, input.monthly_budget_usd, user.id],
  );
  const after = { feature, ...input };
  if (JSON.stringify(snap(before)) !== JSON.stringify(snap(after))) {
    await logAdminEvent({
      actorId: user.id,
      entity: 'ai_setting',
      entityId: feature,
      action: 'ai_setting_updated',
      before: snap(before),
      after: snap(after),
    });
  }
  return aiSettingsView();
}
