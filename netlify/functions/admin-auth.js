/**
 * Netlify Function: Admin Authentication
 *
 * SECURITY NOTES (read before changing):
 *   - No credentials live in this file. Everything comes from environment
 *     variables set in the Netlify dashboard.
 *   - The password is never stored anywhere, only a salted scrypt hash of it.
 *   - Tokens are HMAC-SHA256 signed and expire. A token cannot be forged
 *     without ADMIN_TOKEN_SECRET.
 *   - If any required env var is missing we FAIL CLOSED (500). There is
 *     deliberately no default/fallback secret — that was the old bug.
 *
 * Required environment variables:
 *   ADMIN_USERNAME       e.g. "Dovegal"
 *   ADMIN_PASSWORD_HASH  "<saltHex>:<hashHex>"  (generate with tools/generate-password-hash.js)
 *   ADMIN_TOKEN_SECRET   long random string (e.g. 48+ chars)
 *   ALLOWED_ORIGIN       e.g. "https://mimisstudio1.com"
 */

const crypto = require("crypto");

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;

// How long an admin session lasts before re-login is required.
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// scrypt parameters — must match tools/generate-password-hash.js
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://mimisstudio1.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Constant-time string compare that never throws on length mismatch.
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) {
    // Still burn a comparison so timing doesn't leak length.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify a plaintext password against "<saltHex>:<hashHex>".
 */
function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(":");
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== SCRYPT_KEYLEN) return false;

  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Create a signed, expiring token: base64url(payload) + "." + base64url(hmac)
 */
function signToken(username) {
  const payload = JSON.stringify({
    u: username,
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS,
  });
  const p = base64url(payload);
  const sig = base64url(
    crypto.createHmac("sha256", TOKEN_SECRET).update(p).digest()
  );
  return `${p}.${sig}`;
}

exports.handler = async (event) => {
  const headers = getCorsHeaders();

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Fail closed if the server isn't configured. Never fall back to a default.
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD_HASH || !TOKEN_SECRET) {
    console.error(
      "admin-auth is not configured. Missing one of: ADMIN_USERNAME, ADMIN_PASSWORD_HASH, ADMIN_TOKEN_SECRET"
    );
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Admin login is not configured. Contact the site owner." }),
    };
  }

  try {
    const { username, password } = JSON.parse(event.body || "{}");

    if (!username || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing username or password" }) };
    }

    const userOk = safeEqual(username, ADMIN_USERNAME);
    // Always run the password check so a wrong username and a wrong password
    // take the same amount of time (no username enumeration).
    let passOk = false;
    try {
      passOk = verifyPassword(password, ADMIN_PASSWORD_HASH);
    } catch (e) {
      passOk = false;
    }

    if (userOk && passOk) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ token: signToken(ADMIN_USERNAME), expiresIn: TOKEN_TTL_MS }),
      };
    }

    console.warn("Failed admin login attempt");
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Invalid credentials" }) };
  } catch (error) {
    console.error("Auth error:", error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Internal server error" }) };
  }
};
