const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

// ─── POLICY ─────────────────────────────────────────────────────────────────
// Every appointment on Mimi's books gets a mandatory 24-hour email reminder,
// regardless of how it was created (client booking, admin, or bulk import
// from ApptGo). Client-level opt-outs are intentionally ignored — Mimi wants
// everyone reminded.

const REMINDER_HOURS = 24;

// ─── TIMEZONE HELPERS (salon is in Santa Rosa, CA — America/Los_Angeles) ────
//
// Appointments are stored as:
//   appointment_date  (DATE, interpreted as PT calendar date)
//   start_time        (INTEGER, minutes from midnight PT)
//
// Netlify Functions run in UTC. To do date math without pulling in a tz library
// we use the "PT wall-clock interpreted as UTC" trick — we build Date objects
// whose internal UTC time equals the PT wall-clock, so subtracting two of them
// produces the correct real-world delta.

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

function salonDateStr(offsetDays = 0) {
  const d = nowInSalonTz();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

// ─── HANDLER ────────────────────────────────────────────────────────────────
// Triggered by Netlify Scheduled Functions (see netlify.toml) — runs every
// 15 minutes. Also callable manually via GET for debugging.
exports.handler = async (event) => {
  try {
    const nowPt = nowInSalonTz();
    const todayStr = salonDateStr(0);
    const tomorrowStr = salonDateStr(1);

    console.log(`[send-reminders] Running at PT ${nowPt.toISOString().replace('Z','')} — scanning ${todayStr} and ${tomorrowStr}`);

    // Any confirmed appointment today or tomorrow (PT) whose 24hr reminder
    // hasn't gone out yet. We use reminder_24h_sent as the single "reminder
    // has been sent" flag.
    const { data: upcoming, error } = await supabase
      .from('appointments')
      .select(`
        id, appointment_date, start_time, end_time, total_duration,
        reminder_24h_sent,
        clients (first_name, last_name, email, phone),
        appointment_services (services (name))
      `)
      .in('appointment_date', [todayStr, tomorrowStr])
      .eq('status', 'confirmed')
      .eq('reminder_24h_sent', false);

    if (error) throw error;

    let sent = 0;
    let skipped = 0;
    const details = [];

    for (const appt of upcoming || []) {
      const apptPt = apptInSalonTz(appt.appointment_date, appt.start_time);
      const hoursUntil = (apptPt.getTime() - nowPt.getTime()) / (1000 * 60 * 60);

      const client = appt.clients;
      const serviceNames = appt.appointment_services?.map(as => as.services.name) || [];
      const label = `appt ${appt.id.slice(0, 8)} (${client?.first_name || '?'} @ ${appt.appointment_date} ${formatTime(appt.start_time)})`;

      // Skip appointments that have already passed — no point pinging someone
      // about something that already happened.
      if (hoursUntil <= 0) {
        skipped++;
        details.push(`${label}: SKIP (already passed, ${hoursUntil.toFixed(1)}hr)`);
        continue;
      }

      // Not yet within the 24hr reminder window
      if (hoursUntil > REMINDER_HOURS) {
        skipped++;
        details.push(`${label}: WAIT (${hoursUntil.toFixed(1)}hr until)`);
        continue;
      }

      // Mandatory reminder — but we still need an email address to send to.
      // Client-level opt-outs (remind_email=false) are intentionally ignored.
      if (!client?.email) {
        await supabase
          .from('appointments')
          .update({ reminder_24h_sent: true })
          .eq('id', appt.id);
        skipped++;
        details.push(`${label}: SKIP (no email on file)`);
        continue;
      }

      // Send it.
      try {
        const emailResult = await resend.emails.send({
          from: "Mimi's Studio <bookings@mimisstudio1.com>",
          to: client.email,
          subject: buildSubject(appt.appointment_date, todayStr),
          html: reminderEmailHtml({
            firstName: client.first_name,
            date: appt.appointment_date,
            time: formatTime(appt.start_time),
            services: serviceNames,
            isToday: appt.appointment_date === todayStr
          })
        });

        await supabase
          .from('appointments')
          .update({ reminder_24h_sent: true })
          .eq('id', appt.id);

        sent++;
        details.push(`${label}: SENT (hoursUntil=${hoursUntil.toFixed(1)}, resend id=${emailResult?.data?.id || 'n/a'})`);
      } catch (e) {
        console.error(`[send-reminders] ${label}: ERROR —`, e.message);
        details.push(`${label}: ERROR (${e.message})`);
      }
    }

    const summary = {
      message: `Sent ${sent}, skipped ${skipped}, checked ${(upcoming || []).length}`,
      todayPt: todayStr,
      nowPt: nowPt.toISOString().replace('Z', ''),
      details
    };

    console.log('[send-reminders] Summary:', JSON.stringify(summary));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(summary),
    };
  } catch (err) {
    console.error('[send-reminders] FATAL:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ─── HELPERS ────────────────────────────────────────────────────────────────

function buildSubject(apptDateStr, todayStr) {
  if (apptDateStr === todayStr) {
    return "Reminder: Your appointment at Mimi's Studio is today!";
  }
  return "Reminder: Your appointment at Mimi's Studio is tomorrow!";
}

function formatTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function reminderEmailHtml({ firstName, date, time, services, isToday }) {
  const dateObj = new Date(date + 'T12:00:00');
  const dateFormatted = dateObj.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  const banner = isToday
    ? `<div style="background: #C97D5C; color: white; text-align: center; padding: 12px; font-weight: bold; font-size: 15px;">Your appointment is today!</div>`
    : '';

  return `
  <div style="font-family: 'Georgia', serif; max-width: 600px; margin: 0 auto; background: #FAF6EC;">
    <div style="background: linear-gradient(135deg, #466B8E 0%, #6B91B5 55%, #8FA8C9 100%); padding: 30px; text-align: center;">
      <h1 style="color: #FAF6EC; font-size: 28px; margin: 0;">Mimi's Studio</h1>
      <p style="color: #E8D4A0; font-size: 14px; margin: 5px 0 0; letter-spacing: 2px;">APPOINTMENT REMINDER</p>
    </div>
    ${banner}
    <div style="padding: 30px;">
      <p style="color: #2C3E55; font-size: 16px;">Hi ${firstName || 'there'},</p>
      <p style="color: #5C6B82; font-size: 15px; line-height: 1.6;">
        Just a friendly reminder about your upcoming appointment:
      </p>
      <div style="background: #ECE3D0; border-radius: 10px; padding: 20px; margin: 20px 0; text-align: center; border-left: 4px solid #C9A961;">
        <p style="font-size: 18px; color: #466B8E; font-weight: bold; margin: 0 0 5px;">${dateFormatted}</p>
        <p style="font-size: 24px; color: #6B91B5; font-weight: bold; margin: 0;">${time}</p>
        ${services.length ? `<p style="font-size: 14px; color: #5C6B82; margin: 10px 0 0;">${services.join(' + ')}</p>` : ''}
      </div>
      <p style="color: #5C6B82; font-size: 14px; line-height: 1.6;">
        Need to reschedule? Please call or text Mimi as soon as possible.
      </p>
      <p style="color: #6B91B5; font-size: 14px;">See you soon!</p>
      <p style="color: #2C3E55; font-weight: bold;">- Mimi's Studio</p>
    </div>
    <div style="background: #466B8E; padding: 20px; text-align: center;">
      <p style="color: #E8D4A0; font-size: 13px; margin: 0 0 4px;">
        <a href="tel:+17072924914" style="color: #E8D4A0; text-decoration: none;">(707) 292-4914</a>
      </p>
      <p style="color: #BDD9E8; font-size: 12px; margin: 4px 0 0;">
        330 South A St, Santa Rosa, CA 95401
      </p>
    </div>
  </div>`;
}
