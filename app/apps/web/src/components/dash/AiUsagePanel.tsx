/* Dashboard › AI usage (migration 0138, Elise 2026-11-14) — a tab of the
 * Dashboard drawn for super admins only (the rest do not see it until it is
 * finished; the API answers super admins only too).
 *
 * One page for every AI feature OBI has (the assistant, the AI quote draft,
 * Improve message): which Claude model each runs on, how many times one
 * person may use it a day, how much the team may spend on it in a month —
 * and what it actually cost, per feature and per person, so heavy use shows.
 * Costs are computed when each use happens, at the price on file then; the
 * page only adds them up.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AI_FEATURE_LABELS,
  AI_FEATURES,
  AI_USAGE_PERIODS,
  AI_USAGE_PERIOD_LABELS,
  aiHeavyUseReason,
  aiModelLabel,
  aiSettingProblem,
  formatUsd,
} from '@theone/shared';
import type { AiFeature, AiFeatureSettingView, AiFeatureUsage, AiModelInfo, AiPersonUsage, AiUsagePeriod, AiUsageResponse } from '@theone/shared';
import { getAiUsage, saveAiSetting } from '../../api/client';
import { Icon } from '../Icon';
import { errText } from '../ui/Sheet';

const KEY = (period: AiUsagePeriod) => ['ai', 'usage', period];

const dateText = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayText = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

export function AiUsagePanel() {
  const [period, setPeriod] = useState<AiUsagePeriod>('month');
  const q = useQuery({ queryKey: KEY(period), queryFn: () => getAiUsage(period), retry: false });
  const data = q.data;

  return (
    <div className="ai-adm">
      <div className="ai-adm-head">
        <p className="ai-adm-sub">
          Every AI feature in OBI: the Claude model it runs on, how often one person may use it a day, what the team may
          spend on it in a month, and what it cost. Only super admins see this tab.
          {data?.tracking_since ? <> Tracking since {dateText(data.tracking_since)}.</> : data ? <> Nothing has been used since tracking began.</> : null}
        </p>
        <div className="seg ai-adm-period" role="group" aria-label="Period">
          {AI_USAGE_PERIODS.map((p) => (
            <button key={p} type="button" className={`seg-btn${period === p ? ' is-on' : ''}`} aria-pressed={period === p} onClick={() => setPeriod(p)}>
              {AI_USAGE_PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>
      {q.isLoading && <p className="hint">Loading AI usage…</p>}
      {q.isError && !data && (
        <div className="wo-state">
          <Icon name="lock" size={22} />
          <b>Could not load AI usage</b>
          <span>{errText(q.error, 'Try again in a moment.')}</span>
        </div>
      )}
      {data && !data.configured && (
        <div className="callout ai-adm-callout" role="status">
          <Icon name="alert-circle" size={14} /> AI is switched off in Admin › Integrations, or no key is set on the server. Nothing below runs until it is on.
        </div>
      )}
      {data && <UsageBody data={data} />}
    </div>
  );
}

function UsageBody({ data }: { data: AiUsageResponse }) {
  const usage = new Map(data.features.map((f) => [f.feature, f]));
  return (
    <>
      <div className="ai-adm-tiles">
        <Tile label={`Spent · ${AI_USAGE_PERIOD_LABELS[data.period].toLowerCase()}`} value={formatUsd(data.totals.cost_usd)} />
        <Tile label="Uses" value={data.totals.calls.toLocaleString('en-US')} />
        <Tile label="People using AI" value={data.totals.people.toLocaleString('en-US')} />
      </div>

      <section className="card ai-adm-card">
        <div className="card-head">
          <h3 className="card-title">By feature</h3>
          <span className="card-meta">Model, limits and spend</span>
        </div>
        <ul className="ai-adm-features">
          {AI_FEATURES.map((f) => {
            const setting = data.settings.find((s) => s.feature === f);
            if (!setting) return null;
            return <FeatureRow key={f} setting={setting} usage={usage.get(f)} models={data.models} canEdit={data.can_edit} period={data.period} />;
          })}
        </ul>
      </section>

      <PeopleCard data={data} />
      {data.period !== 'today' && data.days.length > 0 && <DaysCard data={data} />}
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="ai-adm-tile">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

// ── One feature: its settings and what it cost ───────────────────────────────

const numOrNull = (v: string): number | null => (v.trim() === '' ? null : Number(v));

function FeatureRow({
  setting,
  usage,
  models,
  canEdit,
  period,
}: {
  setting: AiFeatureSettingView;
  usage: AiFeatureUsage | undefined;
  models: AiModelInfo[];
  canEdit: boolean;
  period: AiUsagePeriod;
}) {
  const qc = useQueryClient();
  const [model, setModel] = useState(setting.model);
  const [limit, setLimit] = useState(setting.daily_limit === null ? '' : String(setting.daily_limit));
  const [budget, setBudget] = useState(setting.monthly_budget_usd === null ? '' : String(setting.monthly_budget_usd));
  const [saved, setSaved] = useState(false);

  // A save elsewhere (or a refetch) resets the row to what is on file.
  useEffect(() => {
    setModel(setting.model);
    setLimit(setting.daily_limit === null ? '' : String(setting.daily_limit));
    setBudget(setting.monthly_budget_usd === null ? '' : String(setting.monthly_budget_usd));
  }, [setting.model, setting.daily_limit, setting.monthly_budget_usd]);

  const input = { model, daily_limit: numOrNull(limit), monthly_budget_usd: numOrNull(budget) };
  const problem = aiSettingProblem(input);
  const dirty =
    model !== setting.model || input.daily_limit !== setting.daily_limit || input.monthly_budget_usd !== setting.monthly_budget_usd;

  const save = useMutation({
    mutationFn: () => saveAiSetting(setting.feature, input),
    onSuccess: () => {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
      void qc.invalidateQueries({ queryKey: ['ai', 'usage'] });
      void qc.invalidateQueries({ queryKey: ['ai', 'status'] });
    },
  });

  const picked = models.find((m) => m.id === model);
  const known = Boolean(picked);
  const monthSpent = usage?.month_cost_usd ?? 0;
  const budgetUsd = setting.monthly_budget_usd;
  const share = budgetUsd && budgetUsd > 0 ? Math.min(1, monthSpent / budgetUsd) : null;
  const id = `ai-${setting.feature}`;

  return (
    <li className="ai-adm-feature">
      <div className="ai-adm-feature-text">
        <b>{setting.label}</b>
        <p>{setting.description}</p>
        {setting.updated_by && setting.updated_at && (
          <small>Changed by {setting.updated_by.name} · {dateText(setting.updated_at)}</small>
        )}
      </div>

      <div className="ai-adm-fields">
        <label htmlFor={`${id}-model`}>
          Model
          <select id={`${id}-model`} className="fld" value={model} disabled={!canEdit} onChange={(e) => setModel(e.target.value)}>
            {!known && <option value={model}>{aiModelLabel(model)} (set on the server)</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {formatUsd(m.input)} / {formatUsd(m.output)}
              </option>
            ))}
          </select>
          <small>
            {picked ? `${picked.hint} ` : ''}Prices are US$ per million tokens, in / out.
          </small>
        </label>
        <label htmlFor={`${id}-limit`}>
          Daily limit per person
          <input
            id={`${id}-limit`}
            className="fld"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="No limit"
            value={limit}
            disabled={!canEdit}
            onChange={(e) => setLimit(e.target.value)}
          />
          <small>Blank = no limit · 0 = off for everyone</small>
        </label>
        <label htmlFor={`${id}-budget`}>
          Monthly budget (US$)
          <input
            id={`${id}-budget`}
            className="fld"
            type="number"
            min={0}
            step={1}
            inputMode="decimal"
            placeholder="No budget"
            value={budget}
            disabled={!canEdit}
            onChange={(e) => setBudget(e.target.value)}
          />
          <small>Stops the feature for the rest of the month once reached</small>
        </label>
        {canEdit && (
          <div className="ai-adm-save">
            <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || Boolean(problem) || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {saved && !dirty && <span className="ai-adm-ok"><Icon name="check" size={12} /> Saved</span>}
            {dirty && problem && <span className="ai-adm-err">{problem}</span>}
            {save.isError && <span className="ai-adm-err" role="alert">{errText(save.error, 'Could not save.')}</span>}
          </div>
        )}
      </div>

      <div className="ai-adm-spend">
        <div className="ai-adm-spend-line">
          <span>This month</span>
          <b>{formatUsd(monthSpent)}</b>
          {budgetUsd !== null && <span className="ai-adm-of">of {formatUsd(budgetUsd)}</span>}
        </div>
        {share !== null && (
          <div className={`ai-adm-meter${share >= 1 ? ' is-full' : share >= 0.8 ? ' is-near' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label="Share of the monthly budget spent">
            <span style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
        )}
        <p className="ai-adm-spend-meta">
          {AI_USAGE_PERIOD_LABELS[period]}: {(usage?.calls ?? 0).toLocaleString('en-US')} uses · {formatUsd(usage?.cost_usd ?? 0)} · {usage?.people ?? 0}{' '}
          {usage?.people === 1 ? 'person' : 'people'}
          {usage && usage.errors > 0 && <> · <span className="ai-adm-err">{usage.errors} failed</span></>}
        </p>
      </div>
    </li>
  );
}

// ── Who used it ──────────────────────────────────────────────────────────────

function PeopleCard({ data }: { data: AiUsageResponse }) {
  const limits = new Map(data.settings.map((s) => [s.feature, s.daily_limit]));
  const flagged = data.people.filter((p) => aiHeavyUseReason(p, data.people)).length;
  return (
    <section className="card ai-adm-card">
      <div className="card-head">
        <h3 className="card-title">By person</h3>
        <span className="card-meta">
          {data.people.length === 0 ? 'Nobody used AI in this period' : flagged > 0 ? `${flagged} standing out` : `${data.people.length} ${data.people.length === 1 ? 'person' : 'people'}`}
        </span>
      </div>
      {data.people.length > 0 && (
        <div className="table-wrap">
          <table className="ct ai-adm-people">
            <thead>
              <tr>
                <th>Person</th>
                {AI_FEATURES.map((f) => (
                  <th key={f} className="num">{AI_FEATURE_LABELS[f]}</th>
                ))}
                <th className="num">Total</th>
                <th>Today</th>
                <th>Last used</th>
              </tr>
            </thead>
            <tbody>
              {data.people.map((p) => (
                <PersonRow key={p.principal_id} p={p} everyone={data.people} limits={limits} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PersonRow({ p, everyone, limits }: { p: AiPersonUsage; everyone: AiPersonUsage[]; limits: Map<AiFeature, number | null> }) {
  const reason = aiHeavyUseReason(p, everyone);
  const today = AI_FEATURES.filter((f) => (p.today[f] ?? 0) > 0).map((f) => {
    const used = p.today[f] ?? 0;
    const limit = limits.get(f);
    const at = limit !== null && limit !== undefined && limit > 0 && used >= limit;
    return (
      <span key={f} className={`chip chip-sm${at ? ' ai-adm-at-limit' : ''}`} title={AI_FEATURE_LABELS[f]}>
        {AI_FEATURE_LABELS[f]} {used}
        {limit !== null && limit !== undefined ? ` / ${limit}` : ''}
      </span>
    );
  });
  return (
    <tr className={reason ? 'ai-adm-heavy' : undefined}>
      <td>
        <b>{p.name}</b>
        {p.role_label && <small className="ai-adm-role"> · {p.role_label}</small>}
        {reason && (
          <div>
            <span className="chip chip-sm ai-adm-flag"><Icon name="alert-circle" size={12} /> {reason}</span>
          </div>
        )}
      </td>
      {AI_FEATURES.map((f) => {
        const u = p.by_feature[f];
        return (
          <td key={f} className="num">
            {u ? (
              <>
                {formatUsd(u.cost_usd)}
                <small className="ai-adm-uses">{u.calls} {u.calls === 1 ? 'use' : 'uses'}</small>
              </>
            ) : (
              <span className="ai-adm-none">—</span>
            )}
          </td>
        );
      })}
      <td className="num">
        <b>{formatUsd(p.cost_usd)}</b>
        <small className="ai-adm-uses">{p.calls} {p.calls === 1 ? 'use' : 'uses'}</small>
      </td>
      <td>{today.length > 0 ? <div className="ai-adm-today">{today}</div> : <span className="ai-adm-none">—</span>}</td>
      <td>{p.last_at ? dateText(p.last_at) : '—'}</td>
    </tr>
  );
}

// ── Day by day ───────────────────────────────────────────────────────────────

function DaysCard({ data }: { data: AiUsageResponse }) {
  const days = [...data.days].reverse();
  return (
    <section className="card ai-adm-card">
      <div className="card-head">
        <h3 className="card-title">By day</h3>
        <span className="card-meta">Newest first · Central time</span>
      </div>
      <div className="table-wrap">
        <table className="ct ai-adm-days">
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Uses</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td>{dayText(d.day)}</td>
                <td className="num">{d.calls.toLocaleString('en-US')}</td>
                <td className="num">{formatUsd(d.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
