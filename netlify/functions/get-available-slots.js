const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const OPEN_HOUR = 11;
const CLOSE_HOUR = 19;
const SLOT_INCREMENT = 30;
const OPEN_DAYS = [2, 3, 4, 5, 6]; // Tue-Sat

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  try {
    const { date, duration } = JSON.parse(event.body || '{}');

    if (!date || !duration) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'date and duration are required' }),
      };
    }

    // Check if the date is a valid business day
    const dateObj = new Date(date + 'T12:00:00');
    const dayOfWeek = dateObj.getDay();
    if (!OPEN_DAYS.includes(dayOfWeek)) {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({ slots: [], message: 'Closed on this day' }),
      };
    }

    // Get existing appointments for this date
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('start_time, end_time')
      .eq('appointment_date', date)
      .in('status', ['confirmed']);

    if (error) throw error;

    // Generate all possible slots
    const slots = [];
    const closingMin = CLOSE_HOUR * 60;

    for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
      for (let m = 0; m < 60; m += SLOT_INCREMENT) {
        const slotStart = h * 60 + m;
        const slotEnd = slotStart + parseInt(duration);

        // Check if appointment fits before closing
        const fits = slotEnd <= closingMin;

        // Check for conflicts with existing bookings
        const conflicted = appointments.some(appt =>
          slotStart < appt.end_time && slotEnd > appt.start_time
        );

        slots.push({
          start: slotStart,
          available: fits && !conflicted,
          label: formatTime(slotStart),
        });
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ slots }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
