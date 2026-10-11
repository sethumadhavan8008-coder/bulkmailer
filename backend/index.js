// backend/index.js

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

const FRONTEND_URL =
  process.env.FRONTEND_URL || "http://localhost:5173";

const BACKEND_URL =
  process.env.BACKEND_URL || `http://localhost:${PORT}`;

const CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL ||
  `${BACKEND_URL}/auth/google/callback`;

const REQUIRED_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MONGODB_URI",
  "SESSION_SECRET",
];

const missingEnv = REQUIRED_ENV.filter(
  (name) => !process.env[name]
);

if (missingEnv.length) {
  console.error(
    "Missing environment variables:",
    missingEnv.join(", ")
  );
}

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.send",
];

app.set("trust proxy", 1);

app.use(
  cors({
    origin: [
      FRONTEND_URL,
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "1mb" }));

// Connect MongoDB and use it to store sessions.
if (process.env.MONGODB_URI) {
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => console.log("MongoDB connected successfully"))
    .catch((error) =>
      console.error("MongoDB connection failed:", error.message)
    );
}

const sessionOptions = {
  name: "bulkmail.sid",
  secret:
    process.env.SESSION_SECRET ||
    "development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite:
      process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
};

if (process.env.MONGODB_URI) {
  sessionOptions.store = MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: "bulkmail_sessions",
    ttl: 7 * 24 * 60 * 60,
  });
}

app.use(session(sessionOptions));

// Create an OAuth client for the configured Google application.
function createOAuthClient(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    CALLBACK_URL
  );

  client.setCredentials(tokens);
  return client;
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) return reject(error);
      resolve();
    });
  });
}

function requireGoogleAccount(req, res, next) {
  if (!req.session.googleTokens) {
    return res.status(401).json({
      success: false,
      message: "Connect your Gmail account first.",
    });
  }

  next();
}

