-- Invoice generation foundation for WABA document workflows:
-- - company invoice presets
-- - invoices + invoice_items (+ optional clients)
-- - storage bucket path convention: {company-id}/invoice/{invoice-name}.pdf

BEGIN;

ALTER TABLE public.company ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS registration_number text;
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS default_currency text DEFAULT 'USD';
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS default_invoice_prefix text DEFAULT 'INV';
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS default_invoice_notes text;
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS default_payment_instructions text;
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS invoice_template_name text DEFAULT 'default';
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS invoice_template_config jsonb DEFAULT '{}'::jsonb;

UPDATE public.company
SET
  default_currency = COALESCE(NULLIF(BTRIM(default_currency), ''), 'USD'),
  default_invoice_prefix = COALESCE(NULLIF(BTRIM(default_invoice_prefix), ''), 'INV'),
  invoice_template_name = COALESCE(NULLIF(BTRIM(invoice_template_name), ''), 'default');

CREATE TABLE IF NOT EXISTS public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES public.company(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  email text,
  address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS company_id text REFERENCES public.company(id) ON DELETE CASCADE;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES public.company(id) ON DELETE CASCADE,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  invoice_name text NOT NULL,
  invoice_number text NOT NULL,
  invoice_title text,
  invoice_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  currency text NOT NULL DEFAULT 'USD',
  company_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  discount numeric(14,2) NOT NULL DEFAULT 0,
  tax numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  notes text,
  payment_instructions text,
  pdf_path text,
  public_path text,
  public_url text,
  waba_document_url text,
  status text NOT NULL DEFAULT 'draft',
  generated_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'generated', 'sent', 'viewed', 'paid', 'overdue', 'cancelled')),
  CONSTRAINT invoices_subtotal_non_negative CHECK (subtotal >= 0),
  CONSTRAINT invoices_discount_non_negative CHECK (discount >= 0),
  CONSTRAINT invoices_tax_non_negative CHECK (tax >= 0),
  CONSTRAINT invoices_total_non_negative CHECK (total >= 0)
);

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS company_id text REFERENCES public.company(id) ON DELETE CASCADE;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS invoice_name text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS invoice_number text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS invoice_title text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS invoice_date date DEFAULT CURRENT_DATE;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS currency text DEFAULT 'USD';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS company_snapshot jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS client_snapshot jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS subtotal numeric(14,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS discount numeric(14,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS tax numeric(14,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS total numeric(14,2) DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_instructions text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS pdf_path text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS public_path text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS public_url text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS waba_document_url text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS generated_at timestamptz;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  item_index integer NOT NULL DEFAULT 0,
  item_name text NOT NULL,
  description text,
  quantity numeric(14,2) NOT NULL,
  unit_price numeric(14,2) NOT NULL,
  line_total numeric(14,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES public.invoices(id) ON DELETE CASCADE;
ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS item_index integer DEFAULT 0;
ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS item_name text;
ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS quantity numeric(14,2);
ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS unit_price numeric(14,2);
ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS line_total numeric(14,2);
ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoice_items_quantity_positive'
      AND conrelid = 'public.invoice_items'::regclass
  ) THEN
    ALTER TABLE public.invoice_items
      ADD CONSTRAINT invoice_items_quantity_positive CHECK (quantity > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoice_items_unit_price_non_negative'
      AND conrelid = 'public.invoice_items'::regclass
  ) THEN
    ALTER TABLE public.invoice_items
      ADD CONSTRAINT invoice_items_unit_price_non_negative CHECK (unit_price >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoice_items_line_total_non_negative'
      AND conrelid = 'public.invoice_items'::regclass
  ) THEN
    ALTER TABLE public.invoice_items
      ADD CONSTRAINT invoice_items_line_total_non_negative CHECK (line_total >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoices_status_check'
      AND conrelid = 'public.invoices'::regclass
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'generated', 'sent', 'viewed', 'paid', 'overdue', 'cancelled'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_company_invoice_name_unique
ON public.invoices(company_id, invoice_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_company_invoice_number_unique
ON public.invoices(company_id, invoice_number);

CREATE INDEX IF NOT EXISTS idx_invoices_company_created_at
ON public.invoices(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_company_due_date
ON public.invoices(company_id, due_date DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_status
ON public.invoices(status);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id
ON public.invoice_items(invoice_id, item_index, created_at);

CREATE INDEX IF NOT EXISTS idx_clients_company_id
ON public.clients(company_id, created_at DESC);

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clients_select_by_company ON public.clients;
CREATE POLICY clients_select_by_company
ON public.clients
FOR SELECT
TO authenticated
USING (
  company_id IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS clients_insert_by_company ON public.clients;
CREATE POLICY clients_insert_by_company
ON public.clients
FOR INSERT
TO authenticated
WITH CHECK (
  company_id IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS clients_update_by_company ON public.clients;
CREATE POLICY clients_update_by_company
ON public.clients
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

DROP POLICY IF EXISTS clients_delete_by_company ON public.clients;
CREATE POLICY clients_delete_by_company
ON public.clients
FOR DELETE
TO authenticated
USING (
  company_id IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS invoices_select_by_company ON public.invoices;
CREATE POLICY invoices_select_by_company
ON public.invoices
FOR SELECT
TO authenticated
USING (
  company_id IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS invoices_insert_by_company ON public.invoices;
CREATE POLICY invoices_insert_by_company
ON public.invoices
FOR INSERT
TO authenticated
WITH CHECK (
  company_id IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS invoices_update_by_company ON public.invoices;
CREATE POLICY invoices_update_by_company
ON public.invoices
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

DROP POLICY IF EXISTS invoices_delete_by_company ON public.invoices;
CREATE POLICY invoices_delete_by_company
ON public.invoices
FOR DELETE
TO authenticated
USING (
  company_id IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS invoice_items_select_by_company ON public.invoice_items;
CREATE POLICY invoice_items_select_by_company
ON public.invoice_items
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.invoices i
    WHERE i.id = invoice_items.invoice_id
      AND i.company_id IN (
        SELECT c.company_id
        FROM public.current_company_ids() c
      )
  )
);

DROP POLICY IF EXISTS invoice_items_insert_by_company ON public.invoice_items;
CREATE POLICY invoice_items_insert_by_company
ON public.invoice_items
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.invoices i
    WHERE i.id = invoice_items.invoice_id
      AND i.company_id IN (
        SELECT c.company_id
        FROM public.current_company_ids() c
      )
  )
);

DROP POLICY IF EXISTS invoice_items_update_by_company ON public.invoice_items;
CREATE POLICY invoice_items_update_by_company
ON public.invoice_items
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.invoices i
    WHERE i.id = invoice_items.invoice_id
      AND i.company_id IN (
        SELECT c.company_id
        FROM public.current_company_ids() c
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.invoices i
    WHERE i.id = invoice_items.invoice_id
      AND i.company_id IN (
        SELECT c.company_id
        FROM public.current_company_ids() c
      )
  )
);

DROP POLICY IF EXISTS invoice_items_delete_by_company ON public.invoice_items;
CREATE POLICY invoice_items_delete_by_company
ON public.invoice_items
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.invoices i
    WHERE i.id = invoice_items.invoice_id
      AND i.company_id IN (
        SELECT c.company_id
        FROM public.current_company_ids() c
      )
  )
);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'invoices',
  'invoices',
  true,
  10485760,
  ARRAY['application/pdf']
)
ON CONFLICT (id)
DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS invoices_objects_public_read ON storage.objects;
CREATE POLICY invoices_objects_public_read
ON storage.objects
FOR SELECT
USING (bucket_id = 'invoices');

DROP POLICY IF EXISTS invoices_objects_auth_insert ON storage.objects;
CREATE POLICY invoices_objects_auth_insert
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'invoices'
  AND split_part(name, '/', 1) IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS invoices_objects_auth_update ON storage.objects;
CREATE POLICY invoices_objects_auth_update
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'invoices'
  AND split_part(name, '/', 1) IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
)
WITH CHECK (
  bucket_id = 'invoices'
  AND split_part(name, '/', 1) IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS invoices_objects_auth_delete ON storage.objects;
CREATE POLICY invoices_objects_auth_delete
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'invoices'
  AND split_part(name, '/', 1) IN (
    SELECT c.company_id
    FROM public.current_company_ids() c
  )
);

COMMIT;
