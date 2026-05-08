/**
 * Netlify Function: Admin API
 * Handles admin operations for the Mimi's Studio admin panel
 * Requires Bearer token authentication
 *
 * Actions:
 *   getAppointments, updateAppointment, deleteAppointment, blockTime,
 *   getClients, searchClients, getClientDetail, getClientAppointments,
 *   updateClient, mergeClients, removeClient, shareClientHistory,
 *   addAdminNote, clearTestData, getDailySchedule, adminBookAppointment
 */

const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || "mimi-studio-secret-key";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function validateToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  try {
    const token = authHeader.substring(7);
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const parts = decoded.split(":");
    if (parts.length !== 3) return false;
    if (parts[2] !== TOKEN_SECRET) return false;
    return true;
  } catch (error) {
    console.error("Token validation error:", error);
    return false;
  }
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

function errorResponse(statusCode, message) {
  return { statusCode, headers: getCorsHeaders(), body: JSON.stringify({ error: message }) };
}

function successResponse(data) {
  return { statusCode: 200, headers: getCorsHeaders(), body: JSON.stringify(data) };
}

// ─── APPOINTMENTS ──────────────────────────────────────────

async function getAppointments() {
  const { data: appointments, error } = await supabase
    .from("appointments")
    .select(`
      *,
      clients (id, first_name, last_name, email, phone),
      appointment_services (service_id, services (id, name, duration_minutes))
    `)
    .order("appointment_date", { ascending: false })
    .order("start_time", { ascending: false });

  if (error) throw new Error(`Failed to fetch appointments: ${error.message}`);
  return appointments;
}

async function updateAppointment(appointmentId, updates) {
  const allowedFields = ["status", "appointment_date", "start_time", "end_time", "notes", "admin_notes"];
  const updateData = {};
  for (const field of allowedFields) {
    if (field in updates) updateData[field] = updates[field];
  }
  if (Object.keys(updateData).length === 0) throw new Error("No valid fields to update");

  // Always stamp an updated_at so the appointment log can show when changes (e.g., cancellations) occurred
  updateData.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("appointments")
    .update(updateData)
    .eq("id", appointmentId)
    .select();

  if (error) throw new Error(`Failed to update appointment: ${error.message}`);
  if (!data || data.length === 0) throw new Error("Appointment not found");
  return data[0];
}

async function deleteAppointment(appointmentId) {
  const { error: servicesError } = await supabase
    .from("appointment_services")
    .delete()
    .eq("appointment_id", appointmentId);
  if (servicesError) throw new Error(`Failed to delete appointment services: ${servicesError.message}`);

  const { data, error } = await supabase
    .from("appointments")
    .delete()
    .eq("id", appointmentId)
    .select();
  if (error) throw new Error(`Failed to delete appointment: ${error.message}`);
  return { deleted: true, appointmentId };
}

async function blockTime(date, startTime, endTime, reason) {
  // Convert "HH:MM" strings to minutes from midnight (to match booking system format)
  function timeToMinutes(t) {
    if (typeof t === 'number') return t;
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + (m || 0);
  }

  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  const duration = endMinutes - startMinutes;

  const { data, error } = await supabase
    .from("appointments")
    .insert([{
      client_id: null,
      appointment_date: date,
      start_time: startMinutes,
      end_time: endMinutes,
      total_duration: duration > 0 ? duration : 0,
      status: "blocked",
      notes: reason,
      created_at: new Date().toISOString(),
    }])
    .select();
  if (error) throw new Error(`Failed to create time block: ${error.message}`);
  if (!data || data.length === 0) throw new Error("Failed to create time block");
  return data[0];
}

async function addAdminNote(appointmentId, adminNotes) {
  const { data, error } = await supabase
    .from("appointments")
    .update({ admin_notes: adminNotes })
    .eq("id", appointmentId)
    .select();
  if (error) throw new Error(`Failed to add admin note: ${error.message}`);
  if (!data || data.length === 0) throw new Error("Appointment not found");
  return data[0];
}

