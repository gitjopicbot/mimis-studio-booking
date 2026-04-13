const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

// This function is triggered by a Netlify Scheduled Function (cron)
// or can be called manually. It checks for appointments needing reminders.
exports.handler = async (event) => {
  try {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const in1h = new Date(now.getTime() + 60 * 60 * 1000);

    // Get appointments in the next 24 hours that haven't had 24h reminder sent
    const todayStr = now.toISOString().split('T')[0];
    const tomorrowStr = in24h.toISOString().split('T')[0];

    const { data: upcoming, error } = await supabase
      .from('appointments')
      .select(`
        id, appointment_date, start_time, end_time, total_duration,
        reminder_24h_sent, reminder_1h_sent,
        clients (first_name, last_name, email, phone, remind_email, remind_sms),
        appointment_services (services (name))
      `)
      .in('appointment_date', [todayStr, tomorrowStr])
      .eq('status', 'confirmed');

    if (error) throw error;

    let sent24h = 0;
    let sent1h = 0;

    for (const appt of upcoming || []) {
      const apptDateTime = new Date(appt.appointment_date + 'T00:00:00');
      apptDateTime.setMinutes(appt.start_time);

      const hoursUntil = (apptDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);
      const client = appt.clients;
      const serviceNames = appt.appointment_services?.map(as => as.services.name) || [];

      // 24-hour reminder
      if (!appt.reminder_24h_sent && hoursUntil <= 24 && hoursUntil > 1 && client?.remind_email) {
        try {
          await resend.emails.send({
            from: 'Mimi\'s Studio <bookings@mimisstudio1.com>',
            to: client.email,
            subject: 'Reminder: Your appointment at Mimi\'s Studio is tomorrow!',
            html: reminderEmailHtml({
              firstName: client.first_name,
              date: appt.appointment_date,
              time: formatTime(appt.start_time),
              services: serviceNames
            })
          });

          await supabase
            .from('appointments')
            .update({ reminder_24h_sent: true })
            .eq('id', appt.id);

          sent24h++;
        } catch (e) {
          console.log('24h reminder error:', e.message);
        }
      }

      // 1-hour reminder
      if (!appt.reminder_1h_sent && hoursUntil <= 1 && hoursUntil > 0 && client?.remind_email) {
        try {
          await resend.emails.send({
            from: 'Mimi\'s Studio <bookings@mimisstudio1.com>',
            to: client.email,
            subject: 'Mimi\'s Studio - Your appointment is in 1 hour!',
            html: reminderEmailHtml({
              firstName: client.first_name,
              date: appt.appointment_date,
              time: formatTime(appt.start_time),
              services: serviceNames,
              urgent: true
            })
          });

          await supabase
            .from('appointments')
            .update({ reminder_1h_sent: true })
            .eq('id', appt.id);

          sent1h++;
        } catch (e) {
          console.log('1h reminder error:', e.message);
        }
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Reminders sent: ${sent24h} (24h), ${sent1h} (1h)`,
        checked: (upcoming || []).length
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

function formatTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h > 12 ? h - 12 : h;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function reminderEmailHtml({ firstName, date, time, services, urgent }) {
  const dateObj = new Date(date + 'T12:00:00');
  const dateFormatted = dateObj.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });
  const urgentBanner = urgent
    ? '<div style="background: #C47D5A; color: white; text-align: center; padding: 10px; font-weight: bold;">Your appointment is in 1 hour!</div>'
    : '';

  return `
  <div style="font-family: 'Georgia', serif; max-width: 600px; margin: 0 auto; background: #FDF6EC;">
    <div style="background: linear-gradient(135deg, #5C3D2E, #7A5240); padding: 30px; text-align: center;">
      <h1 style="color: #FDF6EC; font-size: 28px; margin: 0;">Mimi's Studio</h1>
      <p style="color: #E0CC9D; font-size: 14px; margin: 5px 0 0; letter-spacing: 2px;">APPOINTMENT REMINDER</p>
    </div>
    ${urgentBanner}
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
        Need to reschedule? Please let us know as soon as possible.
      </p>
      <p style="color: #C47D5A; font-size: 14px;">See you soon!</p>
      <p style="color: #3A2820; font-weight: bold;">- Mimi's Studio</p>
    </div>
    <div style="background: #5C3D2E; padding: 15px; text-align: center;">
      <p style="color: #E0CC9D; font-size: 13px; margin: 0;">
        <a href="tel:+17072924914" style="color: #E0CC9D; text-decoration: none;">(707) 292-4914</a> &nbsp;|&nbsp;
        <a href="mailto:mimisstudio@gmail.com" style="color: #E0CC9D; text-decoration: none;">mimisstudio@gmail.com</a>
      </p>
    </div>
  </div>`;
}
