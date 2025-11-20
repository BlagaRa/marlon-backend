import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const ONFIDO_API_TOKEN = process.env.ONFIDO_API_TOKEN;
const ONFIDO_API_BASE = process.env.ONFIDO_API_BASE || "https://api.us.onfido.com";
const ONFIDO_API_VERSION = "v3.6";

if (!ONFIDO_API_TOKEN) {
  process.exit(1);
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/healthz", (_req, res) => res.send("ok"));

const webhookStore = new Map();

app.post("/webhook/onfido", express.raw({ type: "*/*", limit: "5mb" }), (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""), "utf8");
    let payload = {};
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(200).send("ok");
    }

    const resrc = payload?.payload?.resource || {};
    const output = resrc?.output || {};
    const runId = resrc?.workflow_run_id || resrc?.id || payload?.payload?.object?.id || null;

    if (runId) {
      const existing = webhookStore.get(runId) || {};
      
      const breakdown = output?.breakdown || existing.breakdown || null;
      const result = output?.result || existing.result || null;
      
      const status = (resrc.resource_type === "workflow_run") 
        ? (resrc.status || existing.status) 
        : existing.status;

      const merged = {
        ...existing,
        workflow_run_id: runId,
        status: status,
        result: result,
        breakdown: breakdown,
        full_name: output?.full_name || existing.full_name,
        raw_output: { ...existing.raw_output, ...output }, 
        received_at: new Date().toISOString(),
      };

      webhookStore.set(runId, merged);
    }

    res.status(200).send("ok");
  } catch (err) {
    res.status(200).send("ok");
  }
});

app.get("/api/webhook_runs/:id", (req, res) => {
  const data = webhookStore.get(req.params.id);
  if (!data) return res.status(404).json({ message: "not found" });
  res.json(data);
});

app.use(express.json({ limit: "2mb" }));

async function onfidoFetch(pathname, opts = {}) {
  const url = `${ONFIDO_API_BASE}/${ONFIDO_API_VERSION}${pathname}`;
  const headers = {
    Authorization: `Token token=${ONFIDO_API_TOKEN}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || `Onfido ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

app.post("/api/applicants", async (req, res) => {
  try {
    const { first_name, last_name, email } = req.body || {};
    const payload = { first_name, last_name, email };
    const applicant = await onfidoFetch(`/applicants`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    res.json(applicant);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

app.post("/api/workflow_runs", async (req, res) => {
  try {
    const run = await onfidoFetch(`/workflow_runs`, {
      method: "POST",
      body: JSON.stringify(req.body || {}),
    });
    res.json(run);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

app.get("/api/workflow_runs/:id", async (req, res) => {
  try {
    const runId = req.params.id;
    const run = await onfidoFetch(`/workflow_runs/${encodeURIComponent(runId)}`, {
      method: "GET",
    });

    const output = run?.output || {};
    let first_name = output?.first_name ?? null;
    let last_name = output?.last_name ?? null;
    
    if ((!first_name || !last_name) && run?.applicant_id) {
      try {
        const applicant = await onfidoFetch(
          `/applicants/${encodeURIComponent(run.applicant_id)}`,
          { method: "GET" }
        );
        first_name = first_name || applicant?.first_name || null;
        last_name = last_name || applicant?.last_name || null;
      } catch (e) {}
    }

    const full_name = [first_name, last_name].filter(Boolean).join(" ") || null;

    res.json({
      ...run,
      full_name,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});