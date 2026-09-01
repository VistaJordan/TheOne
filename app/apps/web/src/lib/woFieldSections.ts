// The All-fields tab's DEFAULT layout: the operator's sections, in the order
// the founder specified (2026-08). Keys are catalogue keys (`fields.<key>`) —
// the storage address, stable across label renames.
//
// A field the sections do not name still renders (under MORE_SECTION_TITLE at
// the bottom) so a newly added admin field is never invisible; a key named
// here that no longer exists is silently skipped. Comp is deliberately in no
// section — it lives beside the search box (AllFieldsPanel).

import type { IconName } from '../components/Icon';

export interface FieldSection {
  title: string;
  icon: IconName;
  keys: string[];
  /** Spans the full width of the two-column section grid (Overview). */
  wide?: boolean;
}

/** Comp renders as a control in the tab's toolbar, not as a row. */
export const COMP_FIELD_KEY = 'fields.21. Comp';

/** Visit Type sits beside Comp in the same toolbar. It must be set on every
    work order, so an empty value renders in the danger ramp — and the
    dashboard's Needs Attention page counts the work orders still missing it. */
export const VISIT_TYPE_FIELD_KEY = 'fields.Visit Type';

/** Catch-all heading for fields no section names. */
export const MORE_SECTION_TITLE = 'More fields';
export const MORE_SECTION_ICON: IconName = 'list';

export const FIELD_SECTIONS: FieldSection[] = [
  {
    title: 'Overview',
    icon: 'file',
    wide: true,
    keys: [
      'fields.35. WO Description',
      'fields.20. Last Update',
      'fields.29. PDF Link',
      'fields.28. Sharepoint Link',
      'fields.37. PDF',
      'fields.Trade',
    ],
  },
  {
    title: 'Client',
    icon: 'briefcase',
    keys: ['fields.✅ Client AFM', 'fields.22. FM', 'fields.Client', 'fields.Store'],
  },
  {
    title: 'Site',
    icon: 'pin',
    keys: ['fields.17. Address', 'fields.City', 'fields.State', 'fields.Zip Code'],
  },
  {
    title: 'Finances',
    icon: 'dollar',
    keys: [
      'fields.1. Not Fully Paid',
      'fields.16. Client NTE 🔴',
      'fields.34. Cost',
      'fields.Total Invoiced',
      'fields.Profit',
      'fields.Discount',
      'fields.Client Quote',
    ],
  },
  {
    title: 'Dates',
    icon: 'clock',
    keys: [
      'fields.❌Today',
      'fields.🚨 SLA Requested',
      'fields.🚨 SLA Updated',
      'fields.Date-Time Received',
      'fields.Date Created',
      'fields.Due Date',
    ],
  },
  {
    title: 'CICO',
    icon: 'check-circle',
    keys: [
      'fields.18. Check-in/out Status',
      'fields.25. IVR Link',
      'fields.30. IVR Pin',
      'fields.CICO Method',
      'fields.24. Sign-Off Link',
    ],
  },
  {
    title: 'People',
    icon: 'user',
    keys: [
      'fields.AM',
      'fields.TL',
      'fields.Assignee',
      'fields.Completion Assignee',
      'fields.Previous Assignees',
      'fields.Sales Owner',
    ],
  },
  {
    title: 'Technician',
    icon: 'wrench',
    keys: ['fields.Tech Name', 'fields.Tech Phone Number', 'fields.Tech Map', 'fields.Tech Quote'],
  },
  {
    title: 'Payments',
    icon: 'card',
    keys: ['fields.26. PPR Link', 'fields.27. Yoda Link'],
  },
  {
    title: 'Invoicing',
    icon: 'clipboard',
    keys: ['fields.Invoice #', 'fields.Invoice Date', 'fields.Days since Invoiced'],
  },
  {
    title: 'AR',
    icon: 'flag',
    keys: [
      'fields.12. Bad quote',
      'fields.Admin Comment',
      'fields.Grey Flag Date',
      'fields.Quote Check',
      'fields.Audited',
      'fields.GTG',
    ],
  },
  {
    title: 'QC',
    icon: 'check-check',
    keys: [
      'fields.MoD Call',
      'fields.MoD Call Notes',
      'fields.QC Date',
      'fields.Days Since QC',
      'fields.MOD Date',
    ],
  },
  {
    title: 'Other',
    icon: 'dots',
    keys: ['fields.Days since Done', 'fields.Show in CA'],
  },
  {
    title: 'Integrations',
    icon: 'plug',
    keys: ['fields.Ecotrak ID'],
  },
];

/** Catalogue key → where the All-fields tab puts it. Built once from
    FIELD_SECTIONS above so the two can never drift. */
const SECTION_INDEX = new Map<string, { si: number; ki: number }>();
FIELD_SECTIONS.forEach((sec, si) => sec.keys.forEach((k, ki) => SECTION_INDEX.set(k, { si, ki })));

/**
 * Regroup a field catalogue so custom fields carry the All-fields tab's section
 * headings — Client, Site, Finances, … — instead of one flat "Custom field"
 * bucket, and sit in the tab's order within them. A field is then found under
 * the same heading wherever it is picked.
 *
 * Built-in fields keep their own groups (Work order, Site, Money, Dates …) and
 * stay in front: those are columns, not entries in the fields tab. A custom key
 * no section names falls to MORE_SECTION_TITLE, exactly as the tab does.
 */
export function withFieldSections<T extends { key: string; group: string; custom?: boolean }>(
  fields: T[],
): T[] {
  const END = FIELD_SECTIONS.length;
  const customs = fields
    .filter((f) => f.custom)
    .map((f) => ({ f, at: SECTION_INDEX.get(f.key) }))
    .sort((a, b) => (a.at?.si ?? END) - (b.at?.si ?? END) || (a.at?.ki ?? 0) - (b.at?.ki ?? 0))
    .map(({ f, at }) => ({
      ...f,
      group: at ? FIELD_SECTIONS[at.si].title : MORE_SECTION_TITLE,
    }));
  return [...fields.filter((f) => !f.custom), ...customs];
}
