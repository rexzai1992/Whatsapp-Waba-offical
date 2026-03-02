-- Prevent cross-tenant webhook collisions by allowing a phone_number_id
-- to be active in only one waba_configs row at a time.
--
-- Run this query first and resolve any duplicates before creating the index:
--
-- SELECT phone_number_id, array_agg(profile_id) AS profiles, count(*) AS total
-- FROM public.waba_configs
-- WHERE enabled IS TRUE AND phone_number_id IS NOT NULL
-- GROUP BY phone_number_id
-- HAVING count(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS waba_configs_enabled_phone_number_id_uniq
ON public.waba_configs (phone_number_id)
WHERE enabled IS TRUE AND phone_number_id IS NOT NULL;
