/* Ecotrak Service-Provider API client.
 *
 * READ ONLY by construction: this module exposes no method that mutates
 * anything on Ecotrak's side. The only POST is the OAuth2 token exchange, which
 * is authentication rather than a data write. Writing (PUT /status, /eta, notes)
 * comes later, gated behind cmms_connection.shadow_mode.
 *
 * Verified against production 2026-08-19: 232 work orders over 3 weeks.
 */

/** The port. An adapter may implement this over REST, a CSV drop, or email —
 *  Corrigo access is unproven, so the interface stays in domain terms. */
export interface WorkOrderSource {
  fetchUpdatedSince(since: Date): Promise<EcotrakWorkOrder[]>;
  fetchWorkOrder(externalId: string): Promise<EcotrakWorkOrder | null>;
}

export interface EcotrakLocation {
  id?: number | string | null;
  name?: string | null;
  store_number?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface EcotrakProposal {
  total_amount?: number | string | null;
  labor?: number | string | null;
  material?: number | string | null;
  incurred_cost?: number | string | null;
  proposal_status?: string | null;
  approved_date?: string | null;
}

export interface EcotrakWorkOrder {
  id: number | string;
  /** Ours to set. Null on 100% of production records — never use as a key. */
  work_order_id?: number | string | null;
  status: string;
  priority_type?: string | null;
  category_type?: string | null;
  trade?: string | null;
  problem_type?: string | null;
  asset_type_name?: string | null;
  asset?: {
    id?: number | string | null;
    name?: string | null;
    model_number?: string | null;
    description?: string | null;
    alt_description?: string | null;
  } | null;
  description?: string | null;
  requested_by?: string | null;
  not_to_exceed?: number | string | null;
  raised_not_to_exceed?: number | string | null;
  purchase_order?: string | null;
  current_eta?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
  customer?: { customer_name?: string | null; customer_id?: number | string | null } | null;
  location?: EcotrakLocation | null;
  proposal?: EcotrakProposal | null;
  invoice?: { id?: number | string | null; status?: string | null } | null;
  notes?: Array<{ description?: string | null; created_date?: string | null }> | null;
}

export interface EcotrakConfig {
  tokenUrl: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Read config from the environment. `ref` is cmms_connection.credentials_ref,
 * so a second Ecotrak tenant is a second env prefix rather than a code change.
 * Credentials never live in the database.
 */
export function configFromEnv(ref = 'ECOTRAK'): EcotrakConfig {
  const get = (k: string): string => {
    const v = process.env[`${ref}_${k}`];
    if (!v) throw new Error(`missing env ${ref}_${k}`);
    return v;
  };
  return {
    tokenUrl: get('TOKEN_URL'),
    baseUrl: get('BASE_URL').replace(/\/+$/, ''),
    clientId: get('CLIENT_ID'),
    clientSecret: get('CLIENT_SECRET'),
  };
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** Spring Data page envelope — what /v1/workorders/search actually returns. */
interface Page<T> {
  content?: T[];
  totalPages?: number;
  numberOfElements?: number;
  last?: boolean;
  number?: number;
}

export class EcotrakClient implements WorkOrderSource {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: EcotrakConfig) {}

  /** Cached bearer token. Ecotrak issues 1-hour tokens; refresh 60s early. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;

    const res = await fetch(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    });
    if (!res.ok) {
      // Never echo the body — an auth error can reflect the request back.
      throw new Error(`ecotrak auth failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('ecotrak auth returned no access_token');
    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${await this.accessToken()}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`ecotrak GET ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Work orders whose `date_updated` falls on or after `since`.
   *
   * The API filters by a single `updated_date` DAY, not a range, so this walks
   * one request per day and dedupes by id. Days are capped at 90 so a bad
   * `since` cannot spawn thousands of calls.
   */
  async fetchUpdatedSince(since: Date): Promise<EcotrakWorkOrder[]> {
    const out = new Map<string, EcotrakWorkOrder>();
    const today = new Date();
    const days = Math.min(
      90,
      Math.max(0, Math.floor((today.getTime() - since.getTime()) / 86_400_000)),
    );

    for (let back = 0; back <= days; back++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - back);
      const page = await this.get<{ work_orders?: Page<EcotrakWorkOrder> }>(
        `/v1/workorders/search?updated_date=${ymd(d)}&size=100`,
      );
      for (const wo of page.work_orders?.content ?? []) {
        if (wo && wo.id != null) out.set(String(wo.id), wo);
      }
    }
    return [...out.values()];
  }

  async fetchWorkOrder(externalId: string): Promise<EcotrakWorkOrder | null> {
    try {
      return await this.get<EcotrakWorkOrder>(`/v1/workorders/${encodeURIComponent(externalId)}`);
    } catch (e) {
      if ((e as Error).message.includes('404')) return null;
      throw e;
    }
  }
}
