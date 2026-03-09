-- Persist named template attributes per customer (used by template sender + profile card)

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS template_attributes jsonb;

UPDATE public.users
SET template_attributes = '[]'::jsonb
WHERE template_attributes IS NULL;

ALTER TABLE public.users
  ALTER COLUMN template_attributes SET DEFAULT '[]'::jsonb;

ALTER TABLE public.users
  ALTER COLUMN template_attributes SET NOT NULL;

COMMIT;
