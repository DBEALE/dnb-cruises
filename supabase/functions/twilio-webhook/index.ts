import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const body = await req.text();
  const params = new URLSearchParams(body);
  const from = params.get('From') ?? '';
  const msgBody = (params.get('Body') ?? '').trim().toUpperCase();

  const whatsappNumber = from.replace('whatsapp:', '');

  const twiml = '<?xml version="1.0"?><Response></Response>';

  if (!msgBody.includes('CONTINUE') || !whatsappNumber) {
    return new Response(twiml, { headers: { 'Content-Type': 'text/xml' } });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { error } = await supabase
    .from('subscriptions')
    .update({ active: true })
    .eq('whatsapp_number', whatsappNumber)
    .eq('active', false);

  if (error) console.error('Failed to reactivate subscriptions:', error.message);
  else console.log(`Reactivated subscriptions for ${whatsappNumber}`);

  return new Response(twiml, { headers: { 'Content-Type': 'text/xml' } });
});
