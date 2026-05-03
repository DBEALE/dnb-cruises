import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const { whatsappNumber, criteria, seenCruiseIds } = await req.json();

    if (!whatsappNumber || !/^\+\d{7,15}$/.test(whatsappNumber)) {
      return new Response(
        JSON.stringify({ error: 'Invalid WhatsApp number — use international format e.g. +447700900123' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: sub, error: subErr } = await supabase
      .from('subscriptions')
      .insert({ whatsapp_number: whatsappNumber, criteria: criteria ?? {}, active: true })
      .select('id')
      .single();

    if (subErr) throw subErr;

    // Seed all currently-known cruise IDs as seen so the user is only notified about future new cruises
    if (Array.isArray(seenCruiseIds) && seenCruiseIds.length > 0) {
      const rows = seenCruiseIds
        .filter((id: unknown) => typeof id === 'string' && id.length > 0)
        .map((id: string) => ({ subscription_id: sub.id, cruise_id: id }));
      if (rows.length > 0) {
        const { error: seenErr } = await supabase.from('seen_cruises').insert(rows);
        if (seenErr) console.error('seen_cruises insert error:', seenErr.message);
      }
    }

    return new Response(
      JSON.stringify({ success: true, id: sub.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
