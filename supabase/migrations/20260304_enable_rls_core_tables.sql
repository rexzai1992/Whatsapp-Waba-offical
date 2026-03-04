-- Enable RLS and add authenticated read policies for core multi-tenant tables.
-- This resolves Supabase linter errors:
--   - rls_disabled_in_public
--   - sensitive_columns_exposed

BEGIN;

-- Resolve company scope for current authenticated user.
-- SECURITY DEFINER is required so this helper keeps working after RLS is enabled.
CREATE OR REPLACE FUNCTION public.current_company_ids()
RETURNS TABLE(company_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    select distinct p.company_id
    from public.profiles p
    where p.user_id = auth.uid()
      and p.company_id is not null
  union
    select distinct ur.company_id
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.company_id is not null
$$;

REVOKE ALL ON FUNCTION public.current_company_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_company_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_company_ids() TO service_role;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quick_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waba_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waba_oauth_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_roles_select_own ON public.user_roles;
CREATE POLICY user_roles_select_own
ON public.user_roles
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS company_select_by_membership ON public.company;
CREATE POLICY company_select_by_membership
ON public.company
FOR SELECT
TO authenticated
USING (
  id in (
    select c.company_id
    from public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS users_select_by_company ON public.users;
CREATE POLICY users_select_by_company
ON public.users
FOR SELECT
TO authenticated
USING (
  company_id in (
    select c.company_id
    from public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS messages_select_by_user_company ON public.messages;
CREATE POLICY messages_select_by_user_company
ON public.messages
FOR SELECT
TO authenticated
USING (
  exists (
    select 1
    from public.users u
    where u.id = messages.user_id
      and u.company_id in (
        select c.company_id
        from public.current_company_ids() c
      )
  )
);

DROP POLICY IF EXISTS workflows_select_by_company ON public.workflows;
CREATE POLICY workflows_select_by_company
ON public.workflows
FOR SELECT
TO authenticated
USING (
  company_id in (
    select c.company_id
    from public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS profiles_select_by_company_or_self ON public.profiles;
CREATE POLICY profiles_select_by_company_or_self
ON public.profiles
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  or company_id in (
    select c.company_id
    from public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS quick_replies_select_by_company ON public.quick_replies;
CREATE POLICY quick_replies_select_by_company
ON public.quick_replies
FOR SELECT
TO authenticated
USING (
  company_id in (
    select c.company_id
    from public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS waba_configs_select_by_company ON public.waba_configs;
CREATE POLICY waba_configs_select_by_company
ON public.waba_configs
FOR SELECT
TO authenticated
USING (
  company_id in (
    select c.company_id
    from public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS company_ai_settings_select_by_company ON public.company_ai_settings;
CREATE POLICY company_ai_settings_select_by_company
ON public.company_ai_settings
FOR SELECT
TO authenticated
USING (
  company_id in (
    select c.company_id
    from public.current_company_ids() c
  )
);

DROP POLICY IF EXISTS waba_oauth_states_select_by_company_or_owner ON public.waba_oauth_states;
CREATE POLICY waba_oauth_states_select_by_company_or_owner
ON public.waba_oauth_states
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  or company_id in (
    select c.company_id
    from public.current_company_ids() c
  )
);

COMMIT;
