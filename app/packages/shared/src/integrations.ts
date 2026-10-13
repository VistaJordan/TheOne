// 0074 · Admin › Integrations — everything The One connects to, each with
// one switch.
//
// The list is fixed in code (a connector is code), the switch is a row per
// key in `integration_setting`. Turning one off makes every code path that
// uses the connector refuse with a clear reason — the Call button, the Quo
// webhook, the Ecotrak sync, the SharePoint filing, the assistant, outgoing
// email, uploads — while the keys and secrets stay where they are, in the
// server's environment. Turning it back on needs nothing else.
//
// `configured` is a different question from `enabled`: a connector may be on
// yet have no credentials (shown as "not configured", with what is missing),
// or be configured yet switched off.

export const INTEGRATION_KEYS = [
  'quo',
  'ecotrak',
  'ecotrak_outbound',
  'servicechannel',
  'corrigo',
  'sharepoint',
  'claude',
  'email',
  'email_escalations',
  'blob',
  'entra',
  'clickup',
] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export type IntegrationGroup = 'clients' | 'team' | 'communications' | 'ai' | 'files' | 'platform';
export const INTEGRATION_GROUPS: readonly IntegrationGroup[] = ['clients', 'team', 'communications', 'ai', 'files', 'platform'];
export const INTEGRATION_GROUP_LABELS: Record<IntegrationGroup, string> = {
  clients: 'Client systems',
  team: 'Team tools',
  communications: 'Calls, texts and email',
  ai: 'AI',
  files: 'Files',
  platform: 'Platform',
};

