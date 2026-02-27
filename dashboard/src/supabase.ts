
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL =
    import.meta.env.VITE_SUPABASE_URL ||
    'https://zksutvoulgdjgkowlfko.supabase.co'

const SUPABASE_KEY =
    import.meta.env.VITE_SUPABASE_ANON_KEY ||
    import.meta.env.VITE_SUPABASE_KEY ||
    'sb_publishable_r6Wg1NbiJzY9HtXPvgJTug_HLeYLZHY'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
