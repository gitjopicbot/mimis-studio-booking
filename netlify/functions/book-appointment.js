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
      reminderTiming, reminderMethod,
      notes, date, startTime, endTime,
      totalDuration, serviceIds, serviceNames
    } = body;

    console.log('Booking request:', { firstName, lastName, email, date, startTime, serviceNames });

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

    // 2. Smart duplicate detection: match on 2+ of (first_name, last_name, phone, email)
    let clientId = null;
    clientId = await findExistingClient(firstName, lastName, email, phone);

    if (clientId) {
      // Update existing client with latest info
      const { error: updateErr } = await supabase
        .from('clients')
        .update({
          first_name: firstName,
          last_name: lastName,
          phone,
          remind_email: remindEmail,
          remind_sms: remindSms,
          remind_browser: remindBrowser || false,
          updated_at: new Date().toISOString()
        })
        .eq('id', clientId);
      if (updateErr) console.log('Client update error (non-fatal):', updateErr.message);

      // Add phone if not already recorded
      await addPhoneIfNew(clientId, phone);
      // Add email if not already recorded
      await addEmailIfNew(clientId, email);
    } else {
      // Create new client
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
          notes: ''
        })
        .select('id')
        .single();

      if (clientErr) throw clientErr;
      clientId = newClient.id;

      // Seed the client_phones and client_emails tables
      await supabase.from('client_phones').insert({
        client_id: clientId, phone, label: 'primary'
      });
      await supabase.from('client_emails').insert({
        client_id: clientId, email, label: 'primary'
      });
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

    // 6. Send confirmation email to client (with full contact info)
    console.log('Sending confirmation email to:', email);
    try {
      const clientEmailResult = await resend.emails.send({
        from: 'Mimi\'s Studio <onboarding@resend.dev>',
        to: email,
        subject: `Your Appointment at Mimi's Studio - ${dateFormatted}`,
        html: clientEmailHtml({
          firstName, dateFormatted, timeFormatted, endTimeFormatted,
          serviceNames, totalDuration
        })
      });
      console.log('Client email sent:', JSON.stringify(clientEmailResult));
    } catch (emailErr) {
      console.error('Client email error:', emailErr.message, JSON.stringify(emailErr));
    }

    // 7. Send notification email to Mimi (includes client notes from booking)
    console.log('Sending notification email to Mimi:', MIMI_EMAIL);
    try {
      const mimiEmailResult = await resend.emails.send({
        from: 'Mimi\'s Studio Booking <onboarding@resend.dev>',
        to: MIMI_EMAIL,
        subject: `New Booking: ${firstName} ${lastName} - ${dateFormatted} at ${timeFormatted}`,
        html: mimiEmailHtml({
          firstName, lastName, email, phone,
          dateFormatted, timeFormatted, endTimeFormatted,
          serviceNames, totalDuration, notes
        })
      });
      console.log('Mimi email sent:', JSON.stringify(mimiEmailResult));
    } catch (emailErr) {
      console.error('Mimi email error:', emailErr.message, JSON.stringify(emailErr));
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        success: true,
        appointmentId: appointment.id,
        clientId: clientId,
        message: 'Appointment booked successfully!'
      }),
    };
  } catch (err) {
    console.error('Booking error:', err.message, JSON.stringify(err));
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Something went wrong. Please try again or call the studio.' }),
    };
  }
};

