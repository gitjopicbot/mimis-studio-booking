const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const SLOT_INCREMENT = 30; // 30 minutes per slot
const REFERENCE_DATE = new Date('2026-04-04'); // First working Saturday

// Business hours by day of week (in minutes since midnight)
const HOURS = {
  0: null, // Sunday: CLOSED
  1: null, // Monday: CLOSED
  2: [150, 360], // Tuesday: 2:30 PM - 6:00 PM (870 - 1080 mins) - corrected to 150 = 2:30 PM
  3: [660, 1080], // Wednesday: 11:00 AM - 6:00 PM
  4: [660, 1080], // Thursday: 11:00 AM - 6:00 PM
  5: [660, 1080], // Friday: 11:00 AM - 6:00 PM
  6: null, // Saturday: Depends on alternating schedule
};

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

    // Parse the date and get day of week
    const dateObj = new Date(date + 'T12:00:00');
    const dayOfWeek = dateObj.getDay();

    // Determine business hours for this day
    let hours = HOURS[dayOfWeek];

    // Handle Saturday alternating schedule
    if (dayOfWeek === 6) {
      hours = getSaturdayHours(dateObj);
    }

    // If closed, return no slots
    if (!hours) {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({ slots: [], message: 'Closed on this day' }),
      };
    }

    const [openMin, closeMin] = hours;
    const durationMin = parseInt(duration);

    // Get existing appointments and blocks for this date
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('start_time, end_time, status')
      .eq('appointment_date', date)
      .in('status', ['confirmed', 'blocked']);

    if (error) throw error;

    // Generate all possible slots for the day
    const allSlots = [];
    for (let m = openMin; m < closeMin; m += SLOT_INCREMENT) {
      const slotStart = m;
      const slotEnd = slotStart + durationMin;

      allSlots.push({
        start: slotStart,
        label: formatTime(slotStart),
      });
    }

    // Determine available slots
    let availableSlots;

    if (appointments.length === 0) {
      // No appointments: all slots within business hours are available
      availableSlots = allSlots.map(slot => ({ ...slot, available: true }));
    } else {
      // Apply contiguous blocking logic
      availableSlots = applyContiguousLogic(
        allSlots,
        appointments,
        durationMin,
        closeMin
      );
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ slots: availableSlots }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message }),
    };
  }
};

/**
 * Applies contiguous blocking logic:
 * - For each appointment: 2 slots before it are available, the appointment is blocked, 1 slot after is available
 * - UNION all these windows
 * - Slots outside the union are blocked
 * - Still verify duration fits and no overlap with appointments
 */
function applyContiguousLogic(allSlots, appointments, durationMin, closeMin) {
  const TWO_SLOTS_MIN = 2 * 30; // 60 minutes
  const ONE_SLOT_MIN = 1 * 30; // 30 minutes

  // Build union of available windows
  const availableWindows = [];

  appointments.forEach(appt => {
    const apptStart = appt.start_time;
    const apptEnd = appt.end_time;

    // 2 slots (60 min) before
    const windowStart = Math.max(apptStart - TWO_SLOTS_MIN, 0);
    // 1 slot (30 min) after
    const windowEnd = Math.min(apptEnd + ONE_SLOT_MIN, closeMin);

    availableWindows.push({ start: windowStart, end: windowEnd });
  });

  // Merge overlapping windows
  const mergedWindows = mergeWindows(availableWindows);

  // Mark slots
  return allSlots.map(slot => {
    const slotStart = slot.start;
    const slotEnd = slotStart + durationMin;

    // Check if slot duration fits before closing
    const fitsBefore = slotEnd <= closeMin;

    // Check if slot overlaps with any appointment
    const overlapsAppt = appointments.some(
      appt => slotStart < appt.end_time && slotEnd > appt.start_time
    );

    // Check if slot falls within available windows
    const inAvailableWindow = mergedWindows.some(
      win => slotStart >= win.start && slotEnd <= win.end
    );

    const available = fitsBefore && !overlapsAppt && inAvailableWindow;

    return { ...slot, available };
  });
}

/**
 * Merge overlapping time windows
 */
function mergeWindows(windows) {
  if (windows.length === 0) return [];

  // Sort by start time
  const sorted = [...windows].sort((a, b) => a.start - b.start);

  const merged = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const current = sorted[i];

    if (current.start <= last.end) {
      // Overlapping or adjacent: merge
      last.end = Math.max(last.end, current.end);
    } else {
      // Non-overlapping: add new window
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Determine if a Saturday is a working Saturday.
 * Reference: April 4, 2026 is a working Saturday.
 * April 11, 2026 is OFF (one week later).
 * They alternate.
 * Logic: count weeks since April 4. Even weeks = working, odd weeks = off.
 */
function getSaturdayHours(dateObj) {
  const weeksSinceReference = Math.floor(
    (dateObj - REFERENCE_DATE) / (7 * 24 * 60 * 60 * 1000)
  );

  const isWorkingSaturday = weeksSinceReference % 2 === 0;

  if (isWorkingSaturday) {
    // 1:30 PM - 5:00 PM (810 - 1020 minutes)
    return [810, 1020];
  } else {
    // Off Saturday
    return null;
  }
}

function formatTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
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