async function adminBookAppointment(clientId, date, startTime, endTime, totalDuration, serviceIds, notes, adminNotes) {
  // Create appointment record
  const { data: apptData, error: apptError } = await supabase
    .from("appointments")
    .insert([{
      client_id: clientId,
      appointment_date: date,
      start_time: startTime,
      end_time: endTime,
      total_duration: totalDuration,
      status: "confirmed",
      notes: notes || "",
      admin_notes: adminNotes || "",
      created_at: new Date().toISOString(),
    }])
    .select();

  if (apptError) throw new Error(`Failed to create appointment: ${apptError.message}`);
  if (!apptData || apptData.length === 0) throw new Error("Failed to create appointment");

  const appointmentId = apptData[0].id;

  // Link services
  if (serviceIds && Array.isArray(serviceIds) && serviceIds.length > 0) {
    const servicesToInsert = serviceIds.map((serviceId) => ({
      appointment_id: appointmentId,
      service_id: serviceId,
    }));

    const { error: servicesError } = await supabase
      .from("appointment_services")
      .insert(servicesToInsert);

    if (servicesError) {
      // Clean up the appointment if service insertion fails
      await supabase.from("appointments").delete().eq("id", appointmentId);
      throw new Error(`Failed to link services: ${servicesError.message}`);
    }
  }

  // Return the created appointment with services
  const { data: fullAppt, error: fetchError } = await supabase
    .from("appointments")
    .select(`
      *,
      appointment_services (service_id, services (id, name, duration_minutes))
    `)
    .eq("id", appointmentId)
    .single();

  if (fetchError) throw new Error(`Failed to fetch created appointment: ${fetchError.message}`);
  return fullAppt;
}

async function getDailySchedule(date) {
  const { data, error } = await supabase
    .from("appointments")
    .select(`
      *,
      clients (id, first_name, last_name, email, phone),
      appointment_services (service_id, services (id, name, duration_minutes))
    `)
    .eq("appointment_date", date)
    .order("start_time", { ascending: true });
  if (error) throw new Error(`Failed to fetch daily schedule: ${error.message}`);
  return data;
}

// ─── CLIENTS ───────────────────────────────────────────────

// Get all clients with appointment counts, phones, emails
async function getClients() {
  // Bulk-fetch everything in 4 queries instead of 3 per client
  const [clientsRes, phonesRes, emailsRes, apptsRes] = await Promise.all([
    supabase.from("clients").select("*"),
    supabase.from("client_phones").select("*").order("created_at"),
    supabase.from("client_emails").select("*").order("created_at"),
    supabase.from("appointments").select("client_id"),
  ]);

  if (clientsRes.error) throw new Error(`Failed to fetch clients: ${clientsRes.error.message}`);

  const clients = clientsRes.data;
  const allPhones = phonesRes.data || [];
  const allEmails = emailsRes.data || [];
  const allAppts = apptsRes.data || [];

  // Index phones and emails by client_id
  const phonesByClient = {};
  for (const p of allPhones) {
    if (!phonesByClient[p.client_id]) phonesByClient[p.client_id] = [];
    phonesByClient[p.client_id].push(p);
  }

  const emailsByClient = {};
  for (const e of allEmails) {
    if (!emailsByClient[e.client_id]) emailsByClient[e.client_id] = [];
    emailsByClient[e.client_id].push(e);
  }

  // Count appointments per client
  const apptCountByClient = {};
  for (const a of allAppts) {
    apptCountByClient[a.client_id] = (apptCountByClient[a.client_id] || 0) + 1;
  }

  // Enrich clients in memory
  return clients.map((client) => ({
    ...client,
    phones: phonesByClient[client.id] || [],
    emails: emailsByClient[client.id] || [],
    appointment_count: apptCountByClient[client.id] || 0,
  }));
}

