-- Extra webstore design controls for public storefront

BEGIN;

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS webstore_theme text DEFAULT 'editorial';

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS webstore_show_logo boolean NOT NULL DEFAULT true;

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS webstore_hero_badge text;

UPDATE public.company
SET webstore_theme = 'editorial'
WHERE webstore_theme IS NULL OR btrim(webstore_theme) = '';

UPDATE public.company
SET webstore_show_logo = true
WHERE webstore_show_logo IS NULL;

COMMIT;
