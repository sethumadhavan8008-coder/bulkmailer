import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import * as XLSX from "xlsx";

const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:5000").replace(/\/$/, "");
const api = axios.create({
  baseURL: API_URL,
  withCredentials: true
});

function parseEmail(value) {
  return String(value || "")
    .split(/[,\n;\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export default function App() {
  const [connectedEmail, setConnectedEmail] = useState("");
  const [checking, setChecking] = useState(true);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [manualEmails, setManualEmails] = useState("");
  const [fileEmails, setFileEmails] = useState([]);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const recipients = useMemo(
    () => [...new Set([...parseEmail(manualEmails), ...fileEmails])],
    [manualEmails, fileEmails]
  );

  useEffect(() => {
    let mounted = true;
    api.get("/api/me")
      .then(({ data }) => {
        if (mounted && data.connected) setConnectedEmail(data.email || "Connected Gmail");
      })
      .catch(() => {})
      .finally(() => mounted && setChecking(false));

    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "1") {
      setNotice({ type: "success", text: "Gmail connected successfully." });
      window.history.replaceState({}, "", window.location.pathname);
      api.get("/api/me").then(({ data }) => {
        if (mounted && data.connected) setConnectedEmail(data.email || "Connected Gmail");
      }).catch(() => {});
    } else if (params.get("oauthError")) {
      setNotice({ type: "error", text: "Google authorization was cancelled or failed. Please try again." });
      window.history.replaceState({}, "", window.location.pathname);
    }
    return () => { mounted = false; };
  }, []);

  async function handleFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setNotice(null);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      const extracted = [];
      for (const row of rows) {
        for (const cell of row) {
          if (typeof cell === "string" || typeof cell === "number") {
            const value = String(cell).trim();
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
              extracted.push(value.toLowerCase());
            }
          }
        }
      }
      const unique = [...new Set(extracted)];
      setFileEmails(unique);
      setFileName(file.name);
      setNotice({
        type: unique.length ? "success" : "error",
        text: unique.length
          ? `Found ${unique.length} email address(es) in ${file.name}.`
          : "No email addresses found. Put one email address in each cell."
      });
    } catch {
      setNotice({ type: "error", text: "Could not read this file. Upload a valid .xlsx, .xls or .csv file." });
    }
  }

  async function sendEmails(event) {
    event.preventDefault();
    setNotice(null);

    if (!connectedEmail) {
      setNotice({ type: "error", text: "Connect your Gmail account before sending." });
      return;
    }
    if (!subject.trim() || !message.trim()) {
      setNotice({ type: "error", text: "Enter both a subject and an email message." });
      return;
    }
    if (!recipients.length) {
      setNotice({ type: "error", text: "Add recipient email addresses or upload an Excel file." });
      return;
    }
    const invalid = recipients.filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    if (invalid.length) {
      setNotice({ type: "error", text: `Invalid email address: ${invalid[0]}` });
      return;
    }

    setBusy(true);
    try {
      const { data } = await api.post("/api/sendemail", {
        subject: subject.trim(),
        message: message.trim(),
        emailList: recipients
      });
      setNotice({
        type: data.success ? "success" : "error",
        text: data.message || "Request completed."
      });
    } catch (error) {
      const text = error.response?.data?.message ||
        "Could not send emails. Check your connection and backend logs.";
      setNotice({ type: "error", text });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    try {
      await api.post("/auth/logout");
    } catch {}
    setConnectedEmail("");
    setNotice({ type: "success", text: "Gmail disconnected from this browser session." });
  }

  return (
    <main className="page">
      <header className="topbar">
        <a className="brand" href="/" aria-label="BulkMail home">
          <span className="brand-icon">B</span>
          <span>BulkMail</span>
        </a>
        <span className="top-label">Gmail API · Secure authorization</span>
      </header>

      <section className="hero">
        <div className="eyebrow"><span className="dot" /> SIMPLE EMAIL CAMPAIGNS</div>
        <h1>One message.<br /><span>Multiple inboxes.</span></h1>
        <p className="hero-copy">
          Connect your own Gmail account, add recipients, and send individual emails
          without exposing recipients' addresses to one another.
        </p>
      </section>

      <section className="mailer-card">
        <div className="card-head">
          <div>
            <p className="section-kicker">YOUR WORKSPACE</p>
            <h2>Compose email</h2>
          </div>
          <div className={`status-pill ${connectedEmail ? "connected" : ""}`}>
            <span className="status-dot" />
            {checking ? "Checking..." : connectedEmail ? "Gmail connected" : "Not connected"}
          </div>
        </div>

        <div className="account-row">
          <div className="google-mark">G</div>
          <div className="account-copy">
            <strong>{connectedEmail || "Connect your Gmail account"}</strong>
            <span>{connectedEmail ? "Emails will be sent from this account." : "Google will ask you to grant permission to send email."}</span>
          </div>
          {connectedEmail ? (
            <button className="button button-light" type="button" onClick={disconnect}>Disconnect</button>
          ) : (
            <a className="button button-dark" href={`${API_URL}/auth/google`}>
              Connect Gmail <span aria-hidden="true">↗</span>
            </a>
          )}
        </div>

        <form onSubmit={sendEmails}>
          <div className="field">
            <label htmlFor="subject">Email subject</label>
            <input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Project update" maxLength={250} />
          </div>

          <div className="field">
            <div className="label-row">
              <label htmlFor="recipients">Recipients</label>
              <span className="muted">One or more email IDs</span>
            </div>
            <textarea id="recipients" rows="3" value={manualEmails} onChange={(e) => setManualEmails(e.target.value)} placeholder="alex@example.com, sam@example.com&#10;You can separate addresses with commas or new lines." />
          </div>

          <div className="upload-box">
            <div className="upload-symbol">↑</div>
            <div className="upload-text">
              <strong>Import recipients from Excel or CSV</strong>
              <span>{fileName ? `${fileName} · ${fileEmails.length} email(s) found` : "Upload .xlsx, .xls or .csv — email addresses can be in any cell."}</span>
            </div>
            <label className="button button-light upload-button">
              Choose file
              <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} />
            </label>
          </div>

          <div className="recipient-summary">
            <span><strong>{recipients.length}</strong> unique recipient{recipients.length === 1 ? "" : "s"} ready</span>
            {fileEmails.length > 0 && <button type="button" className="text-button" onClick={() => { setFileEmails([]); setFileName(""); }}>Clear uploaded list</button>}
          </div>

          <div className="field">
            <div className="label-row">
              <label htmlFor="message">Email message</label>
              <span className="muted">Plain text</span>
            </div>
            <textarea id="message" rows="7" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={"Hi there,\n\nWrite your message here...\n\nBest regards"} />
          </div>

          {notice && (
            <div className={`notice ${notice.type}`} role="status">
              <span>{notice.type === "success" ? "✓" : "!"}</span>
              <p>{notice.text}</p>
            </div>
          )}

          <button className="button button-primary send-button" type="submit" disabled={busy || checking}>
            {busy ? <><span className="spinner" /> Sending emails...</> : <>Send to {recipients.length} recipient{recipients.length === 1 ? "" : "s"} <span aria-hidden="true">→</span></>}
          </button>
        </form>
      </section>

      <section className="trust-note">
        <span className="lock-icon">⌑</span>
        <p><strong>Your account, your control.</strong> Google handles sign-in and consent. BulkMail never asks for or stores your Gmail password. Disconnect to end this app session's access; you can also revoke access from your Google Account.</p>
      </section>
      <footer>BulkMail <span>·</span> Use responsibly and email only people who expect to hear from you.</footer>
    </main>
  );
}