export interface IntegrationDef {
  key: IntegrationKey;
  name: string;
  vendor: string;
  group: IntegrationGroup;
  /** What it does for the team, in one or two sentences. */
  summary: string;
  /** What stops when the switch is off. */
  off_means: string;
  /** File name under /brand/integrations/. */
  logo: string;
  /** The connector exists in code. False = listed for the switch to be
      remembered, nothing reads it yet. */
  built: boolean;
  /** Cannot be switched off from inside the app. */
  locked?: boolean;
  /** Cannot be switched ON from inside the app (the code that would run
      does not exist yet). The reason is shown on the switch. */
  locked_off?: string;
  /** What the switch reads when nobody has set it, or when the setting
      cannot be read. Omitted = on (the 0074 rule). False for anything that
      talks to a client's system: if in doubt it stays off. */
  default_on?: boolean;
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    key: 'ecotrak',
    name: 'Ecotrak → The One',
    vendor: 'Ecotrak',
    group: 'clients',
    summary:
      'New work orders and every change made on Ecotrak (status, NTE, description, site, asset…) come into The One every 10 minutes, or straight away with Sync now. New ones land in Incoming Work Orders. Read only: The One never changes anything on Ecotrak, so clients see nothing.',
    off_means:
      'The One does not contact Ecotrak at all, not even to sign in: no new or changed work orders arrive. Work orders already here stay as they are, and the Ecotrak checks on a status change keep reading what is on file.',
    logo: 'ecotrak.png',
    built: true,
    default_on: false,
  },
  {
    key: 'ecotrak_outbound',
    name: 'The One → Ecotrak',
    vendor: 'Ecotrak',
    group: 'clients',
    summary:
      'Changes made in The One (status, ETA, notes) sent back to Ecotrak, where the client sees them. Not connected yet: The One has no code that can write to Ecotrak.',
    off_means: 'Nothing is ever sent to Ecotrak. This is the only state today.',
    logo: 'ecotrak.png',
    built: false,
    default_on: false,
    locked_off: 'Not connected yet: it is built and tested on Ecotrak\'s test system first, then turned on at go-live.',
  },
  {
    key: 'servicechannel',
    name: 'ServiceChannel',
    vendor: 'ServiceChannel',
    group: 'clients',
    summary: 'Work orders and client messages for the sites that run on ServiceChannel.',
    off_means: 'Nothing yet: the connector is not built. The switch is remembered for when it is.',
    logo: 'servicechannel.png',
    built: false,
  },
  {
    key: 'corrigo',
    name: 'Corrigo',
    vendor: 'Corrigo (JLL)',
    group: 'clients',
    summary: 'Work orders and client messages for the sites that run on Corrigo.',
    off_means: 'Nothing yet: the connector is not built. The switch is remembered for when it is.',
    logo: 'corrigo.png',
    built: false,
  },
  {
    key: 'clickup',
    name: 'ClickUp',
    vendor: 'ClickUp',
    group: 'team',
    summary: "Every new work order is created in the team's ClickUp List, and every change made in The One (status, cost, any mapped field) follows it there. One-way: The One is the source of truth.",
    off_means: 'Nothing is sent. Changes made while it is off are sent when it is turned back on; work orders created while it is off are sent too.',
    logo: 'clickup.png',
    built: true,
  },
  {
    key: 'quo',
    name: 'Quo',
    vendor: 'Quo (formerly OpenPhone)',
    group: 'communications',
    summary: 'Calls and texts from a work order, the sign-off sheet texted to the technician, and the call transcripts the AI quote draft reads.',
    off_means: 'Send to tech and texting stop, and every event Quo sends (calls, transcripts, signed sheets coming back) is refused until it is back on.',
    logo: 'quo.png',
    built: true,
  },
  {
    key: 'email',
    name: 'Outgoing email',
    vendor: 'Microsoft 365 or Resend',
    group: 'communications',
    summary: 'Client Updates sent by email from the shared mailbox.',
    off_means: 'Scheduled and one-off sends fail with a clear reason and nothing is queued to go out later.',
    logo: 'outlook.png',
    built: true,
  },
  {
    key: 'email_escalations',
    name: 'Escalation emails',
    vendor: 'Mailbox webhook',
    group: 'communications',
    summary: 'An email forwarded to the webhook marks its work order as Escalated and pins it in the inbox (rule 7.3.2).',
    off_means: 'The webhook refuses every email until it is back on; nothing is marked.',
    logo: 'outlook.png',
    built: true,
  },
  {
    key: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    group: 'ai',
    summary: 'The assistant panel and the quote drafted from a call transcript.',
    off_means: 'The assistant says it is switched off and no quote draft can be generated.',
    logo: 'claude.png',
    built: true,
  },
  {
    key: 'sharepoint',
    name: 'SharePoint',
    vendor: 'Microsoft 365',
    group: 'files',
    summary: "A folder per client and per work order in the team's SharePoint library, with approved photos and files copied in.",
    off_means: 'No folders are created and no files are copied, whatever the three switches in Settings say. Folders already made keep their links.',
    logo: 'sharepoint.png',
    built: true,
  },
  {
    key: 'blob',
    name: 'File storage',
    vendor: 'Vercel Blob',
    group: 'files',
    summary: 'Where photos, files and sign-off sheets are kept.',
    off_means: 'Uploads and new sign-off sheets are off. Files already stored still open.',
    logo: 'vercel.png',
    built: true,
  },
  {
    key: 'entra',
    name: 'Microsoft sign-in',
    vendor: 'Microsoft Entra ID',
    group: 'platform',
    summary: "Who can sign in, by the company's Microsoft accounts.",
    off_means: 'Cannot be switched off from inside the app: it is how everyone gets in.',
    logo: 'microsoft.png',
    built: true,
    locked: true,
  },
];

export const INTEGRATION_BY_KEY: Record<IntegrationKey, IntegrationDef> = Object.fromEntries(
  INTEGRATIONS.map((d) => [d.key, d]),
) as Record<IntegrationKey, IntegrationDef>;

export const INTEGRATIONS_PERM_KEY = 'admin/integrations';

export interface IntegrationStatus extends IntegrationDef {
  enabled: boolean;
  /** Credentials / connection present on the server. */
  configured: boolean;
  /** One line: what is set, or what is missing. */
  configured_note: string;
  changed_by: { id: string; name: string } | null;
  changed_at: string | null;
}

export interface IntegrationsResponse {
  items: IntegrationStatus[];
  can: { edit: boolean };
}

// ── ClickUp (0078) ───────────────────────────────────────────────────────────
// The setup panel under the ClickUp row: which List new work orders land in,
// which of our fields goes to which ClickUp field, and how the queue is doing.

