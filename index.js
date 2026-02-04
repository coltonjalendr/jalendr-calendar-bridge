const express = require("express");
const { google } = require("googleapis");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");

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

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL || "", SUPABASE_KEY || "");

// Calendar scopes: events + read access for availability
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

// -------- Get Client from Database --------
async function getClient(clientId) {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .single();

  if (error) throw new Error(`Client not found: ${error.message}`);
  return data;
}

// -------- SMS Helper --------
async function sendConfirmationSMS(phone, name, startTime, client) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.log("Twilio not configured, skipping SMS");
    return null;
  }

  const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  // Format the date nicely using client's timezone
  const options = {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: client.timezone || "America/Chicago",
  };
  const formattedDate = startTime.toLocaleString("en-US", options);

  const message = await twilioClient.messages.create({
    body: `Hi ${name}! Your appointment with ${client.company_name} is confirmed for ${formattedDate}. We'll see you then!`,
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

// -------- Health check --------
app.get("/", (req, res) => {
  res.status(200).send("Jalendr calendar bridge is running ✅");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// -------- Start OAuth for a Client --------
// Visit: /oauth/google/start?client_id=xxx
app.get("/oauth/google/start", (req, res) => {
  const clientId = req.query.client_id;
  if (!clientId) {
    return res.status(400).send("Missing client_id parameter");
  }

  const oauth2Client = getOAuthClient();

  // Pass client_id through state parameter
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state: clientId,
  });

  return res.redirect(url);
});

// -------- OAuth Callback --------
app.get("/oauth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const clientId = req.query.state;

    if (!code) return res.status(400).send("Missing ?code in callback");
    if (!clientId) return res.status(400).send("Missing client_id in state");

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    // Store the refresh token in the database for this client
    const { error } = await supabase
      .from("clients")
      .update({ google_refresh_token: tokens.refresh_token })
      .eq("id", clientId);

    if (error) {
      console.error("Failed to save token:", error);
      return res.status(500).send("Failed to save token: " + error.message);
    }

    return res.status(200).send(
      `Google Calendar connected ✅\n\nClient ${clientId} is now set up!`
    );
  } catch (err) {
    console.error(err);
    return res.status(500).send("OAuth callback failed: " + err.message);
  }
});

