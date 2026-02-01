const express = require("express");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

// -------- ENV --------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

// Minimal scope: create/read events (adjust later)
const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// -------- OAuth Client --------
function getOAuthClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error(
      "Missing env vars. Need GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI"
    );
  }

  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

// -------- Health check (Railway needs this) --------
app.get("/", (req, res) => {
  res.status(200).send("Jalendr calendar bridge is running ✅");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// -------- Start OAuth --------
// Visit: /oauth/google/start
app.get("/oauth/google/start", (req, res) => {
  const oauth2Client = getOAuthClient();

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  return res.redirect(url);
});

// -------- OAuth Callback --------
// This MUST match your Google Console redirect URI exactly.
app.get("/oauth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing ?code in callback");

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // For now: just show tokens so we know it worked.
    // Later we’ll store them (DB) and use them to create events.
    return res
      .status(200)
      .send(
        "Google OAuth connected ✅\n\nTokens:\n" + JSON.stringify(tokens, null, 2)
      );
  } catch (err) {
    console.error(err);
    return res.status(500).send("OAuth callback failed: " + err.message);
  }
});

// ✅ NOTHING BELOW THIS EXCEPT app.listen
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
app.get("/test/create-event", async (req, res) => {
  try {
    const oauth2Client = getOAuthClient();

    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const event = {
      summary: "Jalendr Test Booking",
      description: "Test event created by Jalendr",
      start: {
        dateTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        timeZone: "America/Chicago",
      },
      end: {
        dateTime: new Date(Date.now() + 35 * 60 * 1000).toISOString(),
        timeZone: "America/Chicago",
      },
    };

    const result = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
    });

    res.send(`Event created: ${result.data.htmlLink}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to create event");
  }
});

app.post("/book-appointment", async (req, res) => {
  try {
    const { name, phone, address, jobType, startTimeISO } = req.body;

    if (!name || !phone || !startTimeISO) {
      return res.status(400).send("Missing required fields");
    }

 app.post("/book-appointment", async (req, res) => {
  try {
    const { name, phone, address, jobType, startTimeISO } = req.body;

    if (!name || !phone || !startTimeISO) {
      return res.status(400).send("Missing required fields");
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const startTime = new Date(startTimeISO);
    const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);

    const event = {
      summary: `Roofing Job – ${name}`,
      description: `
Name: ${name}
Phone: ${phone}
Address: ${address || "N/A"}
Job Type: ${jobType || "N/A"}
      `,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: "America/Chicago",
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: "America/Chicago",
      },
    };

    const result = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
    });

    res.json({
      success: true,
      eventLink: result.data.htmlLink,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to book appointment");
  }
});

