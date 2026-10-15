// 0075 · Admin › Documentation — the living BRD, SOP and lifecycle.
export * from './types';
export { BRD_PARTS, BRD_MODULES, DOCS_REVIEWED_ON } from './brd';
export { BUSINESS_RULES } from './rules';
export { SOP } from './sop';
export { LIFECYCLE } from './lifecycle';
export { brdMarkdown, sopMarkdown, lifecycleMarkdown, docsVersionLine } from './markdown';

import { BRD_PARTS as _PARTS, DOCS_REVIEWED_ON as _REVIEWED } from './brd';
import { BUSINESS_RULES as _RULES } from './rules';
import { SOP as _SOP } from './sop';
import { LIFECYCLE as _LIFECYCLE } from './lifecycle';
import type { DocsContent } from './types';

/** L5 (UAT Wave D): the registry in one payload, for the API to serve. The
    web never imports the registry itself (tests/uat-wave-d.test.ts pins it). */
export function docsContent(): DocsContent {
  return { brd_parts: _PARTS, rules: _RULES, sop: _SOP, lifecycle: _LIFECYCLE, reviewed_on: _REVIEWED };
}

/** The admin section the page lives under (`admin/docs` view). */
export const DOCS_PERM_KEY = 'admin/docs';
