// The All-fields tab's DEFAULT layout: the operator's sections, in the order
// the founder specified (2026-08). Keys are catalogue keys (`fields.<key>`) —
// the storage address, stable across label renames.
//
// The section table itself lives in @theone/shared (permissions.ts) since
// 0015, because a section is also the middle level of every field's permission
// path — the API needs it to answer "may this role see Finances?". This module
// adds the icons and the helpers only the web uses.
//
// A field the sections do not name still renders (under MORE_SECTION_TITLE at
// the bottom) so a newly added admin field is never invisible; a key named
// here that no longer exists is silently skipped. Comp is deliberately in no
// section — it lives beside the search box (AllFieldsPanel).

import type { IconName } from '../components/Icon';
import {
  FIELD_SECTIONS as SHARED_SECTIONS,
  MORE_SECTION_TITLE as SHARED_MORE_TITLE,
  type FieldSectionDef,
} from '@theone/shared';

export interface FieldSection extends FieldSectionDef {
  icon: IconName;
}

/** Comp renders as a control in the tab's toolbar, not as a row. */
export const COMP_FIELD_KEY = 'fields.21. Comp';

/** Visit Type sits beside Comp in the same toolbar. It must be set on every
    work order, so an empty value renders in the danger ramp — and the
    dashboard's Needs Attention page counts the work orders still missing it. */
export const VISIT_TYPE_FIELD_KEY = 'fields.Visit Type';

/** Catch-all heading for fields no section names. */
export const MORE_SECTION_TITLE = SHARED_MORE_TITLE;
export const MORE_SECTION_ICON: IconName = 'list';

const SECTION_ICONS: Record<string, IconName> = {
  overview: 'file',
  client: 'briefcase',
  site: 'pin',
  finances: 'dollar',
  dates: 'clock',
  cico: 'check-circle',
  people: 'user',
  technician: 'wrench',
  payments: 'card',
  invoicing: 'clipboard',
  ar: 'flag',
  qc: 'check-check',
  other: 'dots',
  integrations: 'plug',
};

export const FIELD_SECTIONS: FieldSection[] = SHARED_SECTIONS.map((s) => ({
  ...s,
  icon: SECTION_ICONS[s.slug] ?? 'list',
}));

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
