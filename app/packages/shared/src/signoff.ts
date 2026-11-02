// 0070 · Sign-off sheets — the vocabulary shared by the API and the browser.
//
// A sheet is a one-page PDF in the billing entity's branding with the client's
// work order number and the service address already on it, which a technician
// hands to the manager on site to sign. The blank goes to the technician by
// text (Quo); the signed copy comes back the same way and is filed as a
// 'signoff' attachment (0061) — the one the Job Done gate (11.3.4) reads.

import { fieldPermKey } from './permissions';

/** Which drawing the sheet uses. One per billing entity ('21. Comp'), BKR
    twice because EMCOR's sheet carries a Closeout Number line. */
export type SignoffLayout = 'sfm' | 'tpm' | 'af' | 'rf' | 'eds' | 'bkr' | 'bkr_emcor';

export const SIGNOFF_LAYOUTS: readonly SignoffLayout[] = ['sfm', 'tpm', 'af', 'rf', 'eds', 'bkr', 'bkr_emcor'];

/** The entity name printed in the text message and shown on the card. */
export const SIGNOFF_ENTITY_NAMES: Record<SignoffLayout, string> = {
  sfm: 'Seamless Facility Management',
  tpm: 'Texas Pipe Masters',
  af: 'Alpha Fixers',
  rf: 'Repairfected',
  eds: 'Elite Drain Solutions',
  bkr: 'BKR National Facility Services',
  bkr_emcor: 'BKR National Facility Services',
};

/**
 * The layout for a work order: by '21. Comp', and for BKR by whether the
 * client is EMCOR. Null when Comp is unset or not one we have a sheet for —
 * the card then says "set Comp first" instead of guessing a brand.
 */
export function signoffLayoutFor(comp: string | null | undefined, client: string | null | undefined): SignoffLayout | null {
  const c = (comp ?? '').trim().toUpperCase();
  switch (c) {
    case 'SFM': return 'sfm';
    case 'TPM': return 'tpm';
    case 'AF': return 'af';
    case 'RF': return 'rf';
    case 'EDS': return 'eds';
    case 'BKR': return /emcor/i.test(client ?? '') ? 'bkr_emcor' : 'bkr';
    default: return null;
  }
}

/**
 * The Paperform each entity's technicians were texted before The One (read
 * off the ClickUp tasks' '24. Sign-Off Link' values, 2026-11-02). Every form
 * takes the same two prefill keys: `ed9ra` = the client's work order number,
 * `bf7ou` = the service address. Elite Drain Solutions never had one: null,
 * and its work orders offer the PDF only. Add or change a form here.
 */
export const SIGNOFF_FORM_URLS: Record<SignoffLayout, string | null> = {
  sfm: 'https://seamlessfm.paperform.co/',
  tpm: 'https://bf8xowiy.paperform.co/',
  af: 'https://alphafixerssignoff.paperform.co/',
  rf: 'https://repairfected.paperform.co/',
  eds: null,
  bkr: 'https://bkrform.paperform.co/',
  bkr_emcor: 'https://bkremcor.paperform.co/',
};

export const SIGNOFF_FORM_WO_PARAM = 'ed9ra';
export const SIGNOFF_FORM_ADDRESS_PARAM = 'bf7ou';

/** The prefilled form link, as the team sent it — or null when the entity
    has no form or the work order has no number. Spaces as %20 (not +), the
    way Paperform's own links read. */
export function signoffFormLink(layout: SignoffLayout | null, woRef: string | null | undefined, address: string | null | undefined): string | null {
  const base = layout ? SIGNOFF_FORM_URLS[layout] : null;
  const ref = (woRef ?? '').trim();
  if (!base || !ref) return null;
  const parts = [`${SIGNOFF_FORM_WO_PARAM}=${encodeURIComponent(ref)}`];
  const addr = (address ?? '').trim();
  if (addr) parts.push(`${SIGNOFF_FORM_ADDRESS_PARAM}=${encodeURIComponent(addr)}`);
  return `${base}?${parts.join('&')}`;
}

/** Send to tech: the prefilled form link, or the PDF. */
export type SignoffShareKind = 'pdf' | 'link';

/** What goes on the sheet. Pure data so the renderer can be tested alone. */
export interface SignoffSheetData {
  layout: SignoffLayout;
  /** The client's work order number (ext_name), falling back to ours. */
  wo_ref: string;
  address: string | null;
}

