const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

    if (msgBody.includes('CONTINUE') && number) {
      await dbFetch('PATCH', `subscriptions?whatsapp_number=eq.${encodeURIComponent(number)}&active=eq.false`, { active: true });
      console.log(`Reactivated subscriptions for ${number}`);
    }
  } catch (err) {
    console.error('twilio-webhook error:', err instanceof Error ? err.message : String(err));
  }

  return new Response(twiml, { headers: { 'Content-Type': 'text/xml' } });
});
