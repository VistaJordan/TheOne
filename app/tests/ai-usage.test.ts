// 0138 · AI usage, models and limits; Improve message; the assistant's
// confidentiality rules (Elise, 2026-11-14).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERM_SECTIONS,
  AI_DEFAULT_MODEL,
  AI_FEATURES,
  AI_MODEL_IDS,
  aiCostUsd,
  aiDailyLimitSentence,
  aiHeavyUseReason,
  aiModelInfo,
  aiSettingProblem,
  formatUsd,
  type AiPersonUsage,
} from '@theone/shared';
import { STATIC_INSTRUCTIONS } from '../apps/api/src/lib/assistantPrompt';

const root = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(resolve(root, ...p), 'utf8');

describe('what a use costs', () => {
  it('prices a response from its tokens at the model’s rate per million', () => {
    expect(aiCostUsd('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 0 })).toBeCloseTo(0.005, 6);
    expect(aiCostUsd('claude-haiku-5-5', { input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(0.5, 6);
    expect(aiCostUsd('claude-opus-5-5', { input_tokens: 10_000, output_tokens: 2_000 })).toBeCloseTo(0.04 + 0.04, 6);
    expect(aiCostUsd('claude-sonnet-5-5', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2, 6);
    expect(aiCostUsd('claude-haiku-4-5', { cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(1.25, 6);
  });

  it('bills a Haiku 5.5 prompt above 100K tokens at the long-context rate', () => {
    expect(aiCostUsd('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 1_000 })).toBeCloseTo((200_000 * 0.5 + 1_000 * 2.5) / 1e6, 6);
    // cache reads count toward the 100K and are scaled with the input price
    expect(aiCostUsd('claude-haiku-5-5', { input_tokens: 1_000, cache_read_input_tokens: 150_000 })).toBeCloseTo((1_000 * 0.5 + 150_000 * 0.05) / 1e6, 6);
  });

  it('reads a dated model id as its model, and an unknown one as free rather than guessed', () => {
    expect(aiModelInfo('claude-haiku-4-5-20251001')?.id).toBe('claude-haiku-4-5');
    expect(aiCostUsd('some-other-model', { input_tokens: 1_000_000 })).toBe(0);
    expect(aiCostUsd('claude-opus-5-5', null)).toBe(0);
  });

  it('formats small figures with enough digits to read', () => {
    expect(formatUsd(0.0031)).toBe('$0.0031');
    expect(formatUsd(1.236)).toBe('$1.24');
    expect(formatUsd(1204.4)).toBe('$1,204');
  });

  it('every default model is one an administrator can pick', () => {
    for (const f of AI_FEATURES) expect(AI_MODEL_IDS).toContain(AI_DEFAULT_MODEL[f]);
    expect(AI_DEFAULT_MODEL.message_improve).toBe('claude-haiku-5-5');
    expect(aiModelInfo('claude-haiku-4-5')?.effort).toBe(false);
    expect(aiModelInfo('claude-haiku-5-5')?.fallback).toBe(false);
    expect(aiModelInfo('claude-opus-5-5')?.fallback).toBe(true);
  });
});

describe('settings and limits', () => {
  it('refuses an unknown model, a fractional or negative limit and a budget out of range', () => {
    expect(aiSettingProblem({ model: 'claude-haiku-5-5', daily_limit: 50, monthly_budget_usd: 20 })).toBeNull();
    expect(aiSettingProblem({ model: 'claude-haiku-5-5', daily_limit: null, monthly_budget_usd: null })).toBeNull();
    expect(aiSettingProblem({ model: 'gpt-4', daily_limit: 5, monthly_budget_usd: null })).toMatch(/Pick one of/);
    expect(aiSettingProblem({ model: 'claude-haiku-5-5', daily_limit: 2.5, monthly_budget_usd: null })).toMatch(/whole number/);
    expect(aiSettingProblem({ model: 'claude-haiku-5-5', daily_limit: -1, monthly_budget_usd: null })).toMatch(/whole number/);
    expect(aiSettingProblem({ model: 'claude-haiku-5-5', daily_limit: 1, monthly_budget_usd: -5 })).toMatch(/monthly budget/);
  });

  it('says a limit of 0 means off for everyone, and when a reached limit comes back', () => {
    expect(aiDailyLimitSentence('message_improve', 0)).toMatch(/switched off for everyone/);
    expect(aiDailyLimitSentence('assistant', 100)).toMatch(/100 Assistant questions today.*resets at midnight/);
  });

  it('flags a person who reached a limit, or spent three times the median', () => {
    const p = (id: string, cost: number, limit_days = 0): AiPersonUsage => ({
      principal_id: id, name: id, role_label: null, calls: 1, cost_usd: cost, by_feature: {}, today: {}, limit_days, last_at: null,
    });
    const team = [p('a', 1), p('b', 1.2), p('c', 1.1), p('d', 6)];
    expect(aiHeavyUseReason(team[3], team)).toMatch(/× the team’s median/);
    expect(aiHeavyUseReason(team[0], team)).toBeNull();
    expect(aiHeavyUseReason(p('e', 0.01, 2), team)).toBe('Reached a daily limit on 2 days');
    // two people are not a team to compare against
    expect(aiHeavyUseReason(p('x', 9), [p('x', 9), p('y', 1)])).toBeNull();
  });
});

describe('every AI feature asks the gate and records its use', () => {
  it('the assistant, the quote draft and Improve each go through aiGate and recordAiUse', () => {
    const assistant = read('apps', 'api', 'src', 'services', 'assistant.ts');
    expect(assistant).toContain("aiGate('assistant', a.user.id)");
    expect(assistant).toContain("feature: 'assistant'");
    expect(assistant).toContain('answer(app, a, history, setting.model)');
    const quote = read('apps', 'api', 'src', 'services', 'aiQuote.ts');
    expect(quote).toContain("aiGate('quote_draft', actor.id)");
    expect(quote).toContain("feature: 'quote_draft'");
    const improve = read('apps', 'api', 'src', 'services', 'aiImprove.ts');
    expect(improve).toContain("aiGate('message_improve', userId)");
    expect(improve).toContain("feature: 'message_improve'");
  });

  it('Improve needs what posting needs, and spends the signed-in person’s allowance', () => {
    const routes = read('apps', 'api', 'src', 'routes', 'workOrders.ts');
    const at = routes.indexOf("app.post('/work-orders/:id/messages/improve'");
    expect(at).toBeGreaterThan(0);
    const body = routes.slice(at, at + 900);
    expect(body).toContain("requirePerm(p, MESSAGE_PERM_KEY, 'create'");
    expect(body).toContain('CLIENT_MESSAGE_PERM_KEY');
    expect(body).toContain('resolveTaskId(id, p)');
    expect(body).toContain('req.auth!.user.id');
  });

  it('AI usage is a Dashboard tab for super admins only, and its tables survive a re-seed', () => {
    expect(ADMIN_PERM_SECTIONS.find((s) => s.slug === 'ai')).toBeUndefined();
    const mig = read('packages', 'db', 'migrations', '0138_ai_usage.sql');
    expect(mig).not.toContain('admin/ai');
    expect(mig).not.toMatch(/REFERENCES\s+(principal|task)/i);
    const seed = read('packages', 'db', 'src', 'seed.ts');
    expect(seed).not.toMatch(/\bai_setting\b|\bai_usage\b/);
    const svc = read('apps', 'api', 'src', 'services', 'aiUsage.ts');
    expect(svc.match(/requireSuperAdmin\(user\);/g)?.length).toBe(2);
    expect(svc).toContain('can_edit: user.isSuperAdmin');
    const dash = read('apps', 'web', 'src', 'pages', 'DashboardPage.tsx');
    expect(dash).toContain('const canAi = Boolean(actingAs?.is_super_admin);');
    expect(dash).toContain("tab === 'ai' && canAi ? (");
  });

  it('the Dashboard opens for super admins in this version; everyone else keeps the Version 2 screen', async () => {
    const { isVersionTwo } = await import('../apps/web/src/lib/versionTwo');
    expect(isVersionTwo('Dashboard')).toBe(true);
    expect(isVersionTwo('Dashboard', true)).toBe(false);
    expect(isVersionTwo('Pulse', true)).toBe(true);
    expect(isVersionTwo('Work Orders', false)).toBe(false);
    const app = read('apps', 'web', 'src', 'App.tsx');
    expect(app).toContain('isVersionTwo(nav, Boolean(actingAs?.is_super_admin))');
    // Signing in still lands on Work Orders for anyone who may open them.
    const at = app.indexOf('function HomeRoute()');
    const home = app.slice(at, at + 400);
    expect(home.indexOf("can('work_orders', 'view')")).toBeGreaterThan(0);
    expect(home.indexOf("can('work_orders', 'view')")).toBeLessThan(home.indexOf("can('dashboard', 'view')"));
  });
});

describe('the assistant keeps to OBI and keeps confidences', () => {
  it('declines employment, people, secrets and what the role cannot see', () => {
    expect(STATIC_INSTRUCTIONS).toContain('Anything outside OBI is not yours to answer');
    expect(STATIC_INSTRUCTIONS).toContain('## What you keep confidential');
    expect(STATIC_INSTRUCTIONS).toMatch(/pay, salaries, bonuses, benefits/);
    expect(STATIC_INSTRUCTIONS).toContain('their manager or HR can');
    expect(STATIC_INSTRUCTIONS).toMatch(/passwords, API keys, tokens/);
    expect(STATIC_INSTRUCTIONS).toMatch(/do not work it out from other figures/);
    expect(STATIC_INSTRUCTIONS).toMatch(/never from what they type/);
  });
});