export interface SignoffShare {
  id: string;
  vendor_id: string | null;
  tech_name: string | null;
  phone: string;
  channel: 'quo_api' | 'quo_app';
  /** What was sent: the PDF's download link, or the prefilled form (0116). */
  kind: SignoffShareKind;
  sent_by: { id: string; name: string } | null;
  sent_at: string;
}

export interface WoSignoff {
  id: string;
  layout: SignoffLayout;
  entity_name: string;
  wo_ref: string;
  address: string | null;
  created_by: { id: string; name: string } | null;
  created_at: string;
  /** The number or address on the work order no longer matches the sheet. */
  stale: boolean;
  /** The public download link the technician gets. */
  url: string;
  shares: SignoffShare[];
  signed_attachment_id: string | null;
  signed_at: string | null;
}

/** A signed copy that came back from a number holding several open sheets:
    it waits on every candidate work order until someone claims it. */
export interface SignoffReply {
  id: string;
  phone: string;
  tech_name: string | null;
  file_name: string;
  content_type: string;
  body: string | null;
  received_at: string;
}

export interface WoSignoffResponse {
  /** The current sheet, or null when none has been generated yet. */
  signoff: WoSignoff | null;
  /** The entity's Paperform, prefilled with this work order's number and
      address as they are NOW — null when the entity has no form (EDS), Comp
      is unset, or the work order has no number. Needs no drawn sheet. */
  form_link: string | null;
  /** Every form-link share on the work order (a PDF share sits under its
      sheet's `signoff.shares`), newest first. */
  link_shares: SignoffShare[];
  /** The layout the work order would get now (null = Comp unset / unknown). */
  layout: SignoffLayout | null;
  /** Which technicians the sheet can go to (hired + from visits), deduplicated by phone. */
  technicians: SignoffTechnician[];
  replies: SignoffReply[];
  can: { generate: boolean; share: boolean };
  /** File storage is connected (BLOB_READ_WRITE_TOKEN); without it nothing can be generated. */
  storage_ready: boolean;
  /** The Quo API is configured: Share sends the text itself. Otherwise the
      browser opens the Quo app with the message pre-filled. */
  quo_api_ready: boolean;
}

export interface SignoffTechnician {
  key: string;
  vendor_id: string | null;
  name: string;
  phone: string;
  source: string;
}

export interface SignoffShareInput {
  phone: string;
  /** Unset = 'pdf', as before 0116. */
  kind?: SignoffShareKind;
  tech_name?: string | null;
  vendor_id?: string | null;
}

export interface SignoffShareResult extends WoSignoffResponse {
  /** 'quo_api' — the text went out. 'quo_app' — open `sms` in the browser;
      the Quo app on this PC takes over with the message pre-filled. */
  channel: 'quo_api' | 'quo_app';
  sms: string | null;
}

/** The text a technician receives. Under 1600 characters (Quo's cap) and
    short enough for one or two SMS segments once the link is counted. */
export function signoffMessageText(entityName: string, woRef: string, address: string | null, url: string): string {
  const where = address ? ` at ${address}` : '';
  return (
    `${entityName}: sign-off sheet for work order ${woRef}${where}. ` +
    `Please have the manager on site sign it and reply to this text with a photo or scan of the signed sheet. ` +
    `Download: ${url}`
  );
}

/** The text for the form link: the technician signs on the form itself, so
    nothing has to be texted back. */
export function signoffFormMessageText(entityName: string, woRef: string, address: string | null, url: string): string {
  const where = address ? ` at ${address}` : '';
  return (
    `${entityName}: sign-off form for work order ${woRef}${where}. ` +
    `Please have the manager on site fill in their name and sign it on this link: ${url}`
  );
}

export const SIGNOFF_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
export const signoffPublicPath = (token: string): string => `/api/public/signoff/${token}`;

/** The bag key the sheet lives in, and the permission the row and the routes
    share: the FIELD's own path (unset = inherits the CICO section's). Seeing
    the field is seeing the sheet; editing it is drawing and sending one. */
export const SIGNOFF_FIELD_KEY = 'fields.24. Sign-Off Link';
export const SIGNOFF_PERM_KEY = fieldPermKey(SIGNOFF_FIELD_KEY);
