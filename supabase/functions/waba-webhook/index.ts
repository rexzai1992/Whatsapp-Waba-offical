// Supabase Edge Function: WABA webhook (GET verify + POST delivery)
// This function verifies Meta's webhook and forwards payloads to your Node backend.
// Set secrets: WABA_VERIFY_TOKEN, WABA_APP_SECRET, WABA_FORWARD_URL

const VERIFY_TOKEN = Deno.env.get('WABA_VERIFY_TOKEN') || ''
const APP_SECRET = Deno.env.get('WABA_APP_SECRET') || ''
const FORWARD_URL = Deno.env.get('WABA_FORWARD_URL') || ''

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

async function verifySignature(payload: string, signatureHeader: string, appSecret: string) {
  if (!appSecret) return true
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false

  const signature = signatureHeader.replace('sha256=', '')
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  const digest = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  return timingSafeEqual(digest, signature)
}

Deno.serve(async (req) => {
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')

    if (mode === 'subscribe' && token && token === VERIFY_TOKEN) {
      return new Response(challenge || '', { status: 200 })
    }
    return new Response('Verification failed', { status: 403 })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const bodyText = await req.text()
  const signature = req.headers.get('x-hub-signature-256') || ''
  const ok = await verifySignature(bodyText, signature, APP_SECRET)
  if (!ok) {
    return new Response('Invalid signature', { status: 401 })
  }

  if (!FORWARD_URL) {
    // If no forward URL is set, just acknowledge.
    return new Response('OK', { status: 200 })
  }

  try {
    const resp = await fetch(FORWARD_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature
      },
      body: bodyText
    })
    return new Response('OK', { status: resp.ok ? 200 : 502 })
  } catch {
    return new Response('Forward failed', { status: 502 })
  }
})
