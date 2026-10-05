// 0069 — the pure rules of the suggested-vendors list: which preferred rule
// fits a work order (now down to a city), what the hard filters let through,
// and the order the tie-breakers put the automatic picks in.
import { describe, expect, it } from 'vitest';
import {
  SUGGEST_DEFAULTS,
  activeSignals,
  cleanSuggestSettings,
  preferredRuleScore,
  preferredRuleText,
  rankSuggestions,
  type SuggestCandidate,
  type SuggestSettings,
} from '@theone/shared';

const wo = { client: '7-Eleven', trade: 'HVAC', state: 'OH', city: 'Toledo' };
const rule = (r: Partial<{ client: string | null; trade: string | null; state: string | null; city: string | null }>) => ({
  client: null,
  trade: null,
  state: null,
  city: null,
  ...r,
});

describe('which preferred rule fits a work order', () => {
  it('keeps the old order: client + trade over client over trade, a state adds to it', () => {
    const both = preferredRuleScore(rule({ client: '7-eleven', trade: 'hvac' }), wo);
    const client = preferredRuleScore(rule({ client: '7-Eleven' }), wo);
    const trade = preferredRuleScore(rule({ trade: 'HVAC' }), wo);
    const tradeState = preferredRuleScore(rule({ trade: 'HVAC', state: 'OH' }), wo);
    expect(both).toBeGreaterThan(client);
    expect(client).toBeGreaterThan(tradeState);
    expect(tradeState).toBeGreaterThan(trade);
    expect(trade).toBeGreaterThan(0);
  });

  it('ranks a city rule over its state, and never over a more specific client / trade', () => {
    const city = preferredRuleScore(rule({ trade: 'HVAC', state: 'OH', city: 'toledo' }), wo);
    const state = preferredRuleScore(rule({ trade: 'HVAC', state: 'OH' }), wo);
    const client = preferredRuleScore(rule({ client: '7-Eleven' }), wo);
    expect(city).toBeGreaterThan(state);
    expect(client).toBeGreaterThan(city);
  });

  it('does not match another city, another state, or a work order with no city', () => {
    expect(preferredRuleScore(rule({ trade: 'HVAC', state: 'OH', city: 'Columbus' }), wo)).toBe(0);
    expect(preferredRuleScore(rule({ trade: 'HVAC', state: 'TX' }), wo)).toBe(0);
    expect(preferredRuleScore(rule({ trade: 'HVAC', state: 'OH', city: 'Toledo' }), { ...wo, city: null })).toBe(0);
  });

  it('reads Saint and St. as the same city', () => {
    expect(preferredRuleScore(rule({ trade: 'HVAC', state: 'OH', city: 'St. Marys' }), { ...wo, city: 'Saint Marys' })).toBeGreaterThan(0);
  });

  it('matches a rule written before cities existed exactly as before', () => {
    expect(preferredRuleScore({ client: '7-Eleven', trade: null, state: null }, { client: '7-Eleven', trade: 'HVAC', state: 'OH' })).toBeGreaterThan(0);
  });

  it('says what a rule is for', () => {
    expect(preferredRuleText(rule({ client: '7-Eleven', trade: 'HVAC', state: 'OH', city: 'Toledo' }))).toBe('7-Eleven · HVAC · Toledo, OH');
    expect(preferredRuleText(rule({ trade: 'HVAC' }))).toBe('Any client · HVAC');
  });
});

describe('the settings, made whole', () => {
  it('falls back to the defaults', () => {
    expect(cleanSuggestSettings(null)).toEqual(SUGGEST_DEFAULTS);
  });

  it('keeps every tie-breaker exactly once, unknown ones dropped', () => {
    const s = cleanSuggestSettings({ order: ['rate', 'rate', 'made_up', 'distance'], off: ['jobs', 'nope'], size: 99 });
    expect(s.order).toEqual(['rate', 'distance', 'client_history', 'compliance', 'jobs']);
    expect(s.off).toEqual(['jobs']);
    expect(s.size).toBe(20);
    expect(activeSignals(s)).toEqual(['rate', 'distance', 'client_history', 'compliance']);
  });
});

const v = (id: string, over: Partial<SuggestCandidate> = {}): SuggestCandidate => ({
  id,
  kind: 'vendor',
  name: id,
  phone: null,
  city: null,
  state: 'OH',
  primary_trade: 'HVAC',
  trade_match: true,
  distance_miles: 10,
  reach: 'local',
  client_jobs: 0,
  work_orders_count: 0,
  regular_hourly_rate: null,
  emergency_same_day: null,
  compliance_warning: null,
  blacklisted: false,
  hired: false,
  preferred: null,
  ...over,
});
const ctx = { emergency: false, has_trade: true };
const names = (list: SuggestCandidate[], settings: SuggestSettings = SUGGEST_DEFAULTS, c = ctx) =>
  rankSuggestions(list, settings, c).map((x) => x.id);
