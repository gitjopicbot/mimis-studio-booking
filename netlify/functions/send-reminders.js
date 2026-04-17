const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

// ─── TIMEZONE HELPERS (salon is in Santa Rosa, CA — America/Los_Angeles) ─────
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

// Returns "now" as a Date whose .getTime() = current PT wall-clock parsed as UTC.
function nowInSalonTz() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: SALON_TZ }));
}

// Returns a Date for a given salon-local appointment_date + minutes-from-midnight,
// using the same "wall-clock as UTC" representation. TZ-independent on Node.
function apptInSalonTz(dateStr, minutesFromMidnight) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const h = Math.floor(minutesFromMidnight / 60);
  const min = minutesFromMidnight % 60;
  return new Date(Date.UTC(y, m - 1, d, h, min));
}

// Returns today's PT calendar date as "YYYY-MM-DD".
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

    // Pull any confirmed appointments today or tomorrow (PT) whose reminder
    // hasn't gone out yet. We reuse reminder_24h_sent as the single "reminder
    // has been sent" flag — regardless of whether reminder_hours is 6/12/24.
    const { data: upcoming, error } = await supabase
      .from('appointments')
      .select(`
        id, appointment_date, start_time, end_time, total_duration,
        reminder_24h_sent, reminder_hours, reminder_method,
        clients (first_name, last_name, email, phone, remind_email, remind_sms),
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

      // Fall back to 24 for legacy rows that predate the migration
      const windowHours = [6, 12, 24].includes(appt.reminder_hours) ? appt.reminder_hours : 24;
      const method = appt.reminder_method || 'email';

      const client = appt.clients;
      const serviceNames = appt.appointment_services?.map(as => as.services.name) || [];
      const label = `appt ${appt.id.slice(0, 8)} (${client?.first_name || '?'} @ ${appt.appointment_date} ${formatTime(appt.start_time)})`;

      // Skip past appointments
      if (hoursUntil <= 0) {
        skipped++;
        details.push(`${label}: SKIP (already passed, ${hoursUntil.toFixed(1)}hr)`);
        continue;
      }

      // Not yet within the reminder window
      if (hoursUntil > windowHours) {
        skipped++;
        details.push(`${label}: WAIT (${hoursUntil.toFixed(1)}hr until, window=${windowHours}hr)`);
        continue;
      }

      // Client doesn't want email reminders
      // (method can be 'email', 'text', or 'both' — SMS not implemented yet,
      // so 'text'-only effectively means no reminder until that's added)
      const wantsEmail = (method === 'email' || method === 'both') && client?.remind_email !== false;
      if (!wantsEmail || !client?.email) {
        // Mark as "sent" so we don't keep checking — client opted out of email.
        await supabase
          .from('appointments')
          .update({ reminder_24h_sent: true })
          .eq('id', appt.id);
        skipped++;
        details.push(`${label}: SKIP (email reminders off or no email)`);
        continue;
      }

      // Send it.
      try {
        const emailResult = await resend.emails.send({
          from: "Mimi's Studio <bookings@mimisstudio1.com>",
          to: client.email,
          subject: buildSubject(windowHours, appt.appointment_date, todayStr),
          html: reminderEmailHtml({
            firstName: client.first_name,
            date: appt.appointment_date,
            time: formatTime(appt.start_time),
            services: serviceNames,
            hoursAhead: windowHours,
            isToday: appt.appointment_date === todayStr
          })
        });

        await supabase
          .from('appointments')
          .update({ reminder_24h_sent: true })
          .eq('id', appt.id);

        sent++;
        details.push(`${label}: SENT (${windowHours}hr reminder, hoursUntil=${hoursUntil.toFixed(1)}, resend id=${emailResult?.data?.id || 'n/a'})`);
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

function buildSubject(windowHours, apptDateStr, todayStr) {
  if (apptDateStr === todayStr) {
    return "Reminder: Your appointment at Mimi's Studio is today!";
  }
  if (windowHours === 24) {
    return "Reminder: Your appointment at Mimi's Studio is tomorrow!";
  }
  return `Reminder: Your appointment at Mimi's Studio is in ${windowHours} hours`;
}

function formatTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function reminderEmailHtml({ firstName, date, time, services, hoursAhead, isToday }) {
  const dateObj = new Date(date + 'T12:00:00');
  const dateFormatted = dateObj.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  let banner = '';
  if (isToday) {
    banner = `<div style="background: #C47D5A; color: white; text-align: center; padding: 12px; font-weight: bold; font-size: 15px;">Your appointment is today!</div>`;
  } else if (hoursAhead <= 12) {
    banner = `<div style="background: #C47D5A; color: white; text-align: center; padding: 12px; font-weight: bold; font-size: 15px;">Your appointment is in about ${hoursAhead} hours</div>`;
  }

  return `
  <div style="font-family: 'Georgia', serif; max-width: 600px; margin: 0 auto; background: #FDF6EC;">
    <div style="background: linear-gradient(135deg, #5C3D2E, #7A5240); padding: 30px; text-align: center;">
      <h1 style="color: #FDF6EC; font-size: 28px; margin: 0;">Mimi's Studio</h1>
      <p style="color: #E0CC9D; font-size: 14px; margin: 5px 0 0; letter-spacing: 2px;">APPOINTMENT REMINDER</p>
    </div>
    ${banner}
    <div style="padding: 30px;">
      <p style="color: #3A2820; font-size: 16px;">Hi ${firstName},</p>
      <p style="color: #6B5347; font-size: 15px; line-height: 1.6;">
        Just a friendly reminder about your upcoming appointment:
      </p>
      <div style="background: #F5E6D3; border-radius: 10px; padding: 20px; margin: 20px 0; text-align: center;">
        <p style="font-size: 18px; color: #5C3D2E; font-weight: bold; margin: 0 0 5px;">${dateFormatted}</p>
        <p style="font-size: 24px; color: #C47D5A; font-weight: bold; margin: 0;">${time}</p>
        <p style="font-size: 14px; color: #6B5347; margin: 10px 0 0;">${services.join(' + ')}</p>
      </div>
      <p style="color: #6B5347; font-size: 14px; line-height: 1.6;">
        Need to reschedule? Please call or text Mimi as soon as possible.
      </p>
      <p style="color: #C47D5A; font-size: 14px;">See you soon!</p>
      <p style="color: #3A2820; font-weight: bold;">- Mimi's Studio</p>
    </div>
    <div style="background: #5C3D2E; padding: 20px; text-align: center;">
      <p style="color: #E0CC9D; font-size: 13px; margin: 0 0 4px;">
        <a href="tel:+17072924914" style="color: #E0CC9D; text-decoration: none;">(707) 292-4914</a>
      </p>
      <p style="color: #c4a882; font-size: 12px; margin: 4px 0 0;">
        330 South A St, Santa Rosa, CA 95401
      </p>
    </div>
  </div>`;
}
