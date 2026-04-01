const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);
const MIMI_EMAIL = process.env.MIMI_EMAIL || 'picardjoseph8@gmail.com';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  try {
    const body = JSON.parse(event.body);
    const {
      firstName, lastName, email, phone,
      remindEmail, remindSms, remindBrowser,
      notes, date, startTime, endTime,
      totalDuration, serviceIds, serviceNames
    } = body;

    // Validate required fields
    if (!firstName || !lastName || !email || !phone || !date || startTime === undefined) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'Missing required fields' }),
      };
    }

    // 1. Check for double-booking
    const { data: conflicts } = await supabase
      .from('appointments')
      .select('id')
      .eq('appointment_date', date)
      .eq('status', 'confirmed')
      .lt('start_time', endTime)
      .gt('end_time', startTime);

    if (conflicts && conflicts.length > 0) {
      return {
        statusCode: 409,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'This time slot is no longer available. Please choose another.' }),
      };
    }

    // 2. Create or update client
    const { data: existingClient } = await supabase
      .from('clients')
      .select('id')
      .eq('email', email)
      .single();

    let clientId;
    if (existingClient) {
      clientId = existingClient.id;
      await supabase
        .from('clients')
        .update({
          first_name: firstName,
          last_name: lastName,
          phone,
          remind_email: remindEmail,
          remind_sms: remindSms,
          remind_browser: remindBrowser,
          notes,
          updated_at: new Date().toISOString()
        })
        .eq('id', clientId);
    } else {
      const { data: newClient, error: clientErr } = await supabase
        .from('clients')
        .insert({
          first_name: firstName,
          last_name: lastName,
          email,
          phone,
          remind_email: remindEmail,
          remind_sms: remindSms,
          remind_browser: remindBrowser,
          notes
        })
        .select('id')
        .single();

      if (clientErr) throw clientErr;
      clientId = newClient.id;
    }

    // 3. Create appointment
    const { data: appointment, error: apptErr } = await supabase
      .from('appointments')
      .insert({
        client_id: clientId,
        appointment_date: date,
        start_time: startTime,
        end_time: endTime,
        total_duration: totalDuration,
        notes
      })
      .select('id')
      .single();

    if (apptErr) throw apptErr;

    // 4. Link services to appointment
    if (serviceIds && serviceIds.length > 0) {
      const links = serviceIds.map(svcId => ({
        appointment_id: appointment.id,
        service_id: svcId
      }));
      await supabase.from('appointment_services').insert(links);
    }

    // 5. Format date/time for emails
    const dateObj = new Date(date + 'T12:00:00');
    const dateFormatted = dateObj.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    const timeFormatted = formatTime(startTime);
    const endTimeFormatted = formatTime(endTime);

    // 6. Send confirmation email to client
    try {
      await resend.emails.send({
        from: 'Mimi\'s Studio <onboarding@resend.dev>',
        to: email,
        subject: `Your Appointment at Mimi's Studio - ${dateFormatted}`,
        html: clientEmailHtml({
          firstName, dateFormatted, timeFormatted, endTimeFormatted,
          serviceNames, totalDuration
        })
      });
    } catch (emailErr) {
      console.log('Client email error (non-fatal):', emailErr.message);
    }

    // 7. Send notification email to Mimi
    try {
      await resend.emails.send({
        from: 'Mimi\'s Studio Booking <onboarding@resend.dev>',
        to: MIMI_EMAIL,
        subject: `New Booking: ${firstName} ${lastName} - ${dateFormatted} at ${timeFormatted}`,
        html: mimiEmailHtml({
          firstName, lastName, email, phone,
          dateFormatted, timeFormatted, endTimeFormatted,
          serviceNames, totalDuration, notes
        })
      });
    } catch (emailErr) {
      console.log('Mimi email error (non-fatal):', emailErr.message);
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        success: true,
        appointmentId: appointment.id,
        message: 'Appointment booked successfully!'
      }),
    };
  } catch (err) {
    console.error('Booking error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Something went wrong. Please try again or call the studio.' }),
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