const pref = (score: number, rank: number) => ({ score, rank, note: null, rule: 'x' });

describe('the suggested list', () => {
  it('puts hand-picked vendors first — the most specific rule, then the rank', () => {
    const list = [
      v('near', { distance_miles: 1 }),
      v('trade-rule', { preferred: pref(4, 1), distance_miles: 90 }),
      v('client-rule-2', { preferred: pref(12, 2) }),
      v('client-rule-1', { preferred: pref(12, 1) }),
    ];
    expect(names(list)).toEqual(['client-rule-1', 'client-rule-2', 'trade-rule', 'near']);
    expect(rankSuggestions(list, SUGGEST_DEFAULTS, ctx).map((x) => x.source)).toEqual(['preferred', 'preferred', 'preferred', 'auto']);
  });

  it('lists a hand-picked vendor even out of reach or of another trade', () => {
    expect(names([v('far', { preferred: pref(8, 1), reach: null, trade_match: false })])).toEqual(['far']);
  });

  it('never lists a blacklisted vendor, hand-picked or not', () => {
    expect(names([v('a', { blacklisted: true }), v('b', { blacklisted: true, preferred: pref(12, 1) }), v('c')])).toEqual(['c']);
  });

  it('fills the rest by the tie-breakers in order', () => {
    const list = [
      v('cheap', { regular_hourly_rate: 50, distance_miles: 30 }),
      v('near', { distance_miles: 2 }),
      v('known', { client_jobs: 3, distance_miles: 60 }),
      v('no-coi', { distance_miles: 2, compliance_warning: 'No certificate of insurance on file' }),
    ];
    // client history, then distance, then paperwork
    expect(names(list)).toEqual(['known', 'near', 'no-coi', 'cheap']);
    // rate moved to the top
    expect(names(list, { ...SUGGEST_DEFAULTS, order: ['rate', 'client_history', 'distance', 'compliance', 'jobs'] })[0]).toBe('cheap');
    // client history switched off: distance decides
    expect(names(list, { ...SUGGEST_DEFAULTS, off: ['client_history'] })).toEqual(['near', 'no-coi', 'cheap', 'known']);
  });

  it('puts an unknown distance or rate last, and falls back to the name', () => {
    expect(names([v('b'), v('nowhere', { distance_miles: null, reach: 'statewide' }), v('a')])).toEqual(['a', 'b', 'nowhere']);
  });

  it('applies the hard filters to automatic picks only when they are on', () => {
    const list = [v('other-trade', { trade_match: false }), v('out-of-reach', { reach: null }), v('ok')];
    expect(names(list)).toEqual(['ok']);
    expect(names(list, { ...SUGGEST_DEFAULTS, match_trade: false })).toEqual(['ok', 'other-trade']);
    expect(names(list, { ...SUGGEST_DEFAULTS, in_coverage: false })).toEqual(['ok', 'out-of-reach']);
    // a work order with no trade cannot be matched on it
    expect(names(list, SUGGEST_DEFAULTS, { emergency: false, has_trade: false })).toEqual(['ok', 'other-trade']);
  });

  it('asks for same-day emergencies only on an Emergency work order, and only when Admin said so', () => {
    const list = [v('yes', { emergency_same_day: true }), v('no', { emergency_same_day: false }), v('tech-not-asked', { kind: 'tech' })];
    const on = { ...SUGGEST_DEFAULTS, emergency_availability: true };
    expect(names(list, on, { emergency: true, has_trade: true })).toEqual(['tech-not-asked', 'yes']);
    expect(names(list, on)).toHaveLength(3);
    expect(names(list, SUGGEST_DEFAULTS, { emergency: true, has_trade: true })).toHaveLength(3);
  });

  it('warns about paperwork by default and leaves the vendor out when Admin requires it', () => {
    const list = [v('no-coi', { preferred: pref(12, 1), compliance_warning: 'No certificate of insurance on file' }), v('ok')];
    expect(names(list)).toEqual(['no-coi', 'ok']);
    expect(names(list, { ...SUGGEST_DEFAULTS, require_compliance: true })).toEqual(['ok']);
  });

  it('shows only hand-picked vendors with the automatic fill off, and cuts at the size', () => {
    const list = [v('p', { preferred: pref(4, 1) }), v('a'), v('b'), v('c')];
    expect(names(list, { ...SUGGEST_DEFAULTS, auto_fill: false })).toEqual(['p']);
    const two = rankSuggestions(list, { ...SUGGEST_DEFAULTS, size: 2 }, ctx);
    expect(two.map((x) => [x.id, x.position])).toEqual([['p', 1], ['a', 2]]);
  });
});
