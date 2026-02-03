const express = require("express");
const { google } = require("googleapis");
const twilio = require("twilio");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// -------- ENV --------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

// Twilio
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Calendar scopes: events + read access for availability
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

// -------- SMS Helper --------
async function sendConfirmationSMS(phone, name, startTime) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.log("Twilio not configured, skipping SMS");
    return null;
  }

  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  // Format the date nicely
  const options = {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  };
  const formattedDate = startTime.toLocaleString("en-US", options);

  const message = await client.messages.create({
    body: `Hi ${name}! Your appointment with Colton's Roofing is confirmed for ${formattedDate}. We'll see you then!`,
    from: TWILIO_PHONE_NUMBER,
    to: phone,
  });

  console.log("SMS sent:", message.sid);
  return message.sid;
}

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

// -------- Test Create Event --------
app.get("/test/create-event", async (req, res) => {
  try {
    const oauth2Client = getOAuthClient();

    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // Use current time + 1 hour for test event
    const testStartTime = new Date(Date.now() + 60 * 60 * 1000);
    const testEndTime = new Date(testStartTime.getTime() + 30 * 60 * 1000);

    const event = {
      summary: "Jalendr Test Booking",
      description: "Test event created by Jalendr",
      start: {
        dateTime: testStartTime.toISOString(),
        timeZone: "America/Chicago",
      },
      end: {
        dateTime: testEndTime.toISOString(),
        timeZone: "America/Chicago",
      },
    };

    // Debug: log which Google account this is creating events for
    const tokenResponse = await oauth2Client.getAccessToken();
    const accessToken =
      (typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token) ||
      oauth2Client.credentials.access_token;

    if (accessToken) {
      const tokenInfo = await oauth2Client.getTokenInfo(accessToken);
      console.log("GOOGLE CALENDAR USER:", tokenInfo.email);
    } else {
      console.log("NO ACCESS TOKEN AVAILABLE (refresh token may be invalid)");
    }

    const result = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
    });

    res.send(`Event created: ${result.data.htmlLink}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to create event: " + err.message);
  }
});

// -------- Check Availability --------
app.post("/check-availability", async (req, res) => {
  try {
    const { date } = req.body; // ISO date string like "2026-02-05"

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // Default to tomorrow if no date provided
    const targetDate = date ? new Date(date) : new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Set business hours: 8am - 5pm Central
    const dayStart = new Date(targetDate);
    dayStart.setHours(8, 0, 0, 0);

    const dayEnd = new Date(targetDate);
    dayEnd.setHours(17, 0, 0, 0);

    // Get busy times from calendar
    const freeBusyResponse = await calendar.freebusy.query({
      requestBody: {
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        timeZone: "America/Chicago",
        items: [{ id: "primary" }],
      },
    });

    const busySlots = freeBusyResponse.data.calendars.primary.busy || [];

    // Generate available 1-hour slots
    const availableSlots = [];
    const slotDuration = 60 * 60 * 1000; // 1 hour in ms

    for (let time = dayStart.getTime(); time + slotDuration <= dayEnd.getTime(); time += slotDuration) {
      const slotStart = new Date(time);
      const slotEnd = new Date(time + slotDuration);

      // Check if this slot overlaps with any busy time
      const isAvailable = !busySlots.some((busy) => {
        const busyStart = new Date(busy.start);
        const busyEnd = new Date(busy.end);
        return slotStart < busyEnd && slotEnd > busyStart;
      });

      if (isAvailable) {
        availableSlots.push({
          start: slotStart.toISOString(),
          startFormatted: slotStart.toLocaleString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/Chicago",
          }),
        });
      }
    }

    res.json({
      success: true,
      date: targetDate.toISOString().split("T")[0],
      availableSlots,
      message: availableSlots.length > 0
        ? `Found ${availableSlots.length} available slots`
        : "No availability on this date",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "error",
      message: "Failed to check availability",
      error: err?.message || String(err),
    });
  }
});

// -------- Book Appointment --------
app.post("/book-appointment", async (req, res) => {
  try {
    const { name, phone, address, jobType, startTimeISO } = req.body;

    if (!name || !phone || !startTimeISO) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: name, phone, startTimeISO",
      });
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

    // Send SMS confirmation
    let smsSid = null;
    try {
      smsSid = await sendConfirmationSMS(phone, name, startTime);
    } catch (smsErr) {
      console.error("SMS failed (booking still succeeded):", smsErr.message);
    }

    res.json({
      success: true,
      eventLink: result.data.htmlLink,
      smsSent: !!smsSid,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "error",
      message: "Failed to book appointment",
      error: err?.message || String(err),
    });
  }
});

// -------- Start Server --------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

