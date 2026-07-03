export async function onRequestPost(context) {
  const { request, env } = context;
  const resendApiKey = env.RESEND_API_KEY;
  const turnstileSecretKey = env.CLOUDFLARE_TURNSTILE_SECRET_KEY;

  if (!resendApiKey) {
    return new Response(JSON.stringify({ error: 'Server misconfigured: RESEND_API_KEY missing' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!turnstileSecretKey) {
    return new Response(JSON.stringify({ error: 'Server misconfigured: CLOUDFLARE_TURNSTILE_SECRET_KEY missing' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const locale = String(payload?.locale ?? 'en');
  const name = String(payload?.name ?? '').trim();
  const email = String(payload?.email ?? '').trim();
  const message = String(payload?.message ?? '').trim();
  const company = String(payload?.company ?? '').trim();
  const turnstileToken = String(payload?.turnstileToken ?? '').trim();

  // Verify Turnstile CAPTCHA before any other processing.
  if (!turnstileToken) {
    return new Response(JSON.stringify({ error: 'Missing CAPTCHA token' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const verifyBody = new URLSearchParams({
    secret: turnstileSecretKey,
    response: turnstileToken,
    remoteip: request.headers.get('CF-Connecting-IP') ?? '',
  });
  const verifyResp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: verifyBody,
  });
  const verifyData = await verifyResp.json();
  if (!verifyData.success) {
    return new Response(JSON.stringify({ error: 'CAPTCHA verification failed' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Honeypot for spam bots.
  if (company) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!name || !email || !message) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const subject = locale === 'zh-TW'
    ? '[Inclu.si] 新的聯絡表單訊息'
    : '[Inclu.si] New contact form message';

  const text = [
    `Name: ${name}`,
    `Email: ${email}`,
    `Locale: ${locale}`,
    '',
    'Message:',
    message,
  ].join('\n');

  const resendResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Inclu.si Contact <onboarding@resend.dev>',
      to: ['yoofun@gmail.com'],
      reply_to: email,
      subject,
      text,
    }),
  });

  if (!resendResponse.ok) {
    const textBody = await resendResponse.text();
    return new Response(JSON.stringify({ error: textBody || `HTTP ${resendResponse.status}` }), {
      status: resendResponse.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
