/**
 * Netlify Function: Admin API
 * Handles admin operations for the Mimi's Studio admin panel
 * Requires Bearer token authentication
 *
 * Expected POST body:
 * {
 *   "action": "getAppointments|updateAppointment|deleteAppointment|blockTime|getClients|addAdminNote|clearTestData|getDailySchedule",
 *   ...action_specific_params
 * }
 *
 * Authentication:
 * Header: Authorization: Bearer <token>
 */

const { createClient } = require("@supabase/supabase-js");

const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || "mimi-studio-secret-key";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function validateToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }

  const token = authHeader.substring(7);

  try {
    // Validate token format (base64 decode and check structure)
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const parts = decoded.split(":");

    if (parts.length !== 3) {
      return false;
    }

    // Verify the secret is in the token
    if (parts[2] !== TOKEN_SECRET) {
      return false;
    }

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
  return {
    statusCode,
    headers: getCorsHeaders(),
    body: JSON.stringify({ error: message }),
  };
}

function successResponse(data) {
  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify(data),
  };
}

// ACTION: Get all appointments with client and service details
async function getAppointments() {
  const { data: appointments, error: appointmentsError } = await supabase
    .from("appointments")
    .select(
      `
      *,
      clients (
        id,
        first_name,
        last_name,
        email,
        phone
      ),
      appointment_services (
        id,
        services (
          id,
          name,
          duration
        )
      )
    `
    )
    .order("appointment_date", { ascending: false })
    .order("start_time", { ascending: false });

  if (appointmentsError) {
    throw new Error(`Failed to fetch appointments: ${appointmentsError.message}`);
  }

  return appointments;
}

// ACTION: Update appointment
async function updateAppointment(appointmentId, updates) {
  const allowedFields = [
    "status",
    "appointment_date",
    "start_time",
    "end_time",
    "notes",
    "admin_notes",
  ];

  const updateData = {};
  for (const field of allowedFields) {
    if (field in updates) {
      updateData[field] = updates[field];
    }
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error("No valid fields to update");
  }

  const { data, error } = await supabase
    .from("appointments")
    .update(updateData)
    .eq("id", appointmentId)
    .select();

  if (error) {
    throw new Error(`Failed to update appointment: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error("Appointment not found");
  }

  return data[0];
}

// ACTION: Delete appointment
async function deleteAppointment(appointmentId) {
  // Delete related appointment_services records first
  const { error: servicesError } = await supabase
    .from("appointment_services")
    .delete()
    .eq("appointment_id", appointmentId);

  if (servicesError) {
    throw new Error(
      `Failed to delete appointment services: ${servicesError.message}`
    );
  }

  // Delete the appointment
  const { data, error: appointmentError } = await supabase
    .from("appointments")
    .delete()
    .eq("id", appointmentId)
    .select();

  if (appointmentError) {
    throw new Error(`Failed to delete appointment: ${appointmentError.message}`);
  }

  return { deleted: true, appointmentId };
}

// ACTION: Block time on the calendar
async function blockTime(date, startTime, endTime, reason) {
  const { data, error } = await supabase
    .from("appointments")
    .insert([
      {
        client_id: null,
        appointment_date: date,
        start_time: startTime,
        end_time: endTime,
        status: "blocked",
        notes: reason,
        created_at: new Date().toISOString(),
      },
    ])
    .select();

  if (error) {
    throw new Error(`Failed to create time block: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error("Failed to create time block");
  }

  return data[0];
}

// ACTION: Get all clients with appointment counts
async function getClients() {
  const { data: clients, error } = await supabase
    .from("clients")
    .select("*");

  if (error) {
    throw new Error(`Failed to fetch clients: ${error.message}`);
  }

  // Fetch appointment counts for each client
  const clientsWithCounts = await Promise.all(
    clients.map(async (client) => {
      const { count, error: countError } = await supabase
        .from("appointments")
        .select("*", { count: "exact", head: true })
        .eq("client_id", client.id);

      if (countError) {
        console.error(`Error counting appointments for client ${client.id}:`, countError);
        return { ...client, appointment_count: 0 };
      }

      return { ...client, appointment_count: count || 0 };
    })
  );

  return clientsWithCounts;
}

// ACTION: Add admin note to appointment
async function addAdminNote(appointmentId, adminNotes) {
  const { data, error } = await supabase
    .from("appointments")
    .update({ admin_notes: adminNotes })
    .eq("id", appointmentId)
    .select();

  if (error) {
    throw new Error(`Failed to add admin note: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error("Appointment not found");
  }

  return data[0];
}

// ACTION: Clear all test data (DANGEROUS - for testing only)
async function clearTestData() {
  const { error: servicesError } = await supabase
    .from("appointment_services")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000"); // Delete all

  if (servicesError) {
    throw new Error(
      `Failed to delete appointment_services: ${servicesError.message}`
    );
  }

  const { error: appointmentsError } = await supabase
    .from("appointments")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000"); // Delete all

  if (appointmentsError) {
    throw new Error(`Failed to delete appointments: ${appointmentsError.message}`);
  }

  const { error: clientsError } = await supabase
    .from("clients")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000"); // Delete all

  if (clientsError) {
    throw new Error(`Failed to delete clients: ${clientsError.message}`);
  }

  return { cleared: true };
}

// ACTION: Get daily schedule for a specific date
async function getDailySchedule(date) {
  const { data: appointments, error } = await supabase
    .from("appointments")
    .select(
      `
      *,
      clients (
        id,
        first_name,
        last_name,
        email,
        phone
      ),
      appointment_services (
        id,
        services (
          id,
          name,
          duration
        )
      )
    `
    )
    .eq("appointment_date", date)
    .order("start_time", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch daily schedule: ${error.message}`);
  }

  return appointments;
}

// Main handler
exports.handler = async (event) => {
  const headers = getCorsHeaders();

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers,
      body: "",
    };
  }

  // Only accept POST requests
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  // Validate authentication
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!validateToken(authHeader)) {
    return errorResponse(401, "Unauthorized");
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { action, ...params } = body;

    if (!action) {
      return errorResponse(400, "Missing action parameter");
    }

    let result;

    switch (action) {
      case "getAppointments":
        result = await getAppointments();
        break;

      case "updateAppointment":
        if (!params.appointmentId || !params.updates) {
          return errorResponse(400, "Missing appointmentId or updates");
        }
        result = await updateAppointment(params.appointmentId, params.updates);
        break;

      case "deleteAppointment":
        if (!params.appointmentId) {
          return errorResponse(400, "Missing appointmentId");
        }
        result = await deleteAppointment(params.appointmentId);
        break;

      case "blockTime":
        if (!params.date || !params.startTime || !params.endTime || !params.reason) {
          return errorResponse(
            400,
            "Missing date, startTime, endTime, or reason"
          );
        }
        result = await blockTime(params.date, params.startTime, params.endTime, params.reason);
        break;

      case "getClients":
        result = await getClients();
        break;

      case "addAdminNote":
        if (!params.appointmentId || params.adminNotes === undefined) {
          return errorResponse(400, "Missing appointmentId or adminNotes");
        }
        result = await addAdminNote(params.appointmentId, params.adminNotes);
        break;

      case "clearTestData":
        // Add extra protection: require explicit confirmation
        if (params.confirm !== true) {
          return errorResponse(400, "clearTestData requires confirm: true");
        }
        result = await clearTestData();
        console.warn("ADMIN ACTION: clearTestData executed");
        break;

      case "getDailySchedule":
        if (!params.date) {
          return errorResponse(400, "Missing date parameter");
        }
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
