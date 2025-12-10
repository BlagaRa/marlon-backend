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

// UPDATED: Webhook handler to support workflow_task.completed structure
app.post("/webhook/onfido", express.raw({ type: "*/*", limit: "5mb" }), (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""), "utf8");
    let payload = {};
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(200).send("ok");
    }

    // Determine the type of webhook resource
    const resrc = payload?.payload?.resource || {};
    // Logic for tasks: resource.output contains sub_result and properties
    const output = resrc?.output || {};
    
    // Find ID: could be workflow_run_id (inside task resource) or id (if it is a run)
    const runId = resrc?.workflow_run_id || resrc?.id || payload?.payload?.object?.id || null;

    if (runId) {
      const existing = webhookStore.get(runId) || { raw_output: {} };
      
      const mergedOutput = { ...existing.raw_output };

      // Flatten the output object into mergedOutput
      if (output && typeof output === 'object' && !Array.isArray(output)) {
          Object.keys(output).forEach(key => {
              if (output[key] !== null && output[key] !== undefined) {
                  mergedOutput[key] = output[key];
              }
          });
      }

      // Handle properties specifically if they exist (common in tasks)
      if (output.properties && typeof output.properties === 'object') {
           Object.keys(output.properties).forEach(key => {
              mergedOutput[key] = output.properties[key];
           });
      }

      let status = existing.status;
      // If the resource itself has a status (like a run), use it
      if (resrc.status && resrc.status !== "processing") {
          status = resrc.status; 
      }

      const breakdown = output?.breakdown || existing.breakdown || null;
      // Use sub_result if available (from task), otherwise generic result
      const result = output?.sub_result || output?.result || existing.result || null;

      const merged = {
        ...existing,
        workflow_run_id: runId,
        status: status,
        result: result,
        breakdown: breakdown,
        full_name: output?.full_name || existing.full_name, 
        raw_output: mergedOutput, 
        received_at: new Date().toISOString(),
      };

      webhookStore.set(runId, merged);
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error", err);
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
    // UPDATED: Accept phone_number
    const { first_name, last_name, email, phone_number } = req.body || {};
    const payload = { first_name, last_name, email, phone_number };
    
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

    const webhookData = webhookStore.get(runId);
    
    // Merge run output with webhook output
    const output = { 
        ...(run?.output || {}), 
        ...(webhookData?.raw_output || {}) 
    };

    let first_name = output?.first_name ?? null;
    let last_name = output?.last_name ?? null;
    
    // If name is missing in output, try fetching applicant details
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
      output, 
      full_name,
      status: run.status 
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});