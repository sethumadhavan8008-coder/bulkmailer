# BulkMail — Gmail OAuth 2.0 + Gmail API

This is a starter project for a React/Vite frontend and Node/Express backend. Each visitor connects their own Google account through OAuth, and the backend sends individual emails through that account's Gmail API permission.

## Project structure

- `backend/` — Express API, Google OAuth callback, Gmail API sending, MongoDB-backed sessions
- `frontend/` — React/Vite UI, Excel/CSV recipient import

## Requirements

- Node.js 20+
- MongoDB Atlas connection string (used for session storage)
- Google Cloud project with Gmail API enabled
- OAuth 2.0 Client ID of type **Web application**

## 1. Configure Google Cloud

1. Open https://console.cloud.google.com/ and create/select a project.
2. Enable **Gmail API**: https://console.cloud.google.com/apis/library/gmail.googleapis.com
3. Configure Google Auth Platform / OAuth consent screen. Choose **External** if people outside your Workspace organization will use it.
4. During testing, add each tester under **Audience / Test users**. In Testing status, Google may expire grants after seven days. Public use of Gmail sending scope may require OAuth verification; do not assume the app is production-approved until Google says so.
5. Create OAuth Client ID → **Web application**.
6. For local development, add this Authorized redirect URI:
   `http://localhost:5000/auth/google/callback`
7. For production, add the exact callback URL from Render:
   `https://YOUR-RENDER-SERVICE.onrender.com/auth/google/callback`
8. Copy the Client ID and Client Secret. Never commit the secret to GitHub.

Scope used:
`https://www.googleapis.com/auth/gmail.send`

This is a sensitive Gmail scope. Explain clearly to users why the app requests it, follow Google's user-data policy, and request only scopes you need.

## 2. Configure MongoDB Atlas

Create a database/user and allow network access from your hosting environment according to Atlas guidance. Copy the connection string. Don't commit it.

## 3. Run locally

### Backend
```bash
cd backend
npm install
copy .env.example .env
```
On Windows, open `.env` and set:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL=http://localhost:5000/auth/google/callback`
- `BACKEND_URL=http://localhost:5000`
- `FRONTEND_URL=http://localhost:5173`
- `MONGODB_URI`
- `SESSION_SECRET` (use a long random string)

Then:
```bash
npm run dev
```

### Frontend
Open another terminal:
```bash
cd frontend
npm install
copy .env.example .env
```
Set `VITE_API_URL=http://localhost:5000`, then:
```bash
npm run dev
```
Open http://localhost:5173.

## 4. Deploy backend to Render

Create a Web Service from your GitHub repository. Set Root Directory to `backend`, Build Command `npm install`, Start Command `npm start`. Configure these environment variables in Render:
- `NODE_ENV=production`
- `FRONTEND_URL=https://YOUR-VERCEL-DOMAIN`
- `BACKEND_URL=https://YOUR-RENDER-SERVICE.onrender.com`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL=https://YOUR-RENDER-SERVICE.onrender.com/auth/google/callback`
- `MONGODB_URI`
- `SESSION_SECRET` (long random value)
- optional `MAX_RECIPIENTS_PER_REQUEST=25`

Add the exact production callback URL to the OAuth client in Google Cloud. The Render free service can sleep when idle; first request may take a little time.

## 5. Deploy frontend to Vercel

Import the `frontend` folder as the project (or set Vercel Root Directory to `frontend`). Add:
- `VITE_API_URL=https://YOUR-RENDER-SERVICE.onrender.com`

Deploy/redeploy. Put the exact Vercel production domain in Render `FRONTEND_URL`. The backend CORS allowlist must match the exact frontend origin. If you use a preview URL, update `FRONTEND_URL` or add it to the allowlist in `backend/index.js`.

## How it works

- Click **Connect Gmail** → Google OAuth consent → backend callback.
- The backend stores OAuth tokens in a server-side session stored in MongoDB.
- The frontend checks `/api/me`.
- Send requests go to `/api/sendemail`; messages are sent one at a time through Gmail API.
- Recipients are sent individually, so other recipients do not see each other's email addresses.

## Important limits and security

- Gmail quotas and Google policies apply. This project is not intended for unsolicited bulk email. Send only to people who expect the message and comply with anti-spam laws.
- Google OAuth apps using Gmail scopes can require verification. Testing mode is limited to configured test users; grants can expire.
- Protect OAuth client secret, MongoDB URI, session secret, and user tokens. Never put them in frontend variables or source control.
- For a production service, add abuse prevention/rate limits, unsubscribe handling where applicable, clear privacy disclosures, a deletion/revocation flow, and monitored error handling.
- The code caps each send request at 25 unique recipients by default; adjust carefully while respecting Gmail's actual quota.
- Disconnect destroys this browser session. Users can also revoke access in their Google Account security settings.
- The included session store uses MongoDB when `MONGODB_URI` is set. Keep MongoDB configured for deployed use; the in-memory fallback is not suitable for multi-instance production.

## Troubleshooting

- `redirect_uri_mismatch`: the callback URL in Google Cloud must exactly match `GOOGLE_CALLBACK_URL`.
- `Access blocked` / unverified app: add your account as a test user while testing; production use may require OAuth verification.
- CORS errors: ensure `FRONTEND_URL` exactly matches the deployed Vercel origin including `https://`, with no trailing slash.
- Login loops / session not retained: use HTTPS in production and ensure `NODE_ENV=production`, `trust proxy` enabled, and MongoDB reachable.
- `invalid_grant`: reconnect the Google account.
- Gmail API 403: check Gmail API is enabled, consent includes `gmail.send`, the account has not revoked access, and quotas/policies.
