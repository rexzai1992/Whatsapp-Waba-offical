
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

// Default fallback to the keys provided by user in conversation
const DEFAULT_URL = 'https://hafkwvdcmfenbbzvufkv.supabase.co'
const DEFAULT_KEY = 'sb_publishable_McTQKF73jZv_ekbxLFw2IQ_LG8YuZ0o'

const SUPABASE_URL = process.env.SUPABASE_URL || DEFAULT_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || DEFAULT_KEY

if (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY) {
    console.log('Supabase: Using Service Role Key (Admin Access)')
} else {
    console.log('Supabase: Using Publishable Key (Restricted by RLS)')
}

// Note: For backend admin tasks (bypassing RLS), use the SERVICE_ROLE_KEY
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
