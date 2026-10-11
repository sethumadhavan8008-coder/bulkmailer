
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

const isProduction = process.env.NODE_ENV === "production";

const FRONTEND_URL = (
  process.env.FRONTEND_URL || "http://localhost:5173"
).replace(/\/+$/, "");

const BACKEND_URL = (
  process.env.BACKEND_URL || "http://localhost:" + PORT
).replace(/\/+$/, "");

const CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL ||
  BACKEND_URL + "/auth/google/callback";


const REQUIRED_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MONGODB_URI",
  "SESSION_SECRET",
];

const missingEnv = REQUIRED_ENV.filter(
  (name) => !process.env[name]
);

if (missingEnv.length > 0) {
  console.error(
    "Missing environment variables:",
    missingEnv.join(", ")
  );
}

if (
  isProduction &&
  (!process.env.FRONTEND_URL ||
    !process.env.BACKEND_URL ||
    !process.env.GOOGLE_CALLBACK_URL)
) {
  console.error(
    "Production requires FRONTEND_URL, BACKEND_URL, and GOOGLE_CALLBACK_URL."
  );
}

if (isProduction && !process.env.SESSION_SECRET) {
  console.error(
    "SESSION_SECRET must be configured in production."
  );
}

// Render runs behind a proxy. This allows Express to recognize HTTPS.
app.set("trust proxy", 1);

// Frontend origins allowed to call this backend.
const allowedOrigins = [
  FRONTEND_URL,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
].filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests without an Origin header, such as health checks.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error("Origin is not allowed by CORS.")
      );
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "1mb" }));

// Google permissions requested from each visitor.
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.send",
];

// MongoDB connection and session store.
let mongoReady = false;

if (process.env.MONGODB_URI) {
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => {
      mongoReady = true;
      console.log("MongoDB connected successfully");
    })
    .catch((error) => {
      console.error(
        "MongoDB connection failed:",
        error.message
      );
    });
}

// Use MongoDB to preserve sessions across requests and server restarts.
const sessionOptions = {
  name: "bulkmail.sid",
  secret:
    process.env.SESSION_SECRET ||
    "development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
};

if (process.env.MONGODB_URI) {
  sessionOptions.store = MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: "bulkmail_sessions",
    ttl: 7 * 24 * 60 * 60,
    autoRemove: "native",
  });
}

app.use(session(sessionOptions));

// Create an OAuth client.
function createOAuthClient(tokens = {}) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    CALLBACK_URL
  );

  client.setCredentials(tokens);

  return client;
}

// Save a session before sending a response or redirect.
function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) {
        return reject(error);
      }

      resolve();
    });
  });
}

// Regenerate the session after successful authentication.
function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        return reject(error);
      }

      resolve();
    });
  });
}

// Check whether the visitor has connected Gmail.
function requireGoogleAccount(req, res, next) {
  if (!req.session.googleTokens) {
    return res.status(401).json({
      success: false,
      message: "Connect your Gmail account first.",
    });
  }

  next();
}

// Basic email validation.
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Create a Gmail API-compatible MIME message.
function makeRawEmail({ from, to, subject, text }) {
  const cleanSubject = subject.replace(/[\r\n]+/g, " ");

  const encodedSubject = /^[\x20-\x7E]*$/.test(cleanSubject)
    ? cleanSubject
    : `=?UTF-8?B?${Buffer.from(cleanSubject, "utf8").toString(
        "base64"
      )}?=`;

  const encodedBody = Buffer.from(text, "utf8").toString(
    "base64"
  );

  const mimeMessage = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody,
  ].join("\r\n");

  return Buffer.from(mimeMessage, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// Health check.
app.get("/", (req, res) => {
  res.status(200).send(
    "BulkMail Gmail API backend is running."
  );
});

// Check backend and database status.
app.get("/api/health", (req, res) => {
  res.status(mongoReady ? 200 : 503).json({
    success: mongoReady,
    server: "running",
    database: mongoReady ? "connected" : "not connected",
  });
});

// Start Google OAuth authorization.
app.get("/auth/google", async (req, res) => {
  try {
    if (
      !process.env.GOOGLE_CLIENT_ID ||
      !process.env.GOOGLE_CLIENT_SECRET ||
      !process.env.SESSION_SECRET ||
      !process.env.MONGODB_URI
    ) {
      return res.status(500).send(
        "Google OAuth or session configuration is missing. Check the backend environment variables."
      );
    }

    const state = crypto.randomBytes(32).toString("hex");

    req.session.oauthState = state;

    const oauthClient = createOAuthClient();

    const authUrl = oauthClient.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      include_granted_scopes: true,
      state,
    });

    // Ensure the state is saved before redirecting to Google.
    await saveSession(req);

    console.log(
      "OAuth started. Session ID:",
      req.sessionID
    );

    return res.redirect(authUrl);
  } catch (error) {
    console.error(
      "Could not start OAuth:",
      error.message
    );

    return res.status(500).send(
      "Could not start Google authorization. Check the backend logs and MongoDB connection."
    );
  }
});

