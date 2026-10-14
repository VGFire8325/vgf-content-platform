-- Flamerite and Solution Electric Fires products are sold as Sustainable
-- Hearth, so their orders go to the same supplier and address (confirmed by
-- Brendan 2026-10-14). Data-only and re-runnable: each name is added only if
-- it is not already in the list. Already applied to production by hand.
UPDATE "suppliers"
SET "vendor_names" = "vendor_names" || ARRAY(
	SELECT v FROM unnest(ARRAY['Flamerite', 'Solution Electric Fires']) AS v
	WHERE v <> ALL ("vendor_names")
)
WHERE "id" = 'sustainable_hearth';
