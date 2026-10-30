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

// Who asked for a status change a manager approved (Elise, 2026-10-30). The
// `status_changed` row is signed by the approver and carries
// `via: 'approval_task'` + `approval_task_id`; this fragment adds
// `requested_by: {id, name}` — the person who raised that status-change
// request — so the work order's Audit trail and Admin › Audit (screen and
// CSV) name both people. Read from the request itself, so rows written before
// this change read the same. Needs the row as `a` (activity_log).
export const AFTER_WITH_REQUESTER_SQL = `(CASE
    WHEN a.action = 'status_changed' AND a.after ->> 'via' = 'approval_task'
     AND a.after ? 'approval_task_id' AND NOT (a.after ? 'requested_by')
    THEN a.after || jsonb_build_object('requested_by',
           (SELECT jsonb_build_object('id', rq.id, 'name', rq.display_name)
              FROM approval_task rt JOIN principal rq ON rq.id = rt.created_by
             WHERE rt.id::text = a.after ->> 'approval_task_id' AND rt.type = 'status_change'))
    ELSE a.after END)`;
