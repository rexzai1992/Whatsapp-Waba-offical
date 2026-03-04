-- Query performance indexes for high-frequency PostgREST/service_role calls.
-- Safe to run multiple times.

BEGIN;

-- Top hot path: messages by user_id with created_at DESC and LIMIT.
CREATE INDEX IF NOT EXISTS idx_messages_user_created_at_desc
ON public.messages(user_id, created_at DESC);

-- Workflow memory read path (workflow_state IS NOT NULL).
CREATE INDEX IF NOT EXISTS idx_messages_user_created_at_desc_workflow_state
ON public.messages(user_id, created_at DESC)
WHERE workflow_state IS NOT NULL;

-- Company-scoped contact list lookups.
CREATE INDEX IF NOT EXISTS idx_users_company_id
ON public.users(company_id);

-- Profile list refresh per company ordered by created_at.
CREATE INDEX IF NOT EXISTS idx_profiles_company_created_at
ON public.profiles(company_id, created_at ASC);

-- Company-scoped workflow reads/writes.
CREATE INDEX IF NOT EXISTS idx_workflows_company_id
ON public.workflows(company_id);

-- Company-scoped quick replies.
CREATE INDEX IF NOT EXISTS idx_quick_replies_company_id
ON public.quick_replies(company_id);

-- Company-scoped WABA config reads.
CREATE INDEX IF NOT EXISTS idx_waba_configs_company_id
ON public.waba_configs(company_id);

-- Team/permission lookups.
CREATE INDEX IF NOT EXISTS idx_user_roles_user_id
ON public.user_roles(user_id);

CREATE INDEX IF NOT EXISTS idx_user_roles_company_id
ON public.user_roles(company_id);

-- Per-user auth/profile lookups.
CREATE INDEX IF NOT EXISTS idx_profiles_user_id
ON public.profiles(user_id);

COMMIT;
