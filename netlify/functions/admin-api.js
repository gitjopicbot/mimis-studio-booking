/**
 * Netlify Function: Admin API
 * Handles admin operations for the Mimi's Studio admin panel
 * Requires Bearer token authentication
 *
 * Actions:
 *   getAppointments, updateAppointment, deleteAppointment, blockTime,
 *   getClients, searchClients, getClientDetail, getClientAppointments,
 *   updateClient, mergeClients, addAdminNote, clearTestData, getDailySchedule
 */

const { createClient } = require("@supabase/supabase-js");

const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || "mimi-studio-secret-key";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
  const { data: clients, error } = await supabase.from("clients").select("*");
  if (error) throw new Error(`Failed to fetch clients: ${error.message}`);

  // Fetch phones, emails, and appointment counts in parallel
  const enriched = await Promise.all(
    clients.map(async (client) => {
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
    // Insert new phones (up to 4)
    const phonesToInsert = updates.phones.slice(0, 4).map((p, i) => ({
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

  // Enforce limits: keep max 4 phones and 5 emails on target
  const { data: finalPhones } = await supabase
    .from("client_phones")
    .select("*")
    .eq("client_id", targetClientId)
    .order("created_at");
  if (finalPhones && finalPhones.length > 4) {
    const toDelete = finalPhones.slice(4).map(p => p.id);
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
      default:
        return errorResponse(400, `Unknown action: ${action}`);
    }

    return successResponse(result);
  } catch (error) {
    console.error("Admin API error:", error);
    return errorResponse(500, error.message || "Internal server error");
  }
};