/** Where one of our fields can go on the ClickUp task. */
export type ClickUpTarget =
  | 'none'
  | 'name'
  | 'description'
  | 'status'
  | 'priority'
  | 'assignees'
  | 'due_date'
  | 'start_date'
  | 'custom';

export const CLICKUP_NATIVE_TARGETS: { value: Exclude<ClickUpTarget, 'none' | 'custom'>; label: string }[] = [
  { value: 'name', label: 'Task name' },
  { value: 'description', label: 'Description' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'assignees', label: 'Assignees' },
  { value: 'due_date', label: 'Due date' },
  { value: 'start_date', label: 'Start date' },
];

/** ClickUp field types a value can be written to. Formula, progress,
    relationship, attachment, button and location fields are read-only or
    need data we do not hold. */
export const CLICKUP_WRITABLE_TYPES: readonly string[] = [
  'drop_down',
  'labels',
  'text',
  'short_text',
  'number',
  'currency',
  'date',
  'checkbox',
  'email',
  'url',
  'phone',
  'users',
  'emoji',
];

/** Which ClickUp field types fit one of our value types — the mapping
    dropdown offers only these. Text fits anything (written as text). */
export function clickUpFits(ourType: string, cuType: string): boolean {
  if (!CLICKUP_WRITABLE_TYPES.includes(cuType)) return false;
  if (cuType === 'text' || cuType === 'short_text') return true;
  switch (ourType) {
    case 'number':
    case 'money':
      return cuType === 'number' || cuType === 'currency' || cuType === 'emoji';
    case 'date':
    case 'datetime':
      return cuType === 'date';
    case 'boolean':
      return cuType === 'checkbox';
    case 'select':
      return cuType === 'drop_down' || cuType === 'labels' || cuType === 'users';
    case 'users':
      return cuType === 'users';
    default:
      return ['email', 'url', 'phone', 'drop_down', 'labels'].includes(cuType);
  }
}

export interface ClickUpFieldDef {
  id: string;
  name: string;
  type: string;
  options?: { id: string; name: string }[];
}

export interface ClickUpMapRow {
  /** Our key: 'title', 'status', … or 'fields.<bag key>'. */
  source: string;
  label: string;
  /** Our value type, to say what a ClickUp field can take. */
  type: string;
  target: ClickUpTarget;
  cu_field_id: string | null;
  /** True when nobody has chosen yet and this is the match by name. */
  automatic: boolean;
  /** Something that will stop a value going through (an option ClickUp lacks…). */
  warning: string | null;
}

export interface ClickUpProblem {
  task_id: string;
  wo_number: string;
  error: string;
  at: string | null;
  attempts: number;
}

export interface ClickUpOverview {
  enabled: boolean;
  token_set: boolean;
  list: { id: string; name: string | null; url: string | null } | null;
  fetched_at: string | null;
  sync_from: string | null;
  last_run_at: string | null;
  last_run_note: string | null;
  counts: { linked: number; waiting: number; failing: number };
  problems: ClickUpProblem[];
  cu_fields: ClickUpFieldDef[];
  /** Our statuses ClickUp's List does not have (a push to them fails). */
  missing_statuses: string[];
  /** Our people with no ClickUp member of the same email. */
  unmatched_people: string[];
  map: ClickUpMapRow[];
  can: { edit: boolean };
}

/** The error code every refused call carries when its connector is off. */
export const INTEGRATION_OFF = 'INTEGRATION_OFF';

// ── Ecotrak → The One (0079) ─────────────────────────────────────────────────
// The panel under the Ecotrak row: is it set up, when did it last look, and
// what did that look bring in. Read only against Ecotrak, always.

export interface EcotrakRun {
  at: string;
  trigger: 'cron' | 'manual';
  ok: boolean;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  /** One line for the panel: what happened, or why it stopped. */
  note: string;
  errors: string[];
}

export interface EcotrakOverview {
  enabled: boolean;
  /** The four ECOTRAK_* settings are on the server (values never leave it). */
  credentials_set: boolean;
  connection: string | null;
  last_synced_at: string | null;
  last_run: EcotrakRun | null;
  /** Work orders that came from Ecotrak and are tied to it. */
  linked: number;
  can: { edit: boolean };
}
