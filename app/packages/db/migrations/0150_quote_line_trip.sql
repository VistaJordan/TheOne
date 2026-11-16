-- 0150 · Quote line types: Trip in, Service and Part out of the picker
-- (Elise, 2026-11-16, UAT #17 / #22).
--
-- The builder now offers Labor · Material · Trip · Fee · Discount. A trip
-- charge is its own type ('trip') instead of a Service line named "Trip", and
-- a part is a Material. Lines already on file follow, so every quote reads the
-- same vocabulary: a Service line whose description starts with "Trip" becomes
-- a Trip line, a Part line becomes a Material line. The amounts do not move
-- (neither type bills overtime; tax and markup ride on the line). Any other
-- Service line keeps its type and still prices and prints as before; 'service'
-- and 'part' stay legal so an older revision snapshot or an AI draft never
-- fails the CHECK.

ALTER TABLE quote_line DROP CONSTRAINT IF EXISTS quote_line_line_type_check;
ALTER TABLE quote_line ADD CONSTRAINT quote_line_line_type_check
  CHECK (line_type IN ('service','labor','part','material','fee','discount','trip'));

UPDATE quote_line SET line_type = 'trip'
 WHERE line_type = 'service' AND description ~* '^\s*trip\M';

UPDATE quote_line SET line_type = 'material' WHERE line_type = 'part';
