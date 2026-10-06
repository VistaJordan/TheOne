// 0075 · Admin › Documentation — the living BRD, SOP and lifecycle.
export * from './types';
export { BRD_PARTS, BRD_MODULES, DOCS_REVIEWED_ON } from './brd';
export { BUSINESS_RULES } from './rules';
export { SOP } from './sop';
export { LIFECYCLE } from './lifecycle';
export { brdMarkdown, sopMarkdown, lifecycleMarkdown, docsVersionLine } from './markdown';

/** The admin section the page lives under (`admin/docs` view). */
export const DOCS_PERM_KEY = 'admin/docs';
