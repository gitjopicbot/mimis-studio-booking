const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);
const mimiEmail = process.env.MIMI_EMAIL || 'mimisstudio@gmail.com';

// This function is triggered by a Netlify Scheduled Function (cron)
// It sends Mimi a daily schedule email for tomorrow's appointments
exports.handler = async (event) => {
  try {
    // Calculate tomorrow's date in Pacific timezone
    const now = new Date();

    // Convert to Pacific Time
    const pacificDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));

    // Get tomorrow in Pacific time
    const tomorrow = new Date(pacificDate);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    // Query all confirmed appointments for tomorrow
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select(`
        id, appointment_date, start_time, end_time, total_duration, notes,
        clients (first_name, last_name, email, phone),
        appointment_services (services (name))
      `)
      .eq('appointment_date', tomorrowStr)
      .eq('status', 'confirmed')
      .order('start_time', { ascending: true });

    if (error) throw error;

    // Format the email
    const emailSubject = `Tomorrow's Schedule - ${formatDateNice(tomorrow)}`;

    let emailHtml;
    if (!appointments || appointments.length === 0) {
      emailHtml = scheduleEmailNoAppointments(tomorrow);
    } else {
      emailHtml = scheduleEmailWithAppointments(tomorrow, appointments);
    }

    // Send the email
    await resend.emails.send({
      from: 'Mimi\'s Studio <bookings@mimisstudio1.com>',
      to: mimiEmail,
      subject: emailSubject,
      html: emailHtml
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({
        message: `Daily schedule sent for ${tomorrowStr}`,
        appointmentCount: appointments?.length || 0
      }),
    };
  } catch (err) {
    console.error('Daily schedule error:', err);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

function formatTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function formatDateNice(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

function scheduleEmailNoAppointments(tomorrow) {
  const dateFormatted = formatDateNice(tomorrow);

  return `
  <div style="font-family: 'Georgia', serif; max-width: 600px; margin: 0 auto; background: #FDF6EC;">
    <div style="background: linear-gradient(135deg, #5C3D2E, #7A5240); padding: 40px; text-align: center;">
      <h1 style="color: #FDF6EC; font-size: 32px; margin: 0; letter-spacing: 1px;">Mimi's Studio</h1>
      <p style="color: #E0CC9D; font-size: 14px; margin: 8px 0 0; letter-spacing: 2px;">DAILY SCHEDULE</p>
    </div>
    <div style="padding: 40px;">
      <h2 style="color: #5C3D2E; font-size: 24px; margin: 0 0 20px;">Tomorrow's Schedule</h2>
      <p style="color: #6B5347; font-size: 16px; line-height: 1.6; margin: 0 0 10px;">
        <strong>${dateFormatted}</strong>
      </p>
      <div style="background: linear-gradient(135deg, #FDF6EC, #F5E6D3); border-left: 5px solid #C47D5A; border-radius: 5px; padding: 25px; text-align: center;">
        <p style="color: #5C3D2E; font-size: 18px; margin: 0; font-weight: 600;">No appointments scheduled</p>
        <p style="color: #8B7355; font-size: 14px; margin: 10px 0 0;">You have a free day tomorrow!</p>
      </div>
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #E0CC9D;">
        <p style="color: #6B5347; font-size: 13px; margin: 0;">
          <strong>Phone:</strong> (707) 292-4914<br>
          <strong>Email:</strong> mimisstudio@gmail.com
        </p>
      </div>
    </div>
  </div>`;
}

function scheduleEmailWithAppointments(tomorrow, appointments) {
  const dateFormatted = formatDateNice(tomorrow);

  // Build table rows
  let tableRows = '';
  for (const appt of appointments) {
    const client = appt.clients;
    const serviceNames = appt.appointment_services?.map(as => as.services.name).join(', ') || 'N/A';
    const startTime = formatTime(appt.start_time);
    const endTime = formatTime(appt.end_time);
    const duration = appt.total_duration ? `${appt.total_duration} min` : 'N/A';
    const clientName = `${client.first_name} ${client.last_name}`;
    const phone = client.phone || 'N/A';
    const notes = appt.notes ? appt.notes : '';

    tableRows += `
    <tr style="border-bottom: 1px solid #E0CC9D;">
      <td style="padding: 15px; color: #5C3D2E; font-weight: bold; font-size: 16px;">${startTime}</td>
      <td style="padding: 15px; color: #6B5347; font-size: 15px;">${clientName}</td>
      <td style="padding: 15px; color: #6B5347; font-size: 14px;">${phone}</td>
      <td style="padding: 15px; color: #5C3D2E; font-size: 14px;">${serviceNames}</td>
      <td style="padding: 15px; text-align: center; color: #8B7355; font-size: 13px;">${duration}</td>
      <td style="padding: 15px; color: #8B7355; font-size: 13px; max-width: 150px; word-wrap: break-word;">${notes}</td>
    </tr>`;
  }

  return `
  <div style="font-family: 'Georgia', serif; max-width: 800px; margin: 0 auto; background: #FDF6EC;">
    <div style="background: linear-gradient(135deg, #5C3D2E, #7A5240); padding: 40px; text-align: center;">
      <h1 style="color: #FDF6EC; font-size: 32px; margin: 0; letter-spacing: 1px;">Mimi's Studio</h1>
      <p style="color: #E0CC9D; font-size: 14px; margin: 8px 0 0; letter-spacing: 2px;">DAILY SCHEDULE</p>
    </div>
    <div style="padding: 40px;">
      <h2 style="color: #5C3D2E; font-size: 24px; margin: 0 0 10px;">Tomorrow's Schedule</h2>
      <p style="color: #8B7355; font-size: 15px; margin: 0 0 25px;">
        <strong>${dateFormatted}</strong> • <span style="color: #C47D5A; font-weight: bold;">${appointments.length} appointment${appointments.length === 1 ? '' : 's'}</span>
      </p>

      <table style="width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(92, 61, 46, 0.1);">
        <thead>
          <tr style="background: #5C3D2E;">
            <th style="padding: 15px; text-align: left; color: #FDF6EC; font-weight: bold; font-size: 13px; letter-spacing: 1px;">TIME</th>
            <th style="padding: 15px; text-align: left; color: #FDF6EC; font-weight: bold; font-size: 13px; letter-spacing: 1px;">CLIENT</th>
            <th style="padding: 15px; text-align: left; color: #FDF6EC; font-weight: bold; font-size: 13px; letter-spacing: 1px;">PHONE</th>
            <th style="padding: 15px; text-align: left; color: #FDF6EC; font-weight: bold; font-size: 13px; letter-spacing: 1px;">SERVICES</th>
            <th style="padding: 15px; text-align: center; color: #FDF6EC; font-weight: bold; font-size: 13px; letter-spacing: 1px;">DURATION</th>
            <th style="padding: 15px; text-align: left; color: #FDF6EC; font-weight: bold; font-size: 13px; letter-spacing: 1px;">NOTES</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>

      <div style="margin-top: 30px; padding: 20px; background: #F5E6D3; border-radius: 8px; border-left: 5px solid #C47D5A;">
        <p style="color: #5C3D2E; font-size: 14px; margin: 0; font-weight: bold;">
          Total Appointments: <span style="color: #C47D5A;">${appointments.length}</span>
        </p>
      </div>

      <div style="margin-top: 40px; padding-top: 25px; border-top: 2px solid #E0CC9D; text-align: center;">
        <p style="color: #6B5347; font-size: 13px; margin: 0; line-height: 1.8;">
          <strong>Contact Information</strong><br>
          <span style="color: #8B7355;">(707) 292-4914</span><br>
          <span style="color: #8B7355;">mimisstudio@gmail.com</span>
        </p>
      </div>
    </div>
  </div>`;
}
