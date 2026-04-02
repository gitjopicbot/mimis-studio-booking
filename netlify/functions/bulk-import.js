/**
 * Netlify Function: Bulk Import Clients
 * One-time use function to import client directory from ApptGo
 * Requires admin authentication
 */

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

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
    if (parts.length < 3) return false;
    const ts = parseInt(parts[2]);
    if (Date.now() - ts > 24 * 60 * 60 * 1000) return false;
    return true;
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Validate admin token
  if (!validateToken(event.headers.authorization || event.headers.Authorization)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  try {
    const { clients, clearExisting } = JSON.parse(event.body);

    if (!Array.isArray(clients)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "clients must be an array" }) };
    }

    // Optionally clear existing clients first
    if (clearExisting) {
      await supabase.from("client_emails").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("client_phones").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("clients").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    }

    let imported = 0;
    let failed = 0;
    const errors = [];

    for (const client of clients) {
      try {
        const clientId = crypto.randomUUID();
        const primaryEmail = client.emails && client.emails.length > 0 ? client.emails[0] : null;
        const primaryPhone = client.phones && client.phones.length > 0 ? client.phones[0] : null;

        // Insert client record
        const { error: clientError } = await supabase.from("clients").insert({
          id: clientId,
          first_name: client.first_name || "",
          last_name: client.last_name || null,
          email: primaryEmail,
          phone: primaryPhone,
          remind_email: true,
          remind_sms: true,
          remind_browser: false,
          notes: "",
        });

        if (clientError) {
          failed++;
          errors.push(`Client ${client.first_name} ${client.last_name}: ${clientError.message}`);
          continue;
        }

        // Insert phone numbers
        if (client.phones) {
          for (let i = 0; i < Math.min(client.phones.length, 5); i++) {
            const label = i === 0 ? "primary" : `phone${i + 1}`;
            await supabase.from("client_phones").insert({
              id: crypto.randomUUID(),
              client_id: clientId,
              phone: client.phones[i],
              label: label,
            });
          }
        }

        // Insert email addresses
        if (client.emails) {
          for (let i = 0; i < Math.min(client.emails.length, 5); i++) {
            const label = i === 0 ? "primary" : `email${i + 1}`;
            await supabase.from("client_emails").insert({
              id: crypto.randomUUID(),
              client_id: clientId,
              email: client.emails[i],
              label: label,
            });
          }
        }

        imported++;
      } catch (err) {
        failed++;
        errors.push(`Client ${client.first_name}: ${err.message}`);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        imported,
        failed,
        total: clients.length,
        errors: errors.slice(0, 20), // First 20 errors only
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
