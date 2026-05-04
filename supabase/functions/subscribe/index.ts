const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

console.log('[subscribe] loaded — SUPABASE_URL set:', !!SUPABASE_URL, '| SERVICE_KEY set:', !!SERVICE_KEY);

async function dbFetch(method: string, path: string, body?: unknown) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  console.log('[subscribe] dbFetch', method, url);
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'apikey':        SERVICE_KEY,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  console.log('[subscribe] dbFetch response:', res.status, text.slice(0, 200));
  if (!res.ok) throw new Error(`DB ${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

Deno.serve(async (req) => {
  console.log('[subscribe] request received:', req.method);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    console.log('[subscribe] body keys:', Object.keys(body));
    const { whatsappNumber, criteria, seenCruiseIds } = body;

    if (!whatsappNumber || !/^\+\d{7,15}$/.test(whatsappNumber)) {
      return new Response(
        JSON.stringify({ error: 'Invalid WhatsApp number — use international format e.g. +447700900123' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const rows = await dbFetch('POST', 'subscriptions', {
      whatsapp_number: whatsappNumber,
      criteria:        criteria ?? {},
      active:          true,
    });
    const sub = Array.isArray(rows) ? rows[0] : rows;
    console.log('[subscribe] inserted subscription id:', sub?.id);

    if (Array.isArray(seenCruiseIds) && seenCruiseIds.length > 0) {
      const seenRows = seenCruiseIds
        .filter((id: unknown) => typeof id === 'string' && id.length > 0)
        .map((id: string) => ({ subscription_id: sub.id, cruise_id: id }));
      if (seenRows.length > 0) {
        try {
          await dbFetch('POST', 'seen_cruises', seenRows);
        } catch (e) {
          console.error('[subscribe] seen_cruises insert failed:', e);
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, id: sub.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[subscribe] error:', message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
