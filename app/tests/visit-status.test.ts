/* Rule 2.2.2 — a check-in moves the work order On Site. The move itself is
 * services/visits.ts (moveOnSite, through changeStatus); this pins which
 * visit type lands where. */

import { describe, it, expect } from 'vitest';
import {
  ON_SITE_ASSESSMENT_STATUS_NAME,
  ON_SITE_JOB_STATUS_NAME,
  onSiteStatusNameForVisitType,
} from '../packages/shared/src/visitStatus';
import { DEFAULT_VISIT_TYPES } from '../packages/shared/src/index';

describe('onSiteStatusNameForVisitType', () => {
  it('sends an assessment visit to On Site (Assessment)', () => {
    expect(onSiteStatusNameForVisitType('Assessment')).toBe(ON_SITE_ASSESSMENT_STATUS_NAME);
    expect(onSiteStatusNameForVisitType('Assessment (A)')).toBe(ON_SITE_ASSESSMENT_STATUS_NAME);
    expect(onSiteStatusNameForVisitType('  assessment ')).toBe(ON_SITE_ASSESSMENT_STATUS_NAME);
  });

  it('sends a job visit and a return trip to On Site (Job)', () => {
    expect(onSiteStatusNameForVisitType('Job')).toBe(ON_SITE_JOB_STATUS_NAME);
    expect(onSiteStatusNameForVisitType('Job (J)')).toBe(ON_SITE_JOB_STATUS_NAME);
    expect(onSiteStatusNameForVisitType('Return trip')).toBe(ON_SITE_JOB_STATUS_NAME);
  });

  it('moves nothing for an unknown or empty type', () => {
    expect(onSiteStatusNameForVisitType('')).toBeNull();
    expect(onSiteStatusNameForVisitType(null)).toBeNull();
    expect(onSiteStatusNameForVisitType(undefined)).toBeNull();
    expect(onSiteStatusNameForVisitType('PM')).toBeNull();
  });

  it('covers every default visit type', () => {
    for (const t of DEFAULT_VISIT_TYPES) expect(onSiteStatusNameForVisitType(t)).not.toBeNull();
  });

  it('names the seeded statuses', () => {
    expect(ON_SITE_ASSESSMENT_STATUS_NAME).toBe('On Site (Assessment)');
    expect(ON_SITE_JOB_STATUS_NAME).toBe('On Site (Job)');
  });
});