// Validate basic email address format.
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Encode the email subject and body safely for Gmail's API.
function makeRawEmail({ from, to, subject, text }) {
  const safeSubject = /^[\x20-\x7E]*$/.test(subject)
    ? subject.replace(/[\r\n]+/g, " ")
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString(
        "base64"
      )}?=`;

  const bodyBase64 = Buffer.from(text, "utf8").toString("base64");

  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${safeSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    bodyBase64,
  ].join("\r\n");

  return Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// Health check.
app.get("/", (req, res) => {
  res.status(200).send("BulkMail Gmail API backend is running.");
});

// Start Google OAuth.
app.get("/auth/google", (req, res) => {
  if (
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET
  ) {
    return res
      .status(500)
      .send("Google OAuth credentials are not configured.");
  }

  const state = crypto.randomBytes(32).toString("hex");
  req.session.oauthState = state;

  const oauthClient = createOAuthClient({});

  const authUrl = oauthClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    include_granted_scopes: true,
    state,
  });

  req.session.save((error) => {
    if (error) {
      console.error("OAuth session save failed:", error.message);
      return res.status(500).send(
        "Could not start Google authorization. Check MongoDB and session configuration."
      );
    }

    res.redirect(authUrl);
  });
});

// Google redirects the browser to this route after authorization.
app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      console.error("Google OAuth returned an error:", error);

      return res.redirect(
        `${FRONTEND_URL}/?oauthError=${encodeURIComponent(
          String(error)
        )}`
      );
    }

    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      !req.session.oauthState ||
      state !== req.session.oauthState
    ) {
      return res
        .status(400)
        .send(
          "Invalid OAuth state or session. Return to BulkMail and connect Google again."
        );
    }

    delete req.session.oauthState;

    const oauthClient = createOAuthClient({});
    const { tokens } = await oauthClient.getToken(code);

    if (!tokens.access_token) {
      throw new Error("Google did not return an access token.");
    }

    // Keep the refresh token from a previous authorization if Google
    // does not issue a new one.
    const previousTokens = req.session.googleTokens || {};

    req.session.googleTokens = {
      ...previousTokens,
      ...tokens,
      refresh_token:
        tokens.refresh_token || previousTokens.refresh_token,
    };

    await saveSession(req);

    console.log("Google OAuth completed; session saved.");

    return res.redirect(`${FRONTEND_URL}/?connected=1`);
  } catch (error) {
    console.error("OAuth callback failed:", error.message);

    return res.redirect(
      `${FRONTEND_URL}/?oauthError=authorization_failed`
    );
  }
});

// Check whether the current browser session has a connected Gmail account.
app.get("/api/me", async (req, res) => {
  try {
    if (!req.session.googleTokens) {
      return res.json({ connected: false });
    }

    const auth = createOAuthClient(req.session.googleTokens);

    const oauth2 = google.oauth2({
      version: "v2",
      auth,
    });

    const response = await oauth2.userinfo.get();

    // Persist credentials if Google refreshed the access token.
    req.session.googleTokens = {
      ...req.session.googleTokens,
      ...auth.credentials,
    };

    await saveSession(req);

    return res.json({
      connected: true,
      email: response.data.email,
    });
  } catch (error) {
    console.error("Google account check failed:", error.message);

    // Keep the session so the user can inspect the error and reconnect.
    return res.status(401).json({
      connected: false,
      message:
        "Could not verify the Gmail connection. Please reconnect Google.",
    });
  }
});

// Send one separate email per recipient.
app.post(
  "/api/sendemail",
  requireGoogleAccount,
  async (req, res) => {
    try {
      const { subject, message, emailList } = req.body;

      if (
        typeof subject !== "string" ||
        !subject.trim() ||
        subject.length > 250
      ) {
        return res.status(400).json({
          success: false,
          message: "Enter a subject of 1–250 characters.",
        });
      }

      if (
        typeof message !== "string" ||
        !message.trim()
      ) {
        return res.status(400).json({
          success: false,
          message: "Email message is required.",
        });
      }

      if (
        !Array.isArray(emailList) ||
        emailList.length === 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Add at least one recipient.",
        });
      }

      if (
        emailList.some((email) => typeof email !== "string")
      ) {
        return res.status(400).json({
          success: false,
          message: "The recipient list contains an invalid value.",
        });
      }

      const recipients = [
        ...new Set(
          emailList.map((email) => email.trim().toLowerCase())
        ),
      ];

      const invalid = recipients.filter(
        (email) => !isValidEmail(email)
      );

      if (invalid.length) {
        return res.status(400).json({
          success: false,
          message: `Invalid email address: ${invalid[0]}`,
        });
      }

      const maxRecipients = Math.max(
        1,
        Number(process.env.MAX_RECIPIENTS_PER_REQUEST || 25)
      );

      if (recipients.length > maxRecipients) {
        return res.status(400).json({
          success: false,
          message: `Limit: ${maxRecipients} unique recipients per request.`,
        });
      }

      const auth = createOAuthClient(req.session.googleTokens);
      const gmail = google.gmail({
        version: "v1",
        auth,
      });

      const oauth2 = google.oauth2({
        version: "v2",
        auth,
      });

      const profile = await oauth2.userinfo.get();
      const senderEmail = profile.data.email;

      if (!senderEmail) {
        return res.status(401).json({
          success: false,
          message: "Could not identify the connected Gmail account.",
        });
      }

      let sent = 0;
      const failures = [];

      for (const recipient of recipients) {
        try {
          const raw = makeRawEmail({
            from: senderEmail,
            to: recipient,
            subject: subject.trim(),
            text: message.trim(),
          });

          await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw },
          });

          sent += 1;
        } catch (error) {
          console.error(
            `Email failed for ${recipient}:`,
            error.message
          );

          failures.push({
            recipient,
            message: "Gmail could not send this message.",
          });
        }
      }

      req.session.googleTokens = {
        ...req.session.googleTokens,
        ...auth.credentials,
      };

      await saveSession(req);

      if (failures.length) {
        return res.status(207).json({
          success: sent > 0,
          sent,
          failed: failures.length,
          failures,
          message: `Sent ${sent}; failed ${failures.length}. Check Gmail limits and the failed recipient addresses.`,
        });
      }

      return res.json({
        success: true,
        sent,
        message: `Email sent successfully to ${sent} recipient(s).`,
      });
    } catch (error) {
      console.error("Send email error:", error.message);

      if (error.code === 401 || error.code === 403) {
        return res.status(401).json({
          success: false,
          message:
            "Gmail authorization failed or permission is missing. Reconnect Google and try again.",
        });
      }

      return res.status(500).json({
        success: false,
        message:
          "Could not send email. Check the backend terminal for details.",
      });
    }
  }
);

// Disconnect this browser session from Google.
app.post("/auth/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: "Could not disconnect Gmail.",
      });
    }

    res.clearCookie("bulkmail.sid", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite:
        process.env.NODE_ENV === "production" ? "none" : "lax",
    });

    return res.json({ success: true });
  });
});

app.listen(PORT, () => {
  console.log(`BulkMail backend listening on port ${PORT}`);
  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log(`OAuth callback URL: ${CALLBACK_URL}`);
});