// -------- Check Availability --------
app.post("/check-availability", async (req, res) => {
  try {
    const { client_id, date } = req.body;

    if (!client_id) {
      return res.status(400).json({
        status: "error",
        message: "Missing client_id",
      });
    }

    // Get client from database
    const client = await getClient(client_id);

    if (!client.google_refresh_token) {
      return res.status(400).json({
        status: "error",
        message: "Client has not connected their Google Calendar",
      });
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      refresh_token: client.google_refresh_token,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // Default to tomorrow if no date provided
    const targetDate = date
      ? new Date(date + "T00:00:00")
      : new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Parse client's business hours
    const [startHour] = (client.hours_start || "08:00").split(":").map(Number);
    const [endHour] = (client.hours_end || "17:00").split(":").map(Number);

    // Calculate timezone offset (simplified - assumes US timezones)
    const tzOffsets = {
      "America/New_York": 5,
      "America/Chicago": 6,
      "America/Denver": 7,
      "America/Los_Angeles": 8,
    };
    const offset = tzOffsets[client.timezone] || 6;

    const dayStart = new Date(targetDate);
    dayStart.setUTCHours(startHour + offset, 0, 0, 0);

    const dayEnd = new Date(targetDate);
    dayEnd.setUTCHours(endHour + offset, 0, 0, 0);

    // Get busy times from calendar
    const freeBusyResponse = await calendar.freebusy.query({
      requestBody: {
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        timeZone: client.timezone || "America/Chicago",
        items: [{ id: "primary" }],
      },
    });

    const busySlots = freeBusyResponse.data.calendars.primary.busy || [];

    // Generate available slots based on client's appointment duration
    const availableSlots = [];
    const slotDuration = (client.appointment_duration_minutes || 60) * 60 * 1000;

    for (let time = dayStart.getTime(); time + slotDuration <= dayEnd.getTime(); time += slotDuration) {
      const slotStart = new Date(time);
      const slotEnd = new Date(time + slotDuration);

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
            timeZone: client.timezone || "America/Chicago",
          }),
        });
      }
    }

    res.json({
      success: true,
      date: targetDate.toISOString().split("T")[0],
      availableSlots,
      message:
        availableSlots.length > 0
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
    const { client_id, name, phone, address, jobType, startTimeISO } = req.body;

    if (!client_id) {
      return res.status(400).json({
        status: "error",
        message: "Missing client_id",
      });
    }

    if (!name || !phone || !startTimeISO) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: name, phone, startTimeISO",
      });
    }

    // Get client from database
    const client = await getClient(client_id);

    if (!client.google_refresh_token) {
      return res.status(400).json({
        status: "error",
        message: "Client has not connected their Google Calendar",
      });
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      refresh_token: client.google_refresh_token,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const startTime = new Date(startTimeISO);
    const duration = (client.appointment_duration_minutes || 60) * 60 * 1000;
    const endTime = new Date(startTime.getTime() + duration);

    const event = {
      summary: `${jobType || "Service"} – ${name}`,
      description: `
Name: ${name}
Phone: ${phone}
Address: ${address || "N/A"}
Job Type: ${jobType || "N/A"}
Booked via Jalendr
      `,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: client.timezone || "America/Chicago",
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: client.timezone || "America/Chicago",
      },
    };

    const result = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
    });

    // Send SMS confirmation
    let smsSid = null;
    try {
      smsSid = await sendConfirmationSMS(phone, name, startTime, client);
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

// -------- Get Customer Appointments --------
app.post("/get-appointments", async (req, res) => {
  try {
    const { client_id, phone } = req.body;

    if (!client_id || !phone) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: client_id, phone",
      });
    }

    const client = await getClient(client_id);

    if (!client.google_refresh_token) {
      return res.status(400).json({
        status: "error",
        message: "Client has not connected their Google Calendar",
      });
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      refresh_token: client.google_refresh_token,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // Search for events in the next 30 days that contain this phone number
    const now = new Date();
    const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: thirtyDaysLater.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      q: phone, // Search by phone number in event description
    });

    const appointments = (response.data.items || []).map((event) => ({
      eventId: event.id,
      summary: event.summary,
      start: event.start.dateTime,
      startFormatted: new Date(event.start.dateTime).toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: client.timezone || "America/Chicago",
      }),
      description: event.description,
    }));

    res.json({
      success: true,
      appointments,
      message: appointments.length > 0
        ? `Found ${appointments.length} upcoming appointment(s)`
        : "No upcoming appointments found for this phone number",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "error",
      message: "Failed to get appointments",
      error: err?.message || String(err),
    });
  }
});

// -------- Cancel Appointment --------
app.post("/cancel-appointment", async (req, res) => {
  try {
    const { client_id, eventId } = req.body;

    if (!client_id || !eventId) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: client_id, eventId",
      });
    }

    const client = await getClient(client_id);

    if (!client.google_refresh_token) {
      return res.status(400).json({
        status: "error",
        message: "Client has not connected their Google Calendar",
      });
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      refresh_token: client.google_refresh_token,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    await calendar.events.delete({
      calendarId: "primary",
      eventId: eventId,
    });

    res.json({
      success: true,
      message: "Appointment cancelled successfully",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "error",
      message: "Failed to cancel appointment",
      error: err?.message || String(err),
    });
  }
});

