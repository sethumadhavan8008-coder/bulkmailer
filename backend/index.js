require("dotenv").config();

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 5000;

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL ||
  `${BACKEND_URL}/auth/google/callback`;

const REQUIRED_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MONGODB_URI",
  "SESSION_SECRET"
];

const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length) {
  console.warn("Missing environment variables:", missingEnv.join(", "));
}

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  CALLBACK_URL
);

const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

app.set("trust proxy", 1);

app.use(cors({
  origin: [
    FRONTEND_URL,
    "http://localhost:5173",
    "http://localhost:3000"
  ],
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json({ limit: "1mb" }));

if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("MongoDB connected"))
    .catch((err) => console.error("MongoDB connection failed:", err.message));
}

const sessionOptions = {
  name: "bulkmail.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
};

if (process.env.MONGODB_URI) {
  sessionOptions.store = MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: "bulkmail_sessions",
    ttl: 7 * 24 * 60 * 60
  });
}
app.use(session(sessionOptions));

function createOAuthClient(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    CALLBACK_URL
  );
  client.setCredentials(tokens);
  return client;
}

function requireGoogleAccount(req, res, next) {
  if (!req.session.googleTokens) {
    return res.status(401).json({
      success: false,
      message: "Connect your Gmail account first."
    });
  }
  next();
}

function makeRawEmail({ from, to, subject, text }) {
  // Encode UTF-8 content, then base64url encode the full RFC 2822 message.
  const safeSubject = String(subject)
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\x20-\x7E]/g, (ch) =>
      "=?UTF-8?B?" + Buffer.from(ch, "utf8").toString("base64") + "?="
    );

  const bodyBase64 = Buffer.from(String(text), "utf8").toString("base64");
  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${safeSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    bodyBase64
  ].join("\r\n");

  return Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

app.get("/", (req, res) => {
  res.status(200).send("BulkMail Gmail API backend is running.");
});

app.get("/api/me", async (req, res) => {
  try {
    if (!req.session.googleTokens) {
      return res.json({ connected: false });
    }

    const auth = createOAuthClient(req.session.googleTokens);
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });

    // Save refreshed access token if the library refreshed it.
    req.session.googleTokens = auth.credentials;
    return res.json({
      connected: true,
      email: profile.data.emailAddress
    });
  } catch (error) {
    console.error("Gmail profile error:", error.message);
    req.session.googleTokens = null;
    return res.status(401).json({
      connected: false,
      message: "Gmail connection expired. Please connect again."
    });
  }
});

app.get("/auth/google", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send("Google OAuth credentials are not configured.");
  }

  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    include_granted_scopes: true,
    state
  });

  req.session.save((err) => {
    if (err) {
      console.error("Session save failed:", err.message);
      return res.status(500).send("Could not start Google authorization.");
    }
    res.redirect(authUrl);
  });
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`${FRONTEND_URL}/?oauthError=${encodeURIComponent(String(error))}`);
    }

    if (!code || !state || !req.session.oauthState || state !== req.session.oauthState) {
      return res.status(400).send("Invalid OAuth state. Please return to BulkMail and connect again.");
    }

    delete req.session.oauthState;
    const { tokens } = await oauth2Client.getToken(String(code));
    req.session.googleTokens = tokens;

    req.session.save((err) => {
      if (err) {
        console.error("Could not save OAuth session:", err.message);
        return res.status(500).send("Could not save Gmail connection.");
      }
      res.redirect(`${FRONTEND_URL}/?connected=1`);
    });
  } catch (error) {
    console.error("OAuth callback failed:", error.message);
    res.redirect(`${FRONTEND_URL}/?oauthError=authorization_failed`);
  }
});

app.post("/api/sendemail", requireGoogleAccount, async (req, res) => {
  try {
    const { subject, message, emailList } = req.body;

    if (typeof subject !== "string" || !subject.trim()) {
      return res.status(400).json({ success: false, message: "Subject is required." });
    }
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ success: false, message: "Email message is required." });
    }
    if (!Array.isArray(emailList) || emailList.length === 0) {
      return res.status(400).json({ success: false, message: "Add at least one recipient." });
    }

    const validEmails = emailList
      .filter((email) => typeof email === "string")
      .map((email) => email.trim().toLowerCase());

    const invalid = validEmails.filter((email) =>
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    );
    if (invalid.length) {
      return res.status(400).json({
        success: false,
        message: `Invalid email address(es): ${invalid.slice(0, 5).join(", ")}`
      });
    }

    const recipients = [...new Set(validEmails)];
    const maxRecipients = Math.max(1, Number(process.env.MAX_RECIPIENTS_PER_REQUEST || 25));
    if (recipients.length > maxRecipients) {
      return res.status(400).json({
        success: false,
        message: `This request is limited to ${maxRecipients} unique recipients. Split the list into smaller batches.`
      });
    }

    const auth = createOAuthClient(req.session.googleTokens);
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    let sent = 0;
    const failures = [];

    // Send separately so recipients do not see each other's email addresses.
    for (const recipient of recipients) {
      try {
        const raw = makeRawEmail({
          from: profile.data.emailAddress,
          to: recipient,
          subject: subject.trim(),
          text: message.trim()
        });

        await gmail.users.messages.send({
          userId: "me",
          requestBody: { raw }
        });
        sent += 1;
      } catch (err) {
        console.error(`Send failed for ${recipient}:`, err.message);
        failures.push({ recipient, message: "Gmail API rejected this message." });
      }
    }

    req.session.googleTokens = auth.credentials;

    if (failures.length) {
      return res.status(207).json({
        success: sent > 0,
        sent,
        failed: failures.length,
        failures,
        message: `Sent ${sent}; failed ${failures.length}. Check the recipient addresses and Gmail limits.`
      });
    }

    return res.json({
      success: true,
      sent,
      message: `Email sent successfully to ${sent} recipient(s).`
    });
  } catch (error) {
    console.error("Send email error:", error.message);
    if (error.code === 401 || error.code === 403) {
      return res.status(401).json({
        success: false,
        message: "Gmail authorization may have expired or lacks permission. Connect Gmail again."
      });
    }
    return res.status(500).json({
      success: false,
      message: "Could not send email. Check backend logs and Gmail API configuration."
    });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, message: "Could not disconnect Gmail." });
    }
    res.clearCookie("bulkmail.sid", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax"
    });
    res.json({ success: true });
  });
});

app.listen(PORT, () => {
  console.log(`BulkMail backend listening on port ${PORT}`);
});
