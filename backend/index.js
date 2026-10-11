
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

// --------------------------------------------------
// ENVIRONMENT CONFIGURATION
// --------------------------------------------------

const FRONTEND_URL = (
  process.env.FRONTEND_URL || "http://localhost:5173"
).replace(/\/+$/, "");

const BACKEND_URL = (
  process.env.BACKEND_URL || `http://localhost:${PORT}`
).replace(/\/+$/, "");

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
  (name) => !process.env[name]?.trim()
);

if (missingEnv.length) {
  console.error(
    "Missing environment variables:",
    missingEnv.join(", ")
  );
}

if (isProduction && missingEnv.length) {
  console.error(
    "Configure the missing environment variables in Render."
  );
}

if (isProduction && !process.env.FRONTEND_URL) {
  console.error("FRONTEND_URL is required in production.");
}

if (isProduction && !process.env.BACKEND_URL) {
  console.error("BACKEND_URL is required in production.");
}

if (
  isProduction &&
  !process.env.GOOGLE_CALLBACK_URL
) {
  console.error(
    "GOOGLE_CALLBACK_URL is required in production."
  );
}

// --------------------------------------------------
// EXPRESS CONFIGURATION
// --------------------------------------------------

app.set("trust proxy", 1);

const allowedOrigins = [
  FRONTEND_URL,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

app.use(
  cors({
    origin(origin, callback) {
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

// --------------------------------------------------
// GOOGLE OAUTH CONFIGURATION
// --------------------------------------------------

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.send",
];

function createOAuthClient(tokens = {}) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Google OAuth Client ID or Client Secret is missing."
    );
  }

  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    CALLBACK_URL
  );
}

// Safe diagnostics: never log secrets, tokens, or authorization codes.
function logOAuthError(error) {
  const googleData = error.response?.data;

  console.error("OAuth error details:", {
    message: error.message,
    status: error.response?.status,
    googleError: googleData?.error,
    googleDescription: googleData?.error_description,
    code: error.code,
  });
}

// --------------------------------------------------
// MONGODB AND SESSION CONFIGURATION
// --------------------------------------------------

let mongoReady = false;

mongoose.connection.on("connected", () => {
  mongoReady = true;
  console.log("MongoDB connected successfully");
});

mongoose.connection.on("disconnected", () => {
  mongoReady = false;
  console.error("MongoDB disconnected");
});

mongoose.connection.on("error", (error) => {
  console.error("MongoDB error:", error.message);
});

if (process.env.MONGODB_URI) {
  mongoose
    .connect(process.env.MONGODB_URI)
    .catch((error) => {
      console.error(
        "MongoDB connection failed:",
        error.message
      );
    });
}

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
    path: "/",
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

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) return reject(error);
      resolve();
    });
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      resolve();
    });
  });
}

// --------------------------------------------------
// HELPER FUNCTIONS
// --------------------------------------------------

function requireGoogleAccount(req, res, next) {
  if (!req.session.googleTokens) {
    return res.status(401).json({
      success: false,
      message: "Connect your Gmail account first.",
    });
  }

  next();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function makeRawEmail({ from, to, subject, text }) {
  const cleanSubject = subject.replace(/[\r\n]+/g, " ");

  const encodedSubject = /^[\x20-\x7E]*$/.test(
    cleanSubject
  )
    ? cleanSubject
    : `=?UTF-8?B?${Buffer.from(
        cleanSubject,
        "utf8"
      ).toString("base64")}?=`;

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

// --------------------------------------------------
// HEALTH CHECKS
// --------------------------------------------------

app.get("/", (req, res) => {
  res.status(200).send(
    "BulkMail Gmail API backend is running."
  );
});

app.get("/api/health", (req, res) => {
  res.status(mongoReady ? 200 : 503).json({
    success: mongoReady,
    server: "running",
    database: mongoReady ? "connected" : "not connected",
  });
});

// --------------------------------------------------
// START GOOGLE OAUTH
// --------------------------------------------------

app.get("/auth/google", async (req, res) => {
  try {
    if (
      !process.env.GOOGLE_CLIENT_ID ||
      !process.env.GOOGLE_CLIENT_SECRET ||
      !process.env.SESSION_SECRET ||
      !process.env.MONGODB_URI
    ) {
      return res.status(500).send(
        "OAuth configuration is incomplete. Check Render environment variables."
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

    await saveSession(req);

    console.log("OAuth started. Session ID:", req.sessionID);

    return res.redirect(authUrl);
  } catch (error) {
    console.error(
      "Could not start OAuth:",
      error.message
    );

    return res.status(500).send(
      "Could not start Google authorization. Check the backend logs."
    );
  }
});

// --------------------------------------------------
// GOOGLE OAUTH CALLBACK
// --------------------------------------------------

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
      console.error("Google OAuth authorization error:", error);

      return res.redirect(
        `${FRONTEND_URL}/?oauthError=${encodeURIComponent(
          String(error)
        )}`
      );
    }

    const storedState = req.session.oauthState;

    // Validate the state and check buffer lengths before comparing.
    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      typeof storedState !== "string"
    ) {
      return res.status(400).send(
        "Invalid OAuth state or session. Please reconnect Google."
      );
    }

    const suppliedStateBuffer = Buffer.from(state);
    const storedStateBuffer = Buffer.from(storedState);

    if (
      suppliedStateBuffer.length !== storedStateBuffer.length ||
      !crypto.timingSafeEqual(
        suppliedStateBuffer,
        storedStateBuffer
      )
    ) {
      return res.status(400).send(
        "OAuth state validation failed. Please reconnect Google."
      );
    }

    delete req.session.oauthState;
    await saveSession(req);

    // Exchange the authorization code for Google tokens.
    const oauthClient = createOAuthClient();

    let tokens;

    try {
      const tokenResponse = await oauthClient.getToken(code);
      tokens = tokenResponse.tokens;
    } catch (error) {
      console.error("OAuth token exchange failed.");
      logOAuthError(error);
      throw error;
    }

    if (!tokens.access_token) {
      throw new Error(
        "Google did not return an access token."
      );
    }

    oauthClient.setCredentials(tokens);

    // Retrieve the Google account's profile.
    const oauth2 = google.oauth2({
      version: "v2",
      auth: oauthClient,
    });

    const profileResponse = await oauth2.userinfo.get();
    const email = profileResponse.data.email;

    if (!email) {
      throw new Error(
        "Could not identify the Google account."
      );
    }

    // Regenerate the session after successful authentication.
    await regenerateSession(req);

    req.session.googleTokens = {
      ...tokens,
      email,
    };

    await saveSession(req);

    console.log(
      "Google OAuth completed successfully for:",
      email
    );

    return res.redirect(
      `${FRONTEND_URL}/?connected=1`
    );
  } catch (error) {
    // Do not log authorization codes, tokens, or client secrets.
    console.error("OAuth callback failed:", error.message);

    return res.redirect(
      `${FRONTEND_URL}/?oauthError=authorization_failed`
    );
  }
});

