// 0075 · The BRD registry: every module of The One, every feature in it, the
// controls on screen (labels as they are in the JSX), the rules the system
// enforces, the permission the API checks and the value each feature brings.
// One file per part under ./brd; this file only assembles them.
//
// WHEN A SCREEN, A BUTTON LABEL OR A RULE CHANGES, CHANGE ITS ENTRY and bump
// DOCS_REVIEWED_ON. tests/docs.test.ts fails when a sidebar item, an admin
// section, a work-order tab, an integration or a status exists that no entry
// mentions.

import type { DocPart } from './types';
import { PLATFORM_PART } from './brd/platform';
import { WORK_ORDERS_PART } from './brd/workOrders';
import { MONEY_PART } from './brd/money';
import { FIELD_PART } from './brd/field';
import { PORTFOLIO_PART, MAINTENANCE_PART } from './brd/portfolio';
import { COMMUNICATION_PART } from './brd/communication';
import { INSIGHT_PART } from './brd/insight';
import { AUTOMATION_PART, ADMIN_PART } from './brd/admin';

/** The date the prose was last reviewed against the screens (YYYY-MM-DD). */
export const DOCS_REVIEWED_ON = '2026-10-06';

export const BRD_PARTS: DocPart[] = [
  PLATFORM_PART,
  WORK_ORDERS_PART,
  MONEY_PART,
  FIELD_PART,
  PORTFOLIO_PART,
  MAINTENANCE_PART,
  COMMUNICATION_PART,
  INSIGHT_PART,
  AUTOMATION_PART,
  ADMIN_PART,
];

/** Flat list of every module, in BRD order. */
export const BRD_MODULES = BRD_PARTS.flatMap((p) => p.modules);
