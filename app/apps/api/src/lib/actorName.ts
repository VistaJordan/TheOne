// Who an audit row names, as the history panels print it (0088).
//
// A change made while a super admin was viewing as somebody is signed by the
// super admin, with `activity_log.viewing_as_id` naming whom they were viewing
// as (migration 0088's trigger). Every history that prints one name per row —
// the work order's Audit trail and Updates feed, field and visit history, the
// site, asset, client and vendor histories — reads it through this fragment,
// so they all say "Jordan Brown (viewing as Dana Fox)". Admin › Audit carries
// the two people separately (services/auditLog.ts).
//
// Needs the row as `a` (activity_log) and its actor as `p` (principal). With
// a LEFT JOIN and no actor it is NULL, as `p.display_name` was.

export const VIEWING_AS_NAME_SQL = `(SELECT v.display_name FROM principal v WHERE v.id = a.viewing_as_id)`;

export const ACTOR_NAME_SQL = `(p.display_name || COALESCE(' (viewing as ' || ${VIEWING_AS_NAME_SQL} || ')', ''))`;