// ─── SMART DUPLICATE DETECTION ────────────────────────────
// If 2 or more of (first_name, last_name, phone, email) match an existing client, return that client's ID
async function findExistingClient(firstName, lastName, email, phone) {
  const { data: allClients } = await supabase
    .from('clients')
    .select('id, first_name, last_name, email, phone');

  if (!allClients || allClients.length === 0) return null;

  // Also fetch all phones and emails from the extended tables
  const { data: allPhones } = await supabase.from('client_phones').select('client_id, phone');
  const { data: allEmails } = await supabase.from('client_emails').select('client_id, email');

  // Build lookup maps
  const phonesByClient = {};
  (allPhones || []).forEach(p => {
    if (!phonesByClient[p.client_id]) phonesByClient[p.client_id] = [];
    phonesByClient[p.client_id].push(p.phone.replace(/\D/g, ''));
  });

  const emailsByClient = {};
  (allEmails || []).forEach(e => {
    if (!emailsByClient[e.client_id]) emailsByClient[e.client_id] = [];
    emailsByClient[e.client_id].push(e.email.toLowerCase());
  });

  const incomingPhone = phone.replace(/\D/g, '');
  const incomingEmail = email.toLowerCase();

  let bestMatch = null;
  let bestScore = 0;

  for (const client of allClients) {
    let score = 0;

    // Check first name match
    if (client.first_name && client.first_name.toLowerCase() === firstName.toLowerCase()) score++;

    // Check last name match
    if (client.last_name && client.last_name.toLowerCase() === lastName.toLowerCase()) score++;

    // Check phone match (against main field + extended phones)
    const clientPhoneDigits = (client.phone || '').replace(/\D/g, '');
    const extPhones = phonesByClient[client.id] || [];
    if (
      (clientPhoneDigits && clientPhoneDigits === incomingPhone) ||
      extPhones.includes(incomingPhone)
    ) {
      score++;
    }

    // Check email match (against main field + extended emails)
    const clientEmailLower = (client.email || '').toLowerCase();
    const extEmails = emailsByClient[client.id] || [];
    if (
      (clientEmailLower && clientEmailLower === incomingEmail) ||
      extEmails.includes(incomingEmail)
    ) {
      score++;
    }

    if (score >= 2 && score > bestScore) {
      bestScore = score;
      bestMatch = client.id;
    }
  }

  return bestMatch;
}

// Add phone to client_phones if not already present (max 5)
async function addPhoneIfNew(clientId, phone) {
  const normalized = phone.replace(/\D/g, '');
  const { data: existing } = await supabase
    .from('client_phones')
    .select('id, phone')
    .eq('client_id', clientId);

  const alreadyExists = (existing || []).some(p => p.phone.replace(/\D/g, '') === normalized);
  if (alreadyExists) return;

  if ((existing || []).length >= 5) return; // Max 5 phones

  await supabase.from('client_phones').insert({
    client_id: clientId,
    phone: phone,
    label: 'other'
  });
}

// Add email to client_emails if not already present (max 5)
async function addEmailIfNew(clientId, email) {
  const normalized = email.toLowerCase();
  const { data: existing } = await supabase
    .from('client_emails')
    .select('id, email')
    .eq('client_id', clientId);

  const alreadyExists = (existing || []).some(e => e.email.toLowerCase() === normalized);
  if (alreadyExists) return;

  if ((existing || []).length >= 5) return; // Max 5 emails

  await supabase.from('client_emails').insert({
    client_id: clientId,
    email: email,
    label: 'other'
  });
}

// ─── HELPERS ──────────────────────────────────────────────

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

// ─── CLIENT CONFIRMATION EMAIL (with full Mimi's contact info) ───

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
    <div style="background: #5C3D2E; padding: 20px; text-align: center;">
      <p style="color: #E0CC9D; font-size: 14px; margin: 0 0 6px; font-weight: bold;">Mimi's Studio</p>
      <p style="color: #E0CC9D; font-size: 13px; margin: 0 0 4px;">
        <a href="tel:+17072924914" style="color: #E0CC9D; text-decoration: none;">(707) 292-4914</a> &nbsp;|&nbsp;
        <a href="mailto:mimisstudio@gmail.com" style="color: #E0CC9D; text-decoration: none;">mimisstudio@gmail.com</a>
      </p>
      <p style="color: #c4a882; font-size: 12px; margin: 4px 0 0;">
        330 South A St, Santa Rosa, CA 95401
      </p>
    </div>
  </div>`;
}

// ─── MIMI NOTIFICATION EMAIL (includes client booking notes prominently) ───

function mimiEmailHtml({ firstName, lastName, email, phone, dateFormatted, timeFormatted, endTimeFormatted, serviceNames, totalDuration, notes }) {
  const notesSection = notes ? `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #E8DDD5; color: #9C8578; vertical-align: top; font-weight: bold;">Client Notes</td>
      <td style="padding: 12px; border-bottom: 1px solid #E8DDD5; color: #3A2820; background: #FFF8F0; border-left: 3px solid #C47D5A; font-style: italic;">${notes}</td>
    </tr>` : '';

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
        ${notesSection}
      </table>
    </div>
    <div style="background: #5C3D2E; padding: 12px; text-align: center;">
      <p style="color: #E0CC9D; font-size: 12px; margin: 0;">(707) 292-4914 | mimisstudio@gmail.com | 330 South A St, Santa Rosa, CA 95401</p>
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
