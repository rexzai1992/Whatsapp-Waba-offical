
import React, { useState, useEffect } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import DebugButton from './DebugButton'
import { getSocketUrl, resolveCompanyIdFromLocation } from './runtimeConfig'
import {
    MessageSquare,
    Zap,
    ShieldCheck,
    Globe,
    Cpu,
    Layers,
    ArrowRight,
    CheckCircle2
} from 'lucide-react'

const OAUTH_PENDING_COMPANY_KEY = 'pendingOAuthCompanyId'
const COMPANY_ID_REGEX = /^[a-z0-9-]{3,63}$/
const RESERVED_COMPANY_IDS = new Set(['www', 'admin', 'myadmin'])

export default function Login({
    onLogin,
    forcedMessage
}: {
    onLogin: (session: Session) => void;
    forcedMessage?: string | null;
}) {
    const SOCKET_URL = getSocketUrl()
    const [loading, setLoading] = useState(false)
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [companyId, setCompanyId] = useState('')
    const [companyName, setCompanyName] = useState('')
    const [hostCompanyId, setHostCompanyId] = useState<string | null>(null)
    const [mode, setMode] = useState<'login' | 'signup'>('login')
    const [msg, setMsg] = useState('')
    const [isVisible, setIsVisible] = useState(false)
    const [googleLoading, setGoogleLoading] = useState(false)

    const normalizeCompanyId = (value: string) => value.trim().toLowerCase()

    const validateCompanyInput = () => {
        const trimmedCompany = companyId.trim()
        const normalizedCompany = normalizeCompanyId(trimmedCompany)
        if (!trimmedCompany) {
            throw new Error('Company ID is required.')
        }
        if (hostCompanyId && normalizedCompany !== normalizeCompanyId(hostCompanyId)) {
            throw new Error(`Company ID must match subdomain "${hostCompanyId}".`)
        }
        if (!COMPANY_ID_REGEX.test(normalizedCompany) || normalizedCompany.startsWith('-') || normalizedCompany.endsWith('-')) {
            throw new Error('Company ID must be 3-63 chars, lowercase letters/numbers/hyphen, and cannot start or end with hyphen.')
        }
        if (RESERVED_COMPANY_IDS.has(normalizedCompany)) {
            throw new Error('This company ID is reserved.')
        }
        return { trimmedCompany, normalizedCompany }
    }

    const signInAndValidate = async (trimmedEmail: string, rawPassword: string, expectedCompanyId: string) => {
        const { data, error } = await supabase.auth.signInWithPassword({
            email: trimmedEmail,
            password: rawPassword
        })
        if (error) throw error
        if (!data?.session || !data?.user) {
            throw new Error('Login succeeded but no session was created. Please confirm your email or disable email confirmations in Supabase Auth settings.')
        }
        const metaCompany = data.user.user_metadata?.company_id || data.user.app_metadata?.company_id
        if (!metaCompany) {
            await supabase.auth.signOut()
            throw new Error('This account is not assigned to any company. Ask your admin to set up your account first.')
        }
        if (normalizeCompanyId(metaCompany) !== normalizeCompanyId(expectedCompanyId)) {
            await supabase.auth.signOut()
            throw new Error(`Company ID does not match this account. Use "${metaCompany}".`)
        }
        if (typeof window !== 'undefined') {
            window.localStorage.removeItem(OAUTH_PENDING_COMPANY_KEY)
        }
        return data.session
    }

    useEffect(() => {
        setIsVisible(true)
        const inferred = resolveCompanyIdFromLocation()
        if (!inferred) return
        setHostCompanyId(inferred)
        setCompanyId(inferred)
    }, [])

    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setMsg('')

        try {
            const { trimmedCompany, normalizedCompany } = validateCompanyInput()
            const trimmedEmail = email.trim().toLowerCase()
            if (!trimmedEmail) {
                throw new Error('Email is required.')
            }
            if (mode === 'signup' && password.length < 8) {
                throw new Error('Password must be at least 8 characters.')
            }
            if (mode === 'signup') {
                const res = await fetch(`${SOCKET_URL}/api/public/signup-company`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        companyId: normalizedCompany,
                        companyName: companyName.trim() || undefined,
                        email: trimmedEmail,
                        password
                    })
                })
                const json = await res.json().catch(() => null)
                if (!res.ok || !json?.success) {
                    throw new Error(json?.error || 'Failed to create company account.')
                }
            }

            const session = await signInAndValidate(trimmedEmail, password, trimmedCompany)
            onLogin(session)
        } catch (error: any) {
            setMsg(error.message)
        } finally {
            setLoading(false)
        }
    }

    const handleGoogleAuth = async () => {
        setMsg('')
        setGoogleLoading(true)
        try {
            if (mode === 'signup') {
                throw new Error('Google signup is not available. Use Create Company with email and password.')
            }
            const { normalizedCompany } = validateCompanyInput()
            if (typeof window === 'undefined') {
                throw new Error('Browser environment is required for Google sign-in.')
            }

            window.localStorage.setItem(OAUTH_PENDING_COMPANY_KEY, normalizedCompany)
            const { error } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: `${window.location.origin}${window.location.pathname}`
                }
            })
            if (error) throw error
        } catch (error: any) {
            if (typeof window !== 'undefined') {
                window.localStorage.removeItem(OAUTH_PENDING_COMPANY_KEY)
            }
            setMsg(error?.message || 'Google sign-in failed.')
            setGoogleLoading(false)
        }
    }

    const activeMessage = msg || forcedMessage || ''

    const services = [
        {
            icon: <Layers className="w-5 h-5 text-[#00a884]" />,
            title: "WABA Cloud Infrastructure",
            desc: "Run official Meta WhatsApp Business API profiles with zero lag."
        },
        {
            icon: <Cpu className="w-5 h-5 text-[#00a884]" />,
            title: "AI Chat Flow Assistant",
            desc: "Visual drag & drop builder for complex automated conversations."
        },
        {
            icon: <Zap className="w-5 h-5 text-[#00a884]" />,
            title: "Real-time Webhooks",
            desc: "Instant data synchronization with your existing CRM and API."
        },
        {
            icon: <ShieldCheck className="w-5 h-5 text-[#00a884]" />,
            title: "SaaS Admin Console",
            desc: "Full visibility and management over every connected profile."
        }
    ]

    return (
        <div className="min-h-screen bg-[#fcfdfd] text-[#111b21] flex overflow-hidden font-sans">
            {/* Left Side: Service Presentation (Light Mode) */}
            <div className={`hidden lg:flex lg:w-1/2 flex-col justify-center px-16 xl:px-24 bg-white border-r border-[#eceff1] transition-all duration-1000 ${isVisible ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-12'}`}>
                <div className="mb-12">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="bg-[#00a884] p-2 rounded-xl shadow-[0_8px_20px_rgba(0,168,132,0.15)]">
                            <MessageSquare className="w-8 h-8 text-white" />
                        </div>
                        <h1 className="text-3xl font-bold tracking-tight text-[#111b21]">Nexus WA <span className="text-[#00a884]">SaaS</span></h1>
                    </div>
                    <h2 className="text-5xl font-light leading-tight mb-6 text-[#111b21]">
                        The Operating System for <span className="font-bold border-b-4 border-[#00a884]">WhatsApp</span> Business.
                    </h2>
                    <p className="text-[#54656f] text-lg max-w-lg leading-relaxed">
                        Scale your customer engagement with the world's most powerful WhatsApp automation infrastructure.
                    </p>
                </div>

                <div className="grid gap-8">
                    {services.map((s, i) => (
                        <div key={i} className="flex gap-4 group">
                            <div className="flex-shrink-0 mt-1 bg-[#f0f2f5] p-3 rounded-lg group-hover:bg-[#00a884]/10 transition-colors">
                                {s.icon}
                            </div>
                            <div>
                                <h3 className="font-bold text-lg mb-1 text-[#111b21]">{s.title}</h3>
                                <p className="text-[#54656f] text-sm leading-relaxed">{s.desc}</p>
                            </div>
                        </div>
                    ))}
                </div>

                <div className="mt-16 pt-8 border-t border-[#eceff1] flex items-center gap-8 text-[#54656f]">
                    <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-[#00a884]" />
                        <span className="text-xs uppercase tracking-widest font-bold">End-to-End Encrypted</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Globe className="w-4 h-4 text-[#00a884]" />
                        <span className="text-xs uppercase tracking-widest font-bold">Global Scale</span>
                    </div>
                </div>
            </div>

            {/* Right Side: Authentication (Light Mode) */}
            <div className="w-full lg:w-1/2 flex flex-col justify-center items-center px-6 relative bg-[#fcfdfd]">
                {/* Decorative background elements - lighter flow */}
                <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-[#00a884] rounded-full filter blur-[120px] opacity-5 animate-pulse"></div>

                <div className={`w-full max-w-md transition-all duration-1000 delay-300 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-12'}`}>
                    <div className="lg:hidden flex items-center gap-3 mb-12 justify-center">
                        <div className="bg-[#00a884] p-2 rounded-xl">
                            <MessageSquare className="w-8 h-8 text-white" />
                        </div>
                        <h1 className="text-2xl font-bold tracking-tight">Nexus WA <span className="text-[#00a884]">SaaS</span></h1>
                    </div>

                    <div className="bg-white p-10 rounded-3xl border border-[#eceff1] shadow-[0_20px_50px_rgba(0,0,0,0.04)] relative">
                        <div className="mb-10 text-center lg:text-left">
                            <h2 className="text-2xl font-bold mb-2 text-[#111b21]">
                                {mode === 'login' ? 'Welcome Back' : 'Create Company Account'}
                            </h2>
                            <p className="text-[#54656f]">
                                {mode === 'login' ? 'Manage your WABA profiles with Nexus WA.' : 'Create your company owner account to begin.'}
                            </p>
                        </div>

                        <div className="flex bg-[#f0f2f5] p-1 rounded-2xl mb-8 border border-[#eceff1]">
                            <button
                                onClick={() => setMode('login')}
                                className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all duration-300 ${mode === 'login' ? 'bg-white text-[#00a884] shadow-sm' : 'text-[#54656f] hover:text-[#111b21]'}`}
                            >
                                Sign In
                            </button>
                            <button
                                onClick={() => setMode('signup')}
                                className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all duration-300 ${mode === 'signup' ? 'bg-white text-[#00a884] shadow-sm' : 'text-[#54656f] hover:text-[#111b21]'}`}
                            >
                                Create Company
                            </button>
                        </div>

                        <form onSubmit={handleAuth} className="space-y-6">
                            <div className="space-y-2">
                                <label className="text-xs font-bold text-[#54656f] uppercase tracking-wider ml-1">Company ID</label>
                                <input
                                    type="text"
                                    placeholder="company-id"
                                    value={companyId}
                                    onChange={e => setCompanyId(e.target.value)}
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] text-[#111b21] px-4 py-4 rounded-xl focus:border-[#00a884] focus:bg-white outline-none transition-all placeholder:text-[#aebac1]"
                                    required
                                />
                                {hostCompanyId && (
                                    <p className="text-xs text-[#54656f] px-1">
                                        Subdomain detected: <span className="font-semibold text-[#111b21]">{hostCompanyId}</span>
                                    </p>
                                )}
                                {mode === 'signup' && !hostCompanyId && (
                                    <p className="text-xs text-[#54656f] px-1">
                                        Your workspace URL will be <span className="font-semibold text-[#111b21]">{companyId.trim().toLowerCase() || 'company-id'}.2fast.xyz</span>
                                    </p>
                                )}
                            </div>
                            {mode === 'signup' && (
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-[#54656f] uppercase tracking-wider ml-1">Company Name (Optional)</label>
                                    <input
                                        type="text"
                                        placeholder="Your Company Name"
                                        value={companyName}
                                        onChange={e => setCompanyName(e.target.value)}
                                        className="w-full bg-[#f8f9fa] border border-[#eceff1] text-[#111b21] px-4 py-4 rounded-xl focus:border-[#00a884] focus:bg-white outline-none transition-all placeholder:text-[#aebac1]"
                                    />
                                </div>
                            )}
                            <div className="space-y-2">
                                <label className="text-xs font-bold text-[#54656f] uppercase tracking-wider ml-1">Email Address</label>
                                <input
                                    type="email"
                                    placeholder="name@company.com"
                                    value={email}
                                    onChange={e => setEmail(e.target.value)}
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] text-[#111b21] px-4 py-4 rounded-xl focus:border-[#00a884] focus:bg-white outline-none transition-all placeholder:text-[#aebac1]"
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <div className="flex justify-between items-center px-1">
                                    <label className="text-xs font-bold text-[#54656f] uppercase tracking-wider">Password</label>
                                    {mode === 'login' && (
                                        <button type="button" className="text-xs text-[#00a884] hover:underline font-medium">Forgot Password?</button>
                                    )}
                                </div>
                                <input
                                    type="password"
                                    placeholder="••••••••"
                                    value={password}
                                    onChange={e => setPassword(e.target.value)}
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] text-[#111b21] px-4 py-4 rounded-xl focus:border-[#00a884] focus:bg-white outline-none transition-all placeholder:text-[#aebac1]"
                                    required
                                />
                            </div>

                            {activeMessage && (
                                <div className={`text-sm text-center p-4 rounded-xl border flex items-center gap-3 transition-all ${activeMessage.includes('Success') || activeMessage.includes('Check') ? 'bg-[#25d366]/10 border-[#25d366]/20 text-[#008069]' : 'bg-rose-500/10 border-rose-500/20 text-rose-500'}`}>
                                    {activeMessage.includes('Success') || activeMessage.includes('Check') ? <CheckCircle2 className="w-5 h-5 flex-shrink-0" /> : <div className="w-5 h-5 rounded-full border-2 border-current flex items-center justify-center font-bold text-xs">!</div>}
                                    <span className="leading-tight text-left">{activeMessage}</span>
                                </div>
                            )}

                            <button
                                disabled={loading}
                                className="w-full bg-[#00a884] hover:bg-[#008f6f] text-white font-bold py-4.5 rounded-xl transition-all shadow-[0_4px_12px_rgba(0,168,132,0.25)] hover:shadow-[0_8px_20px_rgba(0,168,132,0.3)] active:scale-[0.98] flex items-center justify-center gap-3 group h-[58px]"
                            >
                                {loading ? (
                                    <div className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin"></div>
                                ) : (
                                    <>
                                        <span>{mode === 'login' ? 'Access Dashboard' : 'Create Company & Sign In'}</span>
                                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                                    </>
                                )}
                            </button>
                            {mode === 'login' && (
                                <button
                                    type="button"
                                    onClick={handleGoogleAuth}
                                    disabled={loading || googleLoading}
                                    className="w-full border border-[#d7dee3] bg-white hover:bg-[#f8f9fa] text-[#111b21] font-bold py-4 rounded-xl transition-all flex items-center justify-center gap-3 disabled:opacity-60"
                                >
                                    {googleLoading ? (
                                        <div className="w-5 h-5 border-2 border-[#9aa7b2] border-t-[#111b21] rounded-full animate-spin"></div>
                                    ) : (
                                        <>
                                            <span className="inline-block w-5 h-5 rounded-full border border-[#d7dee3] bg-white text-[11px] leading-5 text-center font-black text-[#ea4335]">G</span>
                                            <span>Sign in with Google</span>
                                        </>
                                    )}
                                </button>
                            )}
                        </form>
                    </div>

                    <div className="mt-8 text-center text-[#54656f] text-sm space-y-2">
                        <p>
                            Need help?
                            {' '}
                            <a href="mailto:hello@2fast.xyz" className="text-[#111b21] font-semibold hover:underline">hello@2fast.xyz</a>
                        </p>
                        <p>
                            <a href="/support" className="text-[#111b21] font-medium hover:underline">Support</a>
                            {' · '}
                            <a href="/privacy-policy" className="text-[#111b21] font-medium hover:underline">Privacy Policy</a>
                            {' · '}
                            <a href="/terms-and-conditions" className="text-[#111b21] font-medium hover:underline">Terms & Conditions</a>
                        </p>
                    </div>
                </div>
            </div>

            {import.meta.env.DEV && (
                <div className="fixed bottom-6 right-6 z-[200] flex flex-col items-end gap-3">
                    <DebugButton
                        payload={{
                            ts: new Date().toISOString(),
                            env: {
                                mode: import.meta.env.MODE,
                                socketUrl: SOCKET_URL
                            },
                            supabase: {
                                url: (supabase as any)?.supabaseUrl || import.meta.env.VITE_SUPABASE_URL || 'unknown'
                            },
                            auth: {
                                mode,
                                loading,
                                email,
                                companyId,
                                hasPassword: Boolean(password)
                            },
                            lastMessage: msg || null,
                            location: typeof window !== 'undefined' ? window.location.href : null
                        }}
                    />
                </div>
            )}

            <style dangerouslySetInnerHTML={{
                __html: `
                @keyframes pulse {
                    0%, 100% { opacity: 0.05; transform: scale(1); }
                    50% { opacity: 0.08; transform: scale(1.1); }
                }
                .animate-pulse {
                    animation: pulse 8s cubic-bezier(0.4, 0, 0.6, 1) infinite;
                }
            `}} />
        </div>
    )
}