// -------- Reschedule Appointment --------
app.post("/reschedule-appointment", async (req, res) => {
  try {
    const { client_id, eventId, newStartTimeISO } = req.body;

    if (!client_id || !eventId || !newStartTimeISO) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: client_id, eventId, newStartTimeISO",
      });
    }

    const client = await getClient(client_id);

    if (!client.google_refresh_token) {
      return res.status(400).json({
        status: "error",
        message: "Client has not connected their Google Calendar",
      });
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      refresh_token: client.google_refresh_token,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // Get the existing event
    const existingEvent = await calendar.events.get({
      calendarId: "primary",
      eventId: eventId,
    });

    // Calculate new end time based on client's appointment duration
    const newStartTime = new Date(newStartTimeISO);
    const duration = (client.appointment_duration_minutes || 60) * 60 * 1000;
    const newEndTime = new Date(newStartTime.getTime() + duration);

    // Update the event with new times
    const updatedEvent = await calendar.events.update({
      calendarId: "primary",
      eventId: eventId,
      resource: {
        ...existingEvent.data,
        start: {
          dateTime: newStartTime.toISOString(),
          timeZone: client.timezone || "America/Chicago",
        },
        end: {
          dateTime: newEndTime.toISOString(),
          timeZone: client.timezone || "America/Chicago",
        },
      },
    });

    res.json({
      success: true,
      message: "Appointment rescheduled successfully",
      newTime: newStartTime.toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: client.timezone || "America/Chicago",
      }),
      eventLink: updatedEvent.data.htmlLink,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "error",
      message: "Failed to reschedule appointment",
      error: err?.message || String(err),
    });
  }
});

// -------- Save Lead --------
app.post("/save-lead", async (req, res) => {
  try {
    const { client_id, name, phone, address, job_type, notes } = req.body;

    if (!client_id) {
      return res.status(400).json({
        status: "error",
        message: "Missing required field: client_id",
      });
    }

    // Save lead to database
    const { data, error } = await supabase
      .from("leads")
      .insert({
        client_id,
        name: name || null,
        phone: phone || null,
        address: address || null,
        job_type: job_type || null,
        notes: notes || null,
        status: "new",
      })
      .select()
      .single();

    if (error) throw error;

    console.log("Lead saved:", data.id);

    res.json({
      success: true,
      leadId: data.id,
      message: "Lead saved successfully",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "error",
      message: "Failed to save lead",
      error: err?.message || String(err),
    });
  }
});

// -------- Get Leads (Admin) --------
app.get("/admin/leads", async (req, res) => {
  try {
    const { client_id } = req.query;

    let query = supabase
      .from("leads")
      .select("*, clients(company_name)")
      .order("created_at", { ascending: false });

    if (client_id) {
      query = query.eq("client_id", client_id);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({ success: true, leads: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "error",
      message: "Failed to get leads",
      error: err?.message || String(err),
    });
  }
});

// -------- List Clients (Admin) --------
app.get("/admin/clients", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("clients")
      .select("id, company_name, owner_name, email, phone_number, timezone, created_at");

    if (error) throw error;

    res.json({ success: true, clients: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "error",
      message: "Failed to list clients",
      error: err?.message || String(err),
    });
  }
});

// -------- Create Client (Admin) --------
app.post("/admin/clients", async (req, res) => {
  try {
    const {
      company_name,
      owner_name,
      email,
      phone_number,
      timezone,
      hours_start,
      hours_end,
      appointment_duration_minutes,
      job_types,
      greeting_name,
    } = req.body;

    if (!company_name) {
      return res.status(400).json({
        status: "error",
        message: "Missing required field: company_name",
      });
    }

    const { data, error } = await supabase
      .from("clients")
      .insert({
        company_name,
        owner_name,
        email,
        phone_number,
        timezone: timezone || "America/Chicago",
        hours_start: hours_start || "08:00",
        hours_end: hours_end || "17:00",
        appointment_duration_minutes: appointment_duration_minutes || 60,
        job_types: job_types || ["General Service"],
        greeting_name: greeting_name || "Jalendr",
      })
      .select()
      .single();

    if (error) throw error;

    // Generate the OAuth URL for this client
    const oauthUrl = `${process.env.BASE_URL || "https://industrious-clarity-production.up.railway.app"}/oauth/google/start?client_id=${data.id}`;

    res.json({
      success: true,
      client: data,
      oauthUrl,
      message: `Client created! Send them this link to connect their Google Calendar: ${oauthUrl}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "error",
      message: "Failed to create client",
      error: err?.message || String(err),
    });
  }
});

// -------- Start Server --------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
