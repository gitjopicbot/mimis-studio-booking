/**
 * Netlify Function: Admin Authentication
 * Handles login for the Mimi's Studio admin panel
 *
 * Expected POST body:
 * {
 *   "username": "string",
 *   "password": "string"
 * }
 *
 * Success (200):
 * {
 *   "token": "base64_encoded_token"
 * }
 *
 * Failure (401):
 * {
 *   "error": "Invalid credentials"
 * }
 */

const ADMIN_USERNAME = "Dovegal";
const ADMIN_PASSWORD = "Paige&Joe9295";
const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || "mimi-studio-secret-key";

function generateToken(username) {
  // Simple token generation: base64(username + timestamp + secret)
  const timestamp = Date.now();
  const data = `${username}:${timestamp}:${TOKEN_SECRET}`;
  return Buffer.from(data).toString("base64");
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

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
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { username, password } = body;

    // Validate input
    if (!username || !password) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing username or password",
        }),
      };
    }

    // Validate credentials
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      const token = generateToken(username);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ token }),
      };
    }

    // Invalid credentials
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: "Invalid credentials" }),
    };
  } catch (error) {
    console.error("Auth error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Internal server error",
      }),
    };
  }
};
