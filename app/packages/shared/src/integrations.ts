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
  'servicechannel',
  'corrigo',
  'sharepoint',
  'claude',
  'email',
  'email_escalations',
  'blob',
  'entra',
] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export type IntegrationGroup = 'clients' | 'communications' | 'ai' | 'files' | 'platform';
export const INTEGRATION_GROUPS: readonly IntegrationGroup[] = ['clients', 'communications', 'ai', 'files', 'platform'];
export const INTEGRATION_GROUP_LABELS: Record<IntegrationGroup, string> = {
  clients: 'Client systems',
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
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    key: 'ecotrak',
    name: 'Ecotrak',
    vendor: 'Ecotrak',
    group: 'clients',
    summary: "Work orders pulled in from the client's Ecotrak portal. Inbound only: nothing is written back to Ecotrak before go-live.",
    off_means: 'The sync stops: no new or refreshed work orders arrive from Ecotrak. The Ecotrak checks on a status change keep reading what is already on file.',
    logo: 'ecotrak.png',
    built: true,
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

/** The error code every refused call carries when its connector is off. */
export const INTEGRATION_OFF = 'INTEGRATION_OFF';
