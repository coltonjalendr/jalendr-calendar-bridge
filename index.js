const express = require("express");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

// Health check (Railway needs this)
app.get("/", (req, res) => {
  res.status(200).send("Jalendr calendar bridge is running ✅");
});

// Example future endpoint (leave for later)
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// --- Google Calendar OAuth ---
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Keep scope minimal for now (events only)
const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// 1) Start OAuth
app.get("/oauth/google/start", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  return res.redirect(url);
});

// 2) OAuth callback (THIS MUST MATCH YOUR GOOGLE REDIRECT URI PATH)
app.get("/oauth/google/cal", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing ?code");

    const { tokens } = await oauth2Client.getToken(code);
    return res.json({ ok: true, tokens });
  } catch (err) {
    console.error(err);
    return res.status(500).send("OAuth error");
  }
});
const { google } = require("googleapis");

// ---- Google OAuth setup ----
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

// This is just a temporary in-memory store (fine for now).
// Later we’ll store per-user tokens in a DB.
let tokens = null;

function getOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

// 1) Start OAuth
app.get("/oauth/google/start", (req, res) => {
  const oauth2Client = getOAuthClient();

  const scopes = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
  ];

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
  });

  res.redirect(url);
});

// 2) OAuth callback (Google sends ?code=...)
app.get("/oauth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing ?code");

    const oauth2Client = getOAuthClient();
    const { tokens: newTokens } = await oauth2Client.getToken(code);

    tokens = newTokens;

    res.status(200).send("Google connected ✅ You can close this tab.");
  } catch (err) {
    console.error(err);
    res.status(500).send("OAuth callback failed");
  }
});

// 3) Test endpoint: list next 5 upcoming events
app.get("/calendar/upcoming", async (req, res) => {
  try {
    if (!tokens) return res.status(401).send("Not connected. Hit /oauth/google/start first.");

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(tokens);

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const resp = await calendar.events.list({
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      maxResults: 5,
      singleEvents: true,
      orderBy: "startTime",
    });

    res.json(resp.data.items || []);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to fetch events");
  }
});


// ⬇️ NOTHING BELOW THIS EXCEPT app.listen
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
