/**
 * Netlify Function: Cancel Appointment (client self-service, from email link)
 *
 * Flow:
 *   GET  /cancel?token=<uuid>   -> branded confirmation page ("Cancel this appointment?")
 *   POST /cancel  (form post)   -> performs the cancellation, emails Mimi
 *
 * Security:
 *   - The ONLY thing that authorises a cancellation is `cancel_token`, a random
 *     UUID stored on the appointment row. We never accept an appointment id or
 *     client id from the URL, so appointments cannot be cancelled by guessing
 *     sequential ids.
 *   - The token is looked up with .eq(), so a wrong/expired token simply finds
 *     nothing and we show a neutral "link not valid" page.
 *
 * Policy:
 *   - Mimi's confirmation emails promise "call or text at least 24 hours before".
 *     We enforce the same window here: inside 24 hours the link will NOT cancel,
 *     it tells the client to call the studio.
 */

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);
const MIMI_EMAIL = process.env.MIMI_EMAIL || 'picardjoseph8@gmail.com';

const STUDIO_PHONE = '(707) 292-4914';
const STUDIO_PHONE_HREF = '+17072924914';
const CANCEL_WINDOW_HOURS = 24;

const SALON_TZ = 'America/Los_Angeles';

function nowInSalonTz() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: SALON_TZ }));
}

function apptInSalonTz(dateStr, minutesFromMidnight) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const h = Math.floor(minutesFromMidnight / 60);
  const min = minutesFromMidnight % 60;
  return new Date(Date.UTC(y, m - 1, d, h, min));
}

function hoursUntil(appt) {
  const apptPt = apptInSalonTz(appt.appointment_date, appt.start_time);
  return (apptPt.getTime() - nowInSalonTz().getTime()) / (1000 * 60 * 60);
}

function formatTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── PAGE SHELL (matches the site palette) ─────────────────

