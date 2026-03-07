-- Company-level webstore presentation/settings

BEGIN;

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS webstore_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS webstore_title text;

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS webstore_subtitle text;

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS webstore_brand_color text DEFAULT '#00a884';

UPDATE public.company
SET webstore_enabled = true
WHERE webstore_enabled IS NULL;

UPDATE public.company
SET webstore_brand_color = '#00a884'
WHERE webstore_brand_color IS NULL OR btrim(webstore_brand_color) = '';

COMMIT;
