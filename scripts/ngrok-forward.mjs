#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

const port = Number(process.env.NGROK_PORT || process.argv[2] || 3000)
const forwardPath = process.env.NGROK_FORWARD_PATH || '/webhook'
const apiUrl = process.env.NGROK_API_URL || 'http://127.0.0.1:4040/api/tunnels'

const supabaseUrl = process.env.SUPABASE_URL
const projectRef =
    process.env.SUPABASE_PROJECT_REF ||
    (supabaseUrl ? new URL(supabaseUrl).hostname.split('.')[0] : '')

if (!projectRef) {
    console.error('Missing SUPABASE_PROJECT_REF or SUPABASE_URL in env.')
    process.exit(1)
}

async function fetchTunnels() {
    try {
        const res = await fetch(apiUrl)
        if (!res.ok) return []
        const data = await res.json()
        return Array.isArray(data?.tunnels) ? data.tunnels : []
    } catch {
        return []
    }
}

function pickPublicUrl(tunnels) {
    const httpsTunnel = tunnels.find(t => typeof t.public_url === 'string' && t.public_url.startsWith('https://'))
    if (httpsTunnel) return httpsTunnel.public_url
    const httpTunnel = tunnels.find(t => typeof t.public_url === 'string' && t.public_url.startsWith('http://'))
    return httpTunnel ? httpTunnel.public_url : null
}

async function ensureNgrokTunnel() {
    let tunnels = await fetchTunnels()
    let publicUrl = pickPublicUrl(tunnels)
    if (publicUrl) return publicUrl

    const autoStart = process.env.NGROK_AUTOSTART !== 'false'
    if (!autoStart) {
        throw new Error('ngrok is not running. Start it or set NGROK_AUTOSTART=true.')
    }

    const ngrok = spawn('ngrok', ['http', String(port)], {
        stdio: 'ignore',
        detached: true
    })
    ngrok.unref()

    for (let i = 0; i < 30; i += 1) {
        await sleep(500)
        tunnels = await fetchTunnels()
        publicUrl = pickPublicUrl(tunnels)
        if (publicUrl) return publicUrl
    }

    throw new Error('ngrok tunnel not found on local API after 15s.')
}

async function main() {
    const publicUrl = await ensureNgrokTunnel()
    const forwardUrl = new URL(forwardPath, publicUrl).toString()

    console.log(`ngrok public URL: ${publicUrl}`)
    console.log(`Setting WABA_FORWARD_URL to: ${forwardUrl}`)

    execFileSync(
        'supabase',
        ['secrets', 'set', `WABA_FORWARD_URL=${forwardUrl}`, '--project-ref', projectRef],
        { stdio: 'inherit' }
    )

    console.log('Supabase secret updated.')
}

main().catch(err => {
    console.error(err?.message || err)
    process.exit(1)
})