// Google redirects the visitor to this callback after authorization.
app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    console.log(
      "OAuth callback received. Session ID:",
      req.sessionID,
      "State stored:",
      Boolean(req.session.oauthState)
    );

    if (error) {
      console.error("Google OAuth error:", error);

      return res.redirect(
        `${FRONTEND_URL}/?oauthError=${encodeURIComponent(
          String(error)
        )}`
      );
    }

    // Validate the state to prevent cross-site request forgery.
    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      typeof req.session.oauthState !== "string" ||
      !crypto.timingSafeEqual(
        Buffer.from(state),
        Buffer.from(req.session.oauthState)
      )
    ) {
      return res.status(400).send(
        "Invalid OAuth state or session. Return to BulkMail and connect Google again. Check that the frontend and Google callback use the same Render backend URL."
      );
    }

    // Remove the one-time state value.
    delete req.session.oauthState;
    await saveSession(req);

    const oauthClient = createOAuthClient();
    console.log("OAuth credential diagnostic:", {
  clientIdPresent: Boolean(process.env.GOOGLE_CLIENT_ID),
  clientIdSuffix: process.env.GOOGLE_CLIENT_ID?.slice(-25),
  secretPresent: Boolean(process.env.GOOGLE_CLIENT_SECRET),
  secretLength: process.env.GOOGLE_CLIENT_SECRET?.length,
  callbackUrl: CALLBACK_URL,
});
    const { tokens } = await oauthClient.getToken(code);

    if (!tokens.access_token) {
      throw new Error(
        "Google did not return an access token."
      );
    }

    // Get the connected user's email.
    oauthClient.setCredentials(tokens);

    const oauth2 = google.oauth2({
      version: "v2",
      auth: oauthClient,
    });

    const profile = await oauth2.userinfo.get();

    if (!profile.data.email) {
      throw new Error(
        "Could not identify the Google account."
      );
    }

    // Regenerate the session after authentication to reduce session-fixation risk.
    await regenerateSession(req);

    req.session.googleTokens = {
      ...tokens,
      email: profile.data.email,
    };

    await saveSession(req);

    console.log(
      "Google OAuth completed successfully for:",
      profile.data.email
    );

    return res.redirect(
      `${FRONTEND_URL}/?connected=1`
    );
  } catch (error) {
    console.error(
      "OAuth callback failed:",
      error.message
    );

    return res.redirect(
      `${FRONTEND_URL}/?oauthError=authorization_failed`
    );
  }
});

// Return the connected Gmail account for the current browser session.
app.get("/api/me", async (req, res) => {
  try {
    if (!req.session.googleTokens) {
      return res.json({
        connected: false,
        email: null,
      });
    }

    const auth = createOAuthClient(
      req.session.googleTokens
    );

    const oauth2 = google.oauth2({
      version: "v2",
      auth,
    });

    const response = await oauth2.userinfo.get();

    // Store refreshed credentials when Google refreshes a token.
    req.session.googleTokens = {
      ...req.session.googleTokens,
      ...auth.credentials,
      email: response.data.email,
    };

    await saveSession(req);

    return res.json({
      connected: true,
      email: response.data.email,
    });
  } catch (error) {
    console.error(
      "Google account check failed:",
      error.message
    );

    return res.status(401).json({
      connected: false,
      message:
        "Could not verify your Gmail connection. Please reconnect Google.",
    });
  }
});

// Send a separate email to each recipient.
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
        emailList.some(
          (email) => typeof email !== "string"
        )
      ) {
        return res.status(400).json({
          success: false,
          message: "The recipient list contains an invalid value.",
        });
      }

      const recipients = [
        ...new Set(
          emailList
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean)
        ),
      ];

      if (recipients.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Add at least one valid recipient.",
        });
      }

      const invalid = recipients.filter(
        (email) => !isValidEmail(email)
      );

      if (invalid.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid email address: ${invalid[0]}`,
        });
      }

      const maxRecipients = Math.max(
        1,
        Number(
          process.env.MAX_RECIPIENTS_PER_REQUEST || 25
        )
      );

      if (recipients.length > maxRecipients) {
        return res.status(400).json({
          success: false,
          message: `Limit: ${maxRecipients} unique recipients per request.`,
        });
      }

      const auth = createOAuthClient(
        req.session.googleTokens
      );

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
          message:
            "Could not identify the connected Gmail account. Reconnect Google.",
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
            message:
              "Gmail could not send this message. Check the address, Gmail limits, and account permissions.",
          });
        }
      }

      // Save any refreshed Google credentials.
      req.session.googleTokens = {
        ...req.session.googleTokens,
        ...auth.credentials,
        email: senderEmail,
      };

      await saveSession(req);

      if (failures.length > 0) {
        return res.status(207).json({
          success: sent > 0,
          sent,
          failed: failures.length,
          failures,
          message: `Sent ${sent}; failed ${failures.length}.`,
        });
      }

      return res.json({
        success: true,
        sent,
        message: `Email sent successfully to ${sent} recipient(s).`,
      });
    } catch (error) {
      console.error(
        "Send email error:",
        error.message
      );

      if (
        error.code === 401 ||
        error.code === 403 ||
        error.response?.status === 401 ||
        error.response?.status === 403
      ) {
        return res.status(401).json({
          success: false,
          message:
            "Gmail authorization failed or permission is missing. Reconnect Google and try again.",
        });
      }

      return res.status(500).json({
        success: false,
        message:
          "Could not send email. Check the backend logs for details.",
      });
    }
  }
);

// Disconnect Gmail from the current browser session.
app.post("/auth/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error(
        "Session logout failed:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message: "Could not disconnect Gmail.",
      });
    }

    res.clearCookie("bulkmail.sid", {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      path: "/",
    });

    return res.json({
      success: true,
      message: "Gmail disconnected successfully.",
    });
  });
});

// Handle unexpected errors.
app.use((error, req, res, next) => {
  console.error("Backend error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    success: false,
    message: "An unexpected server error occurred.",
  });
});

app.listen(PORT, () => {
  console.log(`BulkMail backend listening on port ${PORT}`);
  console.log(`Environment: ${isProduction ? "production" : "development"}`);
  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log(`OAuth callback URL: ${CALLBACK_URL}`);
});