function page({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — Mimi's Studio</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Lato:wght@300;400;600&display=swap" rel="stylesheet">
<style>
  body { margin:0; font-family:'Lato',sans-serif; background:#FAF6EC; color:#2C3E55; line-height:1.6; }
  header { background:linear-gradient(135deg,#466B8E 0%,#6B91B5 55%,#8FA8C9 100%); color:#FAF6EC; text-align:center; padding:2.2rem 1rem; }
  header h1 { font-family:'Playfair Display',serif; font-size:2.2rem; margin:0; }
  .wrap { max-width:560px; margin:2rem auto; padding:0 1.2rem 3rem; }
  .card { background:#fff; border-radius:14px; padding:2rem; box-shadow:0 2px 12px rgba(44,62,85,.08); border:1px solid #ECE3D0; }
  h2 { font-family:'Playfair Display',serif; color:#466B8E; margin:0 0 .6rem; font-size:1.5rem; }
  .details { background:#FAF6EC; border-radius:10px; padding:1.2rem; margin:1.4rem 0; border-left:4px solid #C9A961; }
  .row { display:flex; justify-content:space-between; padding:.35rem 0; font-size:.95rem; }
  .label { color:#95A0B0; }
  .value { font-weight:600; color:#2C3E55; text-align:right; }
  .btn { font-family:'Lato',sans-serif; font-weight:600; font-size:1rem; padding:.85rem 2rem; border-radius:8px; border:none; cursor:pointer; }
  .btn-danger { background:#C97D5C; color:#fff; }
  .btn-danger:hover { background:#A56247; }
  .btn-quiet { background:transparent; color:#6B91B5; text-decoration:none; padding:.85rem 1rem; display:inline-block; }
  .muted { color:#5C6B82; font-size:.92rem; }
  .call { display:inline-block; margin-top:.8rem; background:#466B8E; color:#FAF6EC !important; text-decoration:none; padding:.8rem 1.6rem; border-radius:8px; font-weight:600; }
  footer { text-align:center; color:#5C6B82; font-size:.85rem; padding:1rem; }
</style>
</head><body>
<header><h1>Mimi's Studio</h1></header>
<div class="wrap"><div class="card">${body}</div></div>
<footer>330 South A St, Santa Rosa, CA 95401 &middot; ${STUDIO_PHONE}</footer>
</body></html>`;
}

function html(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body,
  };
}

function detailBlock(appt, serviceNames) {
  return `
    <div class="details">
      <div class="row"><span class="label">Date</span><span class="value">${escapeHtml(formatDate(appt.appointment_date))}</span></div>
      <div class="row"><span class="label">Time</span><span class="value">${escapeHtml(formatTime(appt.start_time))} &ndash; ${escapeHtml(formatTime(appt.end_time))}</span></div>
      ${serviceNames.length ? `<div class="row"><span class="label">Services</span><span class="value">${escapeHtml(serviceNames.join(', '))}</span></div>` : ''}
    </div>`;
}

function callBlock() {
  return `<a class="call" href="tel:${STUDIO_PHONE_HREF}">Call the studio &middot; ${STUDIO_PHONE}</a>`;
}

// ─── HANDLER ───────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    const token =
      (event.queryStringParameters && event.queryStringParameters.token) ||
      (event.httpMethod === 'POST' ? parseToken(event) : null);

    if (!token) {
      return html(400, page({
        title: 'Link not valid',
        body: `<h2>This link isn't valid</h2>
          <p class="muted">The cancellation link looks incomplete. Please use the link in your confirmation email, or give us a call and we'll sort it out.</p>
          ${callBlock()}`,
      }));
    }

    // Look the appointment up by its secret token only.
    const { data: appt, error } = await supabase
      .from('appointments')
      .select(`
        id, appointment_date, start_time, end_time, status, total_duration,
        clients ( first_name, last_name, email, phone ),
        appointment_services ( services ( name ) )
      `)
      .eq('cancel_token', token)
      .maybeSingle();

    if (error) throw error;

    if (!appt) {
      return html(404, page({
        title: 'Link not valid',
        body: `<h2>We couldn't find that appointment</h2>
          <p class="muted">This cancellation link may have already been used, or it may be out of date.</p>
          ${callBlock()}`,
      }));
    }

    const serviceNames = (appt.appointment_services || [])
      .map(as => as.services && as.services.name)
      .filter(Boolean);

    // Already cancelled — show a friendly, idempotent result.
    if (appt.status === 'cancelled') {
      return html(200, page({
        title: 'Already cancelled',
        body: `<h2>This appointment is already cancelled</h2>
          <p class="muted">There's nothing more you need to do.</p>
          ${detailBlock(appt, serviceNames)}
          <p class="muted">Want to rebook? <a href="https://mimisstudio1.com">Book a new appointment</a>.</p>`,
      }));
    }

    const hrs = hoursUntil(appt);

    // Already in the past.
    if (hrs <= 0) {
      return html(200, page({
        title: 'Appointment has passed',
        body: `<h2>This appointment has already passed</h2>
          ${detailBlock(appt, serviceNames)}
          <p class="muted">If you need to book again, you can do that any time.</p>
          <p><a href="https://mimisstudio1.com">Book a new appointment</a></p>`,
      }));
    }

    // Inside the 24-hour window — do not self-cancel, ask them to call.
    if (hrs < CANCEL_WINDOW_HOURS) {
      return html(200, page({
        title: 'Please call the studio',
        body: `<h2>Your appointment is less than ${CANCEL_WINDOW_HOURS} hours away</h2>
          ${detailBlock(appt, serviceNames)}
          <p class="muted">Because it's so close, we ask that you call or text Mimi directly to cancel rather than doing it online. She'll take care of you.</p>
          ${callBlock()}`,
      }));
    }

    // ── GET: show the confirmation page ──
    if (event.httpMethod !== 'POST') {
      const first = (appt.clients && appt.clients.first_name) || 'there';
      return html(200, page({
        title: 'Cancel appointment',
        body: `<h2>Hi ${escapeHtml(first)} — cancel this appointment?</h2>
          ${detailBlock(appt, serviceNames)}
          <p class="muted">If you'd like to keep it, you can simply close this page. Nothing has changed yet.</p>
          <form method="POST" style="margin-top:1.4rem;">
            <input type="hidden" name="token" value="${escapeHtml(token)}">
            <button class="btn btn-danger" type="submit">Yes, cancel my appointment</button>
            <a class="btn-quiet" href="https://mimisstudio1.com">No, keep it</a>
          </form>`,
      }));
    }

    // ── POST: actually cancel ──
    const { error: updErr } = await supabase
      .from('appointments')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancelled_via: 'client_email',
        updated_at: new Date().toISOString(),
      })
      .eq('id', appt.id)
      .eq('cancel_token', token);

    if (updErr) throw updErr;

    // Tell Mimi. Never let an email failure break the cancellation itself —
    // the slot is already freed at this point.
    try {
      const c = appt.clients || {};
      await resend.emails.send({
        from: "Mimi's Studio <bookings@mimisstudio1.com>",
        to: MIMI_EMAIL,
        subject: `Cancelled: ${c.first_name || ''} ${c.last_name || ''} — ${formatDate(appt.appointment_date)} at ${formatTime(appt.start_time)}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <div style="background:#C97D5C;padding:18px;text-align:center;">
              <h1 style="color:#fff;font-size:20px;margin:0;">Appointment Cancelled</h1>
              <p style="color:#FAF6EC;font-size:13px;margin:4px 0 0;">Cancelled by the client from their confirmation email</p>
            </div>
            <div style="padding:22px;background:#FAF6EC;">
              <h2 style="color:#466B8E;margin-top:0;">${escapeHtml(`${c.first_name || ''} ${c.last_name || ''}`.trim())}</h2>
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <tr><td style="padding:8px;color:#95A0B0;">Date</td><td style="padding:8px;font-weight:bold;color:#2C3E55;">${escapeHtml(formatDate(appt.appointment_date))}</td></tr>
                <tr><td style="padding:8px;color:#95A0B0;">Time</td><td style="padding:8px;font-weight:bold;color:#2C3E55;">${escapeHtml(formatTime(appt.start_time))} - ${escapeHtml(formatTime(appt.end_time))}</td></tr>
                <tr><td style="padding:8px;color:#95A0B0;">Services</td><td style="padding:8px;color:#2C3E55;">${escapeHtml(serviceNames.join(', '))}</td></tr>
                <tr><td style="padding:8px;color:#95A0B0;">Phone</td><td style="padding:8px;color:#2C3E55;">${escapeHtml(c.phone || '—')}</td></tr>
                <tr><td style="padding:8px;color:#95A0B0;">Notice given</td><td style="padding:8px;color:#2C3E55;">${Math.round(hrs)} hours</td></tr>
              </table>
              <p style="color:#5C6B82;font-size:13px;margin-top:16px;">This time slot is now free and bookable again.</p>
            </div>
          </div>`,
      });
    } catch (e) {
      console.error('[cancel-appointment] Mimi notification failed:', e.message);
    }

    return html(200, page({
      title: 'Appointment cancelled',
      body: `<h2>Your appointment has been cancelled</h2>
        ${detailBlock(appt, serviceNames)}
        <p class="muted">Thanks for letting us know in good time — Mimi has been notified and the slot is free for someone else.</p>
        <p style="margin-top:1.2rem;"><a href="https://mimisstudio1.com">Book a new appointment</a></p>`,
    }));
  } catch (err) {
    console.error('[cancel-appointment] error:', err.message);
    return html(500, page({
      title: 'Something went wrong',
      body: `<h2>Sorry — something went wrong</h2>
        <p class="muted">We couldn't cancel your appointment just now. Please call or text the studio and we'll take care of it right away.</p>
        ${callBlock()}`,
    }));
  }
};

/**
 * Pull `token` out of a urlencoded form POST body.
 * Netlify sets isBase64Encoded depending on how the body arrived, so trust
 * that flag rather than trying to sniff the encoding.
 */
function parseToken(event) {
  if (!event || !event.body) return null;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    return new URLSearchParams(raw).get('token');
  } catch {
    return null;
  }
}
