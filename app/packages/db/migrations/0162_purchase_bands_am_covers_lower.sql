-- 0162 · Purchase requests: the AM approves every band below their own
-- (Elise, 2026-11-25).
--
-- 0115 gave purchase requests $500 to $3,000 to TL / ATL and $3,000 and over
-- to the AM, so an AM could approve a $5,000 purchase request but not a $600
-- one. Elise: the AM approves anything under the most they may approve, as
-- payments already do (0149's ladder names the AM in every band to $50,000).
--
-- So every purchase_request band that names roles and sits below the AM's
-- highest band gains `am`. A band with no roles (Under $500: anyone with the
-- permission) is left as it is, and so is a band that already names the AM.
-- Admin › Settings › Approval tiers still edits the bands.

UPDATE approval_tier
   SET roles = array_append(roles, 'am'),
       updated_at = now()
 WHERE kind = 'purchase_request'
   AND cardinality(roles) > 0
   AND NOT ('am' = ANY (roles))
   AND max_amount IS NOT NULL
   AND max_amount <= (
         SELECT max(COALESCE(max_amount, 'Infinity'::numeric))
           FROM approval_tier
          WHERE kind = 'purchase_request'
            AND 'am' = ANY (roles)
       );
