// Supabase Edge Function: Twilio WhatsApp webhook.
// Verifies the X-Twilio-Signature header before any state change, so a
// caller cannot reactivate an arbitrary subscription by POSTing
// Body=CONTINUE with a chosen From. Returns 5xx on any failure inside
// the request handler so Twilio retries — a 200 must mean the DB
// transition is durable.

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_TOKEN   = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';

// Constant-time string comparison to avoid timing side channels in the
// signature check. Returns false for unequal lengths.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Twilio's signing algorithm (https://www.twilio.com/docs/usage/webhooks/webhooks-security):
//   1. Take the full request URL Twilio signed (scheme + host + path + query).
//   2. For each POST parameter name (alphabetical, deduplicated), append
//      each unique value (alphabetical, deduplicated) in the form
//      `name + value` — empty values are NOT skipped (per the canonical
//      Python validator, twilio-python/twilio/request_validator.py).
//   3. HMAC-SHA1 the concatenation with the AuthToken; base64-encode.
//   4. Compare against X-Twilio-Signature in constant time.
//
// The request URL we sign MUST be the public URL Twilio reached, not a
// synthesized one. In Supabase Edge Functions the value is
// `${SUPABASE_URL}/functions/v1/<name>`. Set the PUBLIC_FUNCTION_URL
// env var if the function is fronted by a custom domain or rewrite
// (e.g. via Supabase's --import-map). The validator also accepts a
// URL with an explicit default port (80/443) — Twilio's own validation
// tries both forms because the back-end is inconsistent.
async function computeSignature(
  token: string,
  fullUrl: string,
  bodyParams: URLSearchParams,
): Promise<string> {
  let data = fullUrl;
  // Sort + dedupe param names; sort + dedupe values per name.
  const names = [...new Set(bodyParams.keys())].sort();
  for (const name of names) {
    const values = [...new Set(bodyParams.getAll(name))].sort();
    for (const value of values) {
      // Twilio appends the value verbatim — empty values included.
      data += name + value;
    }
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(token),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  // ArrayBuffer → base64 (btoa on the binary string is the standard
  // one-liner; works on both Deno Deploy and Node).
  const bytes = new Uint8Array(sigBuf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function withExplicitPort(url: string): string {
  try {
    const u = new URL(url);
    if (u.port) return url;
    if (u.protocol === 'https:') u.port = '443';
    else if (u.protocol === 'http:') u.port = '80';
    return u.toString();
  } catch {
    return url;
  }
}

function withoutPort(url: string): string {
  try {
    const u = new URL(url);
    if (u.port) {
      u.port = '';
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

async function verifyTwilioSignature(
  signature: string,
  fullUrl: string,
  bodyParams: URLSearchParams,
): Promise<boolean> {
  if (!TWILIO_TOKEN || !signature) return false;
  // Twilio's own validator checks both forms because the back-end is
  // inconsistent about whether the port is included.
  const withPort    = await computeSignature(TWILIO_TOKEN, withExplicitPort(fullUrl),  bodyParams);
  const withoutPort = await computeSignature(TWILIO_TOKEN, withoutPort(fullUrl),       bodyParams);
  return timingSafeEqual(withPort, signature) || timingSafeEqual(withoutPort, signature);
}

async function dbFetch(method: string, path: string, body?: unknown) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'apikey':        SERVICE_KEY,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: body != null ? JSON.stringify(body) : undefined,
    // Same 15s ceiling as the other Edge Functions. A slow DB write
    // becomes a 5xx (via the outer try/catch) so Twilio retries —
    // better than a hung connection that holds the worker hostage.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DB ${method} ${path} → ${res.status}: ${text}`);
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const twiml = '<?xml version="1.0"?><Response></Response>';

  try {
    const body    = await req.text();
    const params  = new URLSearchParams(body);
    const from    = params.get('From') ?? '';
    const msgBody = (params.get('Body') ?? '').trim().toUpperCase();
    const number  = from.replace('whatsapp:', '');

    // Verify the request really came from Twilio. Compute the URL Twilio
    // signed (public base + function path), then constant-time compare
    // the X-Twilio-Signature header. Skip when TWILIO_AUTH_TOKEN is
    // unset (local dev) — log a warning so it isn't accidentally
    // deployed that way.
    const publicUrl = Deno.env.get('PUBLIC_FUNCTION_URL')
      ?? `${SUPABASE_URL}/functions/v1/twilio-webhook`;
    if (!TWILIO_TOKEN) {
      console.warn('twilio-webhook: TWILIO_AUTH_TOKEN is not set; signature check skipped (dev mode)');
    } else {
      const sig = req.headers.get('x-twilio-signature') ?? '';
      const ok  = await verifyTwilioSignature(sig, publicUrl, params);
      if (!ok) {
        console.error('twilio-webhook: signature verification failed');
        return new Response('forbidden', { status: 403 });
      }
    }

    if (msgBody.includes('CONTINUE') && number) {
      await dbFetch('PATCH', `subscriptions?whatsapp_number=eq.${encodeURIComponent(number)}&active=eq.false`, { active: true });
      // Log only a short suffix — full E.164 is PII and the function
      // log is a long-retention store.
      const suffix = number.slice(-4);
      console.log(`Reactivated subscriptions for ...${suffix}`);
    }
    return new Response(twiml, { headers: { 'Content-Type': 'text/xml' } });
  } catch (err) {
    // Return 5xx so Twilio retries the webhook — a silent 200 means a failed
    // DB write is invisible to the user and to Twilio's delivery dashboard.
    console.error('twilio-webhook error:', err instanceof Error ? err.message : String(err));
    return new Response('internal error', { status: 500 });
  }
});
