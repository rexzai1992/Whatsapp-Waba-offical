-- Webstore product catalog + invoice product linking

BEGIN;

CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES public.company(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  sku text,
  description text,
  price numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  stock_qty integer NOT NULL DEFAULT 0,
  image_url text,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_price_non_negative CHECK (price >= 0),
  CONSTRAINT products_stock_non_negative CHECK (stock_qty >= 0)
);

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS company_id text REFERENCES public.company(id) ON DELETE CASCADE;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS sku text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS price numeric(14,2) DEFAULT 0;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS currency text DEFAULT 'USD';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS stock_qty integer DEFAULT 0;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES public.products(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_company_slug_unique
ON public.products(company_id, slug);

CREATE INDEX IF NOT EXISTS idx_products_company_active_created
ON public.products(company_id, is_active, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_products_company_name
ON public.products(company_id, name);

CREATE INDEX IF NOT EXISTS idx_invoice_items_product_id
ON public.invoice_items(product_id);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_select_by_company ON public.products;
CREATE POLICY products_select_by_company
ON public.products
FOR SELECT
TO authenticated
USING (
  company_id IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS products_insert_by_company ON public.products;
CREATE POLICY products_insert_by_company
ON public.products
FOR INSERT
TO authenticated
WITH CHECK (
  company_id IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS products_update_by_company ON public.products;
CREATE POLICY products_update_by_company
ON public.products
FOR UPDATE
TO authenticated
USING (
  company_id IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
)
WITH CHECK (
  company_id IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS products_delete_by_company ON public.products;
CREATE POLICY products_delete_by_company
ON public.products
FOR DELETE
TO authenticated
USING (
  company_id IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

COMMIT;