function formatDuration(mins) {
  if (mins < 60) return `${mins} minutes`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}hr ${m}min` : `${h} hour${h > 1 ? 's' : ''}`;
}

function clientEmailHtml({ firstName, dateFormatted, timeFormatted, endTimeFormatted, serviceNames, totalDuration }) {
  return `
  <div style="font-family: 'Georgia', serif; max-width: 600px; margin: 0 auto; background: #FDF6EC;">
    <div style="background: linear-gradient(135deg, #5C3D2E, #7A5240); padding: 30px; text-align: center;">
      <h1 style="color: #FDF6EC; font-size: 28px; margin: 0;">Mimi's Studio</h1>
      <p style="color: #E0CC9D; font-size: 14px; margin: 5px 0 0; letter-spacing: 2px;">APPOINTMENT CONFIRMED</p>
    </div>
    <div style="padding: 30px;">
      <p style="color: #3A2820; font-size: 16px;">Hi ${firstName},</p>
      <p style="color: #6B5347; font-size: 15px; line-height: 1.6;">
        Your appointment has been booked! Here are your details:
      </p>
      <div style="background: #F5E6D3; border-radius: 10px; padding: 20px; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 8px 0; color: #9C8578; font-size: 14px;">Date</td><td style="padding: 8px 0; color: #3A2820; font-weight: bold; text-align: right; font-size: 14px;">${dateFormatted}</td></tr>
          <tr><td style="padding: 8px 0; color: #9C8578; font-size: 14px;">Time</td><td style="padding: 8px 0; color: #3A2820; font-weight: bold; text-align: right; font-size: 14px;">${timeFormatted} - ${endTimeFormatted}</td></tr>
          <tr><td style="padding: 8px 0; color: #9C8578; font-size: 14px;">Duration</td><td style="padding: 8px 0; color: #3A2820; font-weight: bold; text-align: right; font-size: 14px;">${formatDuration(totalDuration)}</td></tr>
          <tr><td style="padding: 8px 0; color: #9C8578; font-size: 14px; vertical-align: top;">Services</td><td style="padding: 8px 0; color: #3A2820; font-weight: bold; text-align: right; font-size: 14px;">${serviceNames.join('<br>')}</td></tr>
        </table>
      </div>
      <p style="color: #6B5347; font-size: 14px; line-height: 1.6;">
        Need to change or cancel? Please call or text us at least 24 hours before your appointment.
      </p>
      <p style="color: #C47D5A; font-size: 14px;">See you soon!</p>
      <p style="color: #3A2820; font-weight: bold;">- Mimi's Studio</p>
    </div>
    <div style="background: #5C3D2E; padding: 15px; text-align: center;">
      <p style="color: #9C8578; font-size: 12px; margin: 0;">Tuesday - Saturday | 11:00 AM - 7:00 PM</p>
    </div>
  </div>`;
}

function mimiEmailHtml({ firstName, lastName, email, phone, dateFormatted, timeFormatted, endTimeFormatted, serviceNames, totalDuration, notes }) {
  return `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #C47D5A; padding: 20px; text-align: center;">
      <h1 style="color: white; font-size: 22px; margin: 0;">New Booking Alert</h1>
    </div>
    <div style="padding: 25px; background: #FDF6EC;">
      <h2 style="color: #5C3D2E; margin-top: 0;">${firstName} ${lastName}</h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 10px; border-bottom: 1px solid #E8DDD5; color: #9C8578; width: 120px;">Email</td><td style="padding: 10px; border-bottom: 1px solid #E8DDD5; color: #3A2820;"><a href="mailto:${email}">${email}</a></td></tr>
        <tr><td style="padding: 10px; border-bottom: 1px solid #E8DDD5; color: #9C8578;">Phone</td><td style="padding: 10px; border-bottom: 1px solid #E8DDD5; color: #3A2820;"><a href="tel:${phone}">${phone}</a></td></tr>
        <tr><td style="padding: 10px; border-bottom: 1px solid #E8DDD5; color: #9C8578;">Date</td><td style="padding: 10px; border-bottom: 1px solid #E8DDD5; color: #3A2820; font-weight: bold;">${dateFormatted}</td></tr>
        <tr><td style="padding: 10px; border-bottom: 1px solid #E8DDD5; color: #9C8578;">Time</td><td style="padding: 10px; border-bottom: 1px solid #E8DDD5; color: #3A2820; font-weight: bold;">${timeFormatted} - ${endTimeFormatted}</td></tr>
        <tr><td style="padding: 10px; border-bottom: 1px solid #E8DDD5; color: #9C8578;">Duration</td><td style="padding: 10px; border-bottom: 1px solid #E8DDD5; color: #3A2820;">${formatDuration(totalDuration)}</td></tr>
        <tr><td style="padding: 10px; border-bottom: 1px solid #E8DDD5; color: #9C8578; vertical-align: top;">Services</td><td style="padding: 10px; border-bottom: 1px solid #E8DDD5; color: #3A2820;">${serviceNames.join(', ')}</td></tr>
        ${notes ? `<tr><td style="padding: 10px; color: #9C8578; vertical-align: top;">Notes</td><td style="padding: 10px; color: #3A2820;">${notes}</td></tr>` : ''}
      </table>
    </div>
  </div>`;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
