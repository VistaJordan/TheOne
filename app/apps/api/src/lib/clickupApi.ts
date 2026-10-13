// 0078 · The ClickUp REST API (v2), the few calls the sync needs.
//
// Auth is a personal API token (`pk_…`) in CLICKUP_API_TOKEN, sent as the
// raw Authorization header — ClickUp's scheme, no "Bearer". ClickUp allows
// 100 requests a minute per token on most plans: a 429 that resets within
// 20 s is waited out once, anything longer stops the run with
// `ClickUpRateLimited` and the queue picks up where it left off next time.

// CLICKUP_API_BASE points the client at a stand-in server for testing.
const BASE = (process.env.CLICKUP_API_BASE?.trim() || 'https://api.clickup.com/api/v2').replace(/\/+$/, '');

export class ClickUpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export class ClickUpRateLimited extends Error {}

export function clickUpToken(): string | null {
  const t = process.env.CLICKUP_API_TOKEN?.trim();
  return t ? t : null;
}

/** Calls made in this run — the runner stops before the per-minute allowance. */
export const callCounter = { n: 0 };

async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const token = clickUpToken();
  if (!token) throw new ClickUpError('CLICKUP_API_TOKEN is not set on the server', 0, 'NO_TOKEN');
  callCounter.n++;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
    const wait = reset ? reset - Date.now() : 60_000;
    if (!retried && wait <= 20_000) {
      await new Promise((r) => setTimeout(r, Math.max(wait, 1000)));
      return call<T>(method, path, body, true);
    }
    throw new ClickUpRateLimited('ClickUp rate limit reached; the rest goes on the next run');
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const j = (json ?? {}) as { err?: string; ECODE?: string };
    throw new ClickUpError(`ClickUp ${res.status}: ${j.err ?? (text.slice(0, 200) || res.statusText)}`, res.status, j.ECODE ?? null);
  }
  return json as T;
}

// ── Reading the List ─────────────────────────────────────────────────────────

export interface CuStatus {
  status: string;
  type: string;
  color?: string;
}
export interface CuList {
  id: string;
  name: string;
  statuses?: CuStatus[];
}
export interface CuFieldRaw {
  id: string;
  name: string;
  type: string;
  type_config?: { options?: { id: string; name?: string; label?: string; orderindex?: number }[] };
}
export interface CuMember {
  id: number;
  username: string | null;
  email: string | null;
}

export const getList = (listId: string) => call<CuList>('GET', `/list/${encodeURIComponent(listId)}`);

export async function getListFields(listId: string): Promise<CuFieldRaw[]> {
  const r = await call<{ fields: CuFieldRaw[] }>('GET', `/list/${encodeURIComponent(listId)}/field`);
  return r.fields ?? [];
}

export async function getMembers(): Promise<CuMember[]> {
  const r = await call<{ teams: { members?: { user: { id: number; username?: string | null; email?: string | null } }[] }[] }>('GET', '/team');
  const byId = new Map<number, CuMember>();
  for (const t of r.teams ?? []) {
    for (const m of t.members ?? []) {
      byId.set(m.user.id, { id: m.user.id, username: m.user.username ?? null, email: m.user.email ?? null });
    }
  }
  return [...byId.values()];
}

// ── Writing tasks ────────────────────────────────────────────────────────────

export interface CuTaskBody {
  name?: string;
  description?: string;
  status?: string;
  priority?: number | null;
  due_date?: number | null;
  due_date_time?: boolean;
  start_date?: number | null;
  start_date_time?: boolean;
  assignees?: number[] | { add: number[]; rem: number[] };
  custom_fields?: { id: string; value: unknown; value_options?: { time: boolean } }[];
}

export const createTask = (listId: string, body: CuTaskBody) =>
  call<{ id: string; url?: string }>('POST', `/list/${encodeURIComponent(listId)}/task`, body);

export const updateTask = (taskId: string, body: CuTaskBody) =>
  call<{ id: string }>('PUT', `/task/${encodeURIComponent(taskId)}`, body);

export const setField = (taskId: string, fieldId: string, value: unknown, valueOptions?: { time: boolean }) =>
  call<unknown>('POST', `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`, {
    value,
    ...(valueOptions ? { value_options: valueOptions } : {}),
  });

export const clearField = (taskId: string, fieldId: string) =>
  call<unknown>('DELETE', `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`);

/** The List id from what an administrator pastes: the id itself, or a ClickUp
    URL (`…/v/li/901234567`, `…/v/l/6-901234567-1`, `…/li/901234567`). */
export function parseListId(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4,}$/.test(s)) return s;
  const li = /\/li\/(\d+)/.exec(s);
  if (li) return li[1];
  const l = /\/l\/(?:[a-z0-9]+-)?(\d+)(?:-\d+)?/i.exec(s);
  if (l) return l[1];
  return null;
}