// --------------------------------------------------
// CHECK CONNECTED GMAIL ACCOUNT
// --------------------------------------------------

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

    const profileResponse = await oauth2.userinfo.get();
    const email = profileResponse.data.email;

    if (!email) {
      return res.json({
        connected: false,
        email: null,
      });
    }

    req.session.googleTokens = {
      ...req.session.googleTokens,
      ...auth.credentials,
      email,
    };

    await saveSession(req);

    return res.json({
      connected: true,
      email,
    });
  } catch (error) {
    console.error(
      "Google account check failed:",
      error.message
    );

    return res.status(401).json({
      connected: false,
      email: null,
      message:
        "Could not verify Gmail. Please reconnect Google.",
    });
  }
});

// --------------------------------------------------
// SEND EMAILS THROUGH GMAIL API
// --------------------------------------------------

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
          message: "Invalid recipient list.",
        });
      }

      const recipients = [
        ...new Set(
          emailList
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean)
        ),
      ];

      if (!recipients.length) {
        return res.status(400).json({
          success: false,
          message: "Add at least one valid recipient.",
        });
      }

      const invalidEmail = recipients.find(
        (email) => !isValidEmail(email)
      );

      if (invalidEmail) {
        return res.status(400).json({
          success: false,
          message: `Invalid email address: ${invalidEmail}`,
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
          message: `Limit: ${maxRecipients} recipients per request.`,
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

      const profileResponse = await oauth2.userinfo.get();
      const senderEmail = profileResponse.data.email;

      if (!senderEmail) {
        return res.status(401).json({
          success: false,
          message: "Reconnect your Gmail account.",
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

          sent++;
        } catch (error) {
          console.error(
            "Gmail send failed:",
            error.response?.data?.error?.message ||
              error.message
          );

          failures.push({
            recipient,
            message:
              "Gmail could not send this message. Check the address, account permissions, and sending limits.",
          });
        }
      }

      // Persist refreshed credentials if Google refreshed them.
      req.session.googleTokens = {
        ...req.session.googleTokens,
        ...auth.credentials,
        email: senderEmail,
      };

      await saveSession(req);

      if (failures.length) {
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
            "Gmail authorization failed. Reconnect Google and try again.",
        });
      }

      return res.status(500).json({
        success: false,
        message:
          "Could not send email. Check the backend logs.",
      });
    }
  }
);

// --------------------------------------------------
// DISCONNECT GMAIL
// --------------------------------------------------

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

// --------------------------------------------------
// GENERAL ERROR HANDLER
// --------------------------------------------------

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

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `BulkMail backend listening on port ${PORT}`
  );

  console.log(
    `Environment: ${isProduction ? "production" : "development"}`
  );

  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log(`OAuth callback URL: ${CALLBACK_URL}`);

  // Safe credential diagnostics; values are not printed.
  console.log(
    "Google Client ID configured:",
    Boolean(process.env.GOOGLE_CLIENT_ID)
  );

  console.log(
    "Google Client Secret configured:",
    Boolean(process.env.GOOGLE_CLIENT_SECRET)
  );
});