// Search clients by name, phone, or email
async function searchClients(query) {
  if (!query || query.trim().length === 0) return [];

  const q = query.trim().toLowerCase();

  // Search by name
  const { data: nameResults } = await supabase
    .from("clients")
    .select("*")
    .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%`);

  // Search by phone in client_phones table
  const { data: phoneResults } = await supabase
    .from("client_phones")
    .select("client_id")
    .ilike("phone", `%${q}%`);

  // Search by email in client_emails table
  const { data: emailResults } = await supabase
    .from("client_emails")
    .select("client_id")
    .ilike("email", `%${q}%`);

  // Also search the main clients table phone/email fields
  const { data: mainFieldResults } = await supabase
    .from("clients")
    .select("*")
    .or(`phone.ilike.%${q}%,email.ilike.%${q}%`);

  // Collect unique client IDs
  const clientIds = new Set();
  (nameResults || []).forEach(c => clientIds.add(c.id));
  (phoneResults || []).forEach(r => clientIds.add(r.client_id));
  (emailResults || []).forEach(r => clientIds.add(r.client_id));
  (mainFieldResults || []).forEach(c => clientIds.add(c.id));

  if (clientIds.size === 0) return [];

  // Fetch full client data for all matches
  const { data: clients } = await supabase
    .from("clients")
    .select("*")
    .in("id", Array.from(clientIds));

  // Enrich with phones, emails, counts
  const enriched = await Promise.all(
    (clients || []).map(async (client) => {
      const [phonesRes, emailsRes, countRes] = await Promise.all([
        supabase.from("client_phones").select("*").eq("client_id", client.id).order("created_at"),
        supabase.from("client_emails").select("*").eq("client_id", client.id).order("created_at"),
        supabase.from("appointments").select("*", { count: "exact", head: true }).eq("client_id", client.id),
      ]);
      return {
        ...client,
        phones: phonesRes.data || [],
        emails: emailsRes.data || [],
        appointment_count: countRes.count || 0,
      };
    })
  );

  return enriched;
}

// Get single client detail with all phones, emails, notes
async function getClientDetail(clientId) {
  const { data: client, error } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .single();
  if (error) throw new Error(`Client not found: ${error.message}`);

  const [phonesRes, emailsRes, countRes] = await Promise.all([
    supabase.from("client_phones").select("*").eq("client_id", clientId).order("created_at"),
    supabase.from("client_emails").select("*").eq("client_id", clientId).order("created_at"),
    supabase.from("appointments").select("*", { count: "exact", head: true }).eq("client_id", clientId),
  ]);

  return {
    ...client,
    phones: phonesRes.data || [],
    emails: emailsRes.data || [],
    appointment_count: countRes.count || 0,
  };
}

// Get all appointments for a specific client
async function getClientAppointments(clientId) {
  const { data, error } = await supabase
    .from("appointments")
    .select(`
      *,
      appointment_services (service_id, services (id, name, duration_minutes))
    `)
    .eq("client_id", clientId)
    .order("appointment_date", { ascending: false })
    .order("start_time", { ascending: false });

  if (error) throw new Error(`Failed to fetch client appointments: ${error.message}`);
  return data;
}

// Update client info (name, notes, phones, emails)
async function updateClient(clientId, updates) {
  // Update basic client fields
  const allowedFields = ["first_name", "last_name", "client_notes"];
  const updateData = {};
  for (const field of allowedFields) {
    if (field in updates) updateData[field] = updates[field];
  }

  if (Object.keys(updateData).length > 0) {
    updateData.updated_at = new Date().toISOString();
    const { error } = await supabase.from("clients").update(updateData).eq("id", clientId);
    if (error) throw new Error(`Failed to update client: ${error.message}`);
  }

  // Handle phones: replace all phone records (admin sends full list)
  if (updates.phones !== undefined) {
    // Delete existing phones
    await supabase.from("client_phones").delete().eq("client_id", clientId);
    // Insert new phones (up to 5)
    const phonesToInsert = updates.phones.slice(0, 5).map((p, i) => ({
      client_id: clientId,
      phone: p.phone,
      label: p.label || (i === 0 ? "primary" : "other"),
    }));
    if (phonesToInsert.length > 0) {
      const { error } = await supabase.from("client_phones").insert(phonesToInsert);
      if (error) throw new Error(`Failed to update phones: ${error.message}`);
    }
    // Also update the main clients.phone field with the primary phone
    if (phonesToInsert.length > 0) {
      await supabase.from("clients").update({ phone: phonesToInsert[0].phone }).eq("id", clientId);
    }
  }

  // Handle emails: replace all email records (admin sends full list)
  if (updates.emails !== undefined) {
    // Delete existing emails
    await supabase.from("client_emails").delete().eq("client_id", clientId);
    // Insert new emails (up to 5)
    const emailsToInsert = updates.emails.slice(0, 5).map((e, i) => ({
      client_id: clientId,
      email: e.email,
      label: e.label || (i === 0 ? "primary" : "other"),
    }));
    if (emailsToInsert.length > 0) {
      const { error } = await supabase.from("client_emails").insert(emailsToInsert);
      if (error) throw new Error(`Failed to update emails: ${error.message}`);
    }
    // Also update the main clients.email field with the primary email
    if (emailsToInsert.length > 0) {
      await supabase.from("clients").update({ email: emailsToInsert[0].email }).eq("id", clientId);
    }
  }

  return await getClientDetail(clientId);
}

// Merge duplicate clients: keep target, move all appointments/phones/emails from source, delete source
async function mergeClients(targetClientId, sourceClientId) {
  if (targetClientId === sourceClientId) throw new Error("Cannot merge a client with itself");

  // Verify both clients exist
  const [targetRes, sourceRes] = await Promise.all([
    supabase.from("clients").select("*").eq("id", targetClientId).single(),
    supabase.from("clients").select("*").eq("id", sourceClientId).single(),
  ]);
  if (targetRes.error) throw new Error("Target client not found");
  if (sourceRes.error) throw new Error("Source client not found");

  const target = targetRes.data;
  const source = sourceRes.data;

  // 1. Move all appointments from source to target
  const { error: apptErr } = await supabase
    .from("appointments")
    .update({ client_id: targetClientId })
    .eq("client_id", sourceClientId);
  if (apptErr) throw new Error(`Failed to move appointments: ${apptErr.message}`);

  // 2. Move phones from source to target (avoid exact duplicates)
  const { data: targetPhones } = await supabase
    .from("client_phones")
    .select("phone")
    .eq("client_id", targetClientId);
  const existingPhones = new Set((targetPhones || []).map(p => p.phone));

  const { data: sourcePhones } = await supabase
    .from("client_phones")
    .select("*")
    .eq("client_id", sourceClientId);

  for (const sp of (sourcePhones || [])) {
    if (!existingPhones.has(sp.phone)) {
      await supabase.from("client_phones").insert({
        client_id: targetClientId,
        phone: sp.phone,
        label: sp.label || "other",
      });
    }
  }

  // 3. Move emails from source to target (avoid exact duplicates)
  const { data: targetEmails } = await supabase
    .from("client_emails")
    .select("email")
    .eq("client_id", targetClientId);
  const existingEmails = new Set((targetEmails || []).map(e => e.email.toLowerCase()));

  const { data: sourceEmails } = await supabase
    .from("client_emails")
    .select("*")
    .eq("client_id", sourceClientId);

  for (const se of (sourceEmails || [])) {
    if (!existingEmails.has(se.email.toLowerCase())) {
      await supabase.from("client_emails").insert({
        client_id: targetClientId,
        email: se.email,
        label: se.label || "other",
      });
    }
  }

  // 4. Merge notes (append source notes to target)
  if (source.client_notes && source.client_notes.trim()) {
    const mergedNotes = [
      target.client_notes || "",
      `[Merged from ${source.first_name} ${source.last_name}]: ${source.client_notes}`,
    ].filter(Boolean).join("\n");
    await supabase.from("clients").update({ client_notes: mergedNotes }).eq("id", targetClientId);
  }

  // 5. Delete source client's phones and emails
  await supabase.from("client_phones").delete().eq("client_id", sourceClientId);
  await supabase.from("client_emails").delete().eq("client_id", sourceClientId);

  // 6. Delete source client
  const { error: deleteErr } = await supabase
    .from("clients")
    .delete()
    .eq("id", sourceClientId);
  if (deleteErr) throw new Error(`Failed to delete source client: ${deleteErr.message}`);

  // Enforce limits: keep max 5 phones and 5 emails on target
  const { data: finalPhones } = await supabase
    .from("client_phones")
    .select("*")
    .eq("client_id", targetClientId)
    .order("created_at");
  if (finalPhones && finalPhones.length > 5) {
    const toDelete = finalPhones.slice(5).map(p => p.id);
    await supabase.from("client_phones").delete().in("id", toDelete);
  }

  const { data: finalEmails } = await supabase
    .from("client_emails")
    .select("*")
    .eq("client_id", targetClientId)
    .order("created_at");
  if (finalEmails && finalEmails.length > 5) {
    const toDelete = finalEmails.slice(5).map(e => e.id);
    await supabase.from("client_emails").delete().in("id", toDelete);
  }

  return await getClientDetail(targetClientId);
}

// ─── REMOVE CLIENT ────────────────────────────────────────
//
// Permanently deletes a client and all their associated records.
// Refuses to delete if the client has any future CONFIRMED appointments —
// admin must cancel those first. Past appointments are cascade-deleted.
//
// Cascade order: appointment_services → appointments → client_phones
// → client_emails → clients.

async function removeClient(clientId) {
  // 1. Verify client exists, capture name for the response
  const { data: client, error: cErr } = await supabase
    .from("clients")
    .select("id, first_name, last_name")
    .eq("id", clientId)
    .single();
  if (cErr || !client) throw new Error("Client not found");

  // 2. Block if client has any future confirmed appointments (PT calendar)
  const todayPt = salonDateStrToday();
  const { data: futureAppts, error: fErr } = await supabase
    .from("appointments")
    .select("id, appointment_date, start_time")
    .eq("client_id", clientId)
    .eq("status", "confirmed")
    .gte("appointment_date", todayPt);
  if (fErr) throw new Error(`Failed to check future appointments: ${fErr.message}`);
  if (futureAppts && futureAppts.length > 0) {
    const count = futureAppts.length;
    throw new Error(
      `Cannot remove ${client.first_name} ${client.last_name} — they have ${count} upcoming appointment${count === 1 ? "" : "s"}. Please cancel ${count === 1 ? "it" : "them"} first.`
    );
  }

  // 3. Cascade delete — gather appointment IDs first (for appointment_services)
  const { data: appts } = await supabase
    .from("appointments")
    .select("id")
    .eq("client_id", clientId);
  const apptIds = (appts || []).map(a => a.id);

  if (apptIds.length > 0) {
    const { error: asErr } = await supabase
      .from("appointment_services")
      .delete()
      .in("appointment_id", apptIds);
    if (asErr) throw new Error(`Failed to delete appointment services: ${asErr.message}`);
  }

  // 4. Delete the appointments themselves
  const { error: aErr } = await supabase
    .from("appointments")
    .delete()
    .eq("client_id", clientId);
  if (aErr) throw new Error(`Failed to delete appointments: ${aErr.message}`);

  // 5. Delete contact rows
  await supabase.from("client_phones").delete().eq("client_id", clientId);
  await supabase.from("client_emails").delete().eq("client_id", clientId);

  // 6. Finally delete the client
  const { error: dErr } = await supabase
    .from("clients")
    .delete()
    .eq("id", clientId);
  if (dErr) throw new Error(`Failed to delete client: ${dErr.message}`);

  return {
    removed: true,
    clientId,
    name: `${client.first_name} ${client.last_name}`.trim(),
    appointmentsDeleted: apptIds.length,
  };
}

// Pacific-time today as YYYY-MM-DD string. Used for "future appointment" checks.
function salonDateStrToday() {
  const ptNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return ptNow.toISOString().split("T")[0];
}

// ─── SHARE APPOINTMENT HISTORY ────────────────────────────
//
// Emails the client a complete copy of their appointment history (past +
// upcoming) with a friendly canned message. Pulls services, dates, times,
// and notes for each appointment.

async function shareClientHistory(clientId) {
  if (!resend) throw new Error("Email not configured (RESEND_API_KEY missing)");

  // Fetch client + their primary email
  const { data: client, error: cErr } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email")
    .eq("id", clientId)
    .single();
  if (cErr || !client) throw new Error("Client not found");
  if (!client.email) throw new Error(`${client.first_name || "Client"} has no email on file`);

  // Fetch all visible appointments (confirmed + completed; skip blocked/cancelled)
  const { data: rawAppts, error: aErr } = await supabase
    .from("appointments")
    .select(`
      id, appointment_date, start_time, end_time, status, notes,
      appointment_services (services (name))
    `)
    .eq("client_id", clientId)
    .order("appointment_date", { ascending: false })
    .order("start_time", { ascending: false });
  if (aErr) throw new Error(`Failed to fetch appointments: ${aErr.message}`);

  const visible = (rawAppts || []).filter(
    a => a.status === "confirmed" || a.status === "completed"
  );
  if (visible.length === 0) {
    throw new Error("This client has no appointment history to share.");
  }

  // Build + send the email
  const html = clientHistoryEmailHtml({
    firstName: client.first_name,
    appointments: visible,
  });

  const sendRes = await resend.emails.send({
    from: "Mimi's Studio <bookings@mimisstudio1.com>",
    to: client.email,
    subject: "Your Mimi's Studio appointment history",
    html,
  });

  console.log(`[shareClientHistory] Sent to ${client.email}, resend id=${sendRes?.data?.id || "n/a"}, ${visible.length} appointments`);

  return {
    sent: true,
    to: client.email,
    appointmentsIncluded: visible.length,
    resendId: sendRes?.data?.id || null,
  };
}

function clientHistoryEmailHtml({ firstName, appointments }) {
  const todayPt = salonDateStrToday();
  const upcoming = appointments.filter(a => a.appointment_date >= todayPt);
  const past = appointments.filter(a => a.appointment_date < todayPt);

  function formatDate(dateStr) {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
  function formatTime(mins) {
    if (mins === null || mins === undefined) return "";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    const ampm = h >= 12 ? "PM" : "AM";
    return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  }
  function apptRow(a) {
    const services = (a.appointment_services || [])
      .map(as => as.services && as.services.name)
      .filter(Boolean);
    return `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #ECE3D0; vertical-align: top; width: 38%;">
          <div style="color: #466B8E; font-weight: bold; font-size: 14px;">${formatDate(a.appointment_date)}</div>
          <div style="color: #6B91B5; font-size: 13px; margin-top: 2px;">${formatTime(a.start_time)}</div>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #ECE3D0; vertical-align: top; color: #2C3E55; font-size: 13px;">
          ${services.length > 0 ? services.join("<br>") : "<em style='color:#95A0B0;'>No services on record</em>"}
          ${a.notes ? `<div style="color: #5C6B82; font-style: italic; margin-top: 6px; font-size: 12px;">Note: ${escapeHtml(a.notes)}</div>` : ""}
        </td>
      </tr>`;
  }

  const upcomingTable = upcoming.length > 0 ? `
    <h3 style="color: #466B8E; margin: 24px 0 8px; font-family: 'Georgia', serif; font-size: 17px;">Upcoming</h3>
    <table style="width: 100%; border-collapse: collapse; background: #FFFFFF; border-radius: 8px; overflow: hidden; border: 1px solid #ECE3D0;">
      ${upcoming.map(apptRow).join("")}
    </table>` : "";
  const pastTable = past.length > 0 ? `
    <h3 style="color: #466B8E; margin: 24px 0 8px; font-family: 'Georgia', serif; font-size: 17px;">Past Appointments</h3>
    <table style="width: 100%; border-collapse: collapse; background: #FFFFFF; border-radius: 8px; overflow: hidden; border: 1px solid #ECE3D0;">
      ${past.map(apptRow).join("")}
    </table>` : "";

  return `
  <div style="font-family: 'Georgia', serif; max-width: 600px; margin: 0 auto; background: #FAF6EC;">
    <div style="background: linear-gradient(135deg, #466B8E 0%, #6B91B5 55%, #8FA8C9 100%); padding: 30px; text-align: center;">
      <h1 style="color: #FAF6EC; font-size: 28px; margin: 0;">Mimi's Studio</h1>
      <p style="color: #E8D4A0; font-size: 14px; margin: 5px 0 0; letter-spacing: 2px;">APPOINTMENT HISTORY</p>
    </div>
    <div style="padding: 30px;">
      <p style="color: #2C3E55; font-size: 16px;">Hey ${escapeHtml(firstName || "there")},</p>
      <p style="color: #5C6B82; font-size: 15px; line-height: 1.6;">
        Here is the appointment history you requested. Please let me know if you have any questions.
      </p>
      ${upcomingTable}
      ${pastTable}
      <p style="color: #5C6B82; font-size: 14px; line-height: 1.6; margin-top: 28px;">
        Thank you for being a valued client!
      </p>
      <p style="color: #2C3E55; font-weight: bold; margin-top: 8px;">- Mimi's Studio</p>
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

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── CLEAR TEST DATA ──────────────────────────────────────

async function clearTestData() {
  await supabase.from("appointment_services").delete().neq("appointment_id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("appointments").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("client_phones").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("client_emails").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("clients").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  return { cleared: true };
}

// ─── MAIN HANDLER ──────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: getCorsHeaders(), body: "" };
  }

  if (event.httpMethod !== "POST") return errorResponse(405, "Method not allowed");

  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!validateToken(authHeader)) return errorResponse(401, "Unauthorized");

  try {
    const body = JSON.parse(event.body || "{}");
    const { action, ...params } = body;
    if (!action) return errorResponse(400, "Missing action parameter");

    let result;

    switch (action) {
      case "getAppointments":
        result = await getAppointments();
        break;
      case "updateAppointment":
        if (!params.appointmentId || !params.updates)
          return errorResponse(400, "Missing appointmentId or updates");
        result = await updateAppointment(params.appointmentId, params.updates);
        break;
      case "deleteAppointment":
        if (!params.appointmentId) return errorResponse(400, "Missing appointmentId");
        result = await deleteAppointment(params.appointmentId);
        break;
      case "blockTime":
        if (!params.date || !params.startTime || !params.endTime || !params.reason)
          return errorResponse(400, "Missing date, startTime, endTime, or reason");
        result = await blockTime(params.date, params.startTime, params.endTime, params.reason);
        break;
      case "getClients":
        result = await getClients();
        break;
      case "searchClients":
        if (!params.query) return errorResponse(400, "Missing search query");
        result = await searchClients(params.query);
        break;
      case "getClientDetail":
        if (!params.clientId) return errorResponse(400, "Missing clientId");
        result = await getClientDetail(params.clientId);
        break;
      case "getClientAppointments":
        if (!params.clientId) return errorResponse(400, "Missing clientId");
        result = await getClientAppointments(params.clientId);
        break;
      case "updateClient":
        if (!params.clientId || !params.updates)
          return errorResponse(400, "Missing clientId or updates");
        result = await updateClient(params.clientId, params.updates);
        break;
      case "mergeClients":
        if (!params.targetClientId || !params.sourceClientId)
          return errorResponse(400, "Missing targetClientId or sourceClientId");
        result = await mergeClients(params.targetClientId, params.sourceClientId);
        break;
      case "removeClient":
        if (!params.clientId) return errorResponse(400, "Missing clientId");
        if (params.confirm !== true) return errorResponse(400, "removeClient requires confirm: true");
        result = await removeClient(params.clientId);
        console.warn(`ADMIN ACTION: removeClient ${params.clientId} — ${result.appointmentsDeleted} appointments deleted`);
        break;
      case "shareClientHistory":
        if (!params.clientId) return errorResponse(400, "Missing clientId");
        result = await shareClientHistory(params.clientId);
        break;
      case "addAdminNote":
        if (!params.appointmentId || params.adminNotes === undefined)
          return errorResponse(400, "Missing appointmentId or adminNotes");
        result = await addAdminNote(params.appointmentId, params.adminNotes);
        break;
      case "clearTestData":
        if (params.confirm !== true) return errorResponse(400, "clearTestData requires confirm: true");
        result = await clearTestData();
        console.warn("ADMIN ACTION: clearTestData executed");
        break;
      case "getDailySchedule":
        if (!params.date) return errorResponse(400, "Missing date parameter");
        result = await getDailySchedule(params.date);
        break;
      case "adminBookAppointment":
        if (!params.clientId || !params.date || params.startTime === undefined || params.endTime === undefined || !params.totalDuration)
          return errorResponse(400, "Missing required parameters: clientId, date, startTime, endTime, totalDuration");
        result = await adminBookAppointment(
          params.clientId,
          params.date,
          params.startTime,
          params.endTime,
          params.totalDuration,
          params.serviceIds || [],
          params.notes || "",
          params.adminNotes || ""
        );
        break;
      default:
        return errorResponse(400, `Unknown action: ${action}`);
    }

    return successResponse(result);
  } catch (error) {
    console.error("Admin API error:", error);
    return errorResponse(500, error.message || "Internal server error");
  }
};
