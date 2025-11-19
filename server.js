// server.mjs
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
  console.error("❌ Lipsă ONFIDO_API_TOKEN în .env");
  process.exit(1);
}

/* CORS larg pentru testare publică, fără cookies */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* Health */
app.get("/healthz", (_req, res) => res.send("ok"));

/* Webhook: citim RAW înainte de JSON parser */
const webhookStore = new Map();

app.post("/webhook/onfido", express.raw({ type: "*/*", limit: "5mb" }), (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""), "utf8");
    let payload = {};
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      console.warn("⚠️ Webhook JSON invalid");
      return res.status(200).send("ok");
    }

    const resrc = payload?.payload?.resource || {};
    const output = resrc?.output || {};
    const runId =
      resrc?.id || payload?.payload?.object?.id || payload?.object?.id || null;

    const mapped = {
      workflow_run_id: runId,
      status: resrc?.status || payload?.payload?.object?.status || null,
      first_name: output?.first_name ?? null,
      last_name: output?.last_name ?? null,
      full_name: output?.full_name ?? null,
      gender: output?.gender ?? null,
      dob: output?.dob ?? null,
      document_type: output?.document_type ?? null,
      document_number: output?.document_number ?? null,
      date_expiry: output?.date_expiry ?? null,
      address: output?.address ?? null, // poate fi obiect sau string
      applicant_id: resrc?.applicant_id || null,
      received_at: new Date().toISOString(),
    };

    if (runId) {
      webhookStore.set(runId, { ...mapped, raw_output: output, raw_payload: payload });
      console.log("✅ Webhook primit:", runId, "status:", mapped.status);
      console.log("ℹ️ Webhook output:", JSON.stringify(output, null, 2));
    } else {
      console.log("⚠️ Webhook fără run id");
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Eroare webhook:", err);
    res.status(200).send("ok");
  }
});

app.get("/api/webhook_runs/:id", (req, res) => {
  const data = webhookStore.get(req.params.id);
  if (!data) return res.status(404).json({ message: "not found" });
  res.json(data);
});

/* JSON parser după webhook */
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

/* Utils pentru adresă: formatăm orice variantă în string prietenos */
function formatAddressGeneric(addr) {
  if (!addr) return null;
  if (typeof addr === "string") return addr;
  const parts = [
    addr.flat_number,
    addr.building_number,
    addr.building_name,
    addr.line1 || addr.street,
    addr.line2,
    addr.line3,
    addr.town,
    addr.state,
    addr.postcode,
    addr.country,
  ].filter(Boolean);
  return parts.join(", ");
}

/* Create applicant — primește câmpuri simple și construiește address corect */
app.post("/api/applicants", async (req, res) => {
  try {
    const {
      first_name,
      last_name,
      email,
      country, // ISO3
      town,    // city
      address, // single line goes to line1
      state,
      postcode,
    } = req.body || {};

    const ctry = (country || "").toUpperCase().trim();
    const city = (town || "").trim();
    const line1 = (address || "").trim();
    let st = (state || "").trim();

    // ✅ for USA enforce 2-letter USPS
    if (ctry === "USA") {
      st = st.toUpperCase().slice(0, 2);
      if (!/^[A-Z]{2}$/.test(st)) {
        return res.status(400).json({ error: "State is required for US addresses (two-letter USPS code)." });
      }
    } else {
      st = st || undefined; // optional elsewhere
    }

    let addressPayload = null;
    const pc = (postcode || "").trim();

    if (ctry.length === 3 && (city || line1)) {
      addressPayload = {
        country: ctry,
        town: city || undefined,
        line1: line1 || undefined,
        state: st || undefined,
        postcode: pc || undefined,
      };
    }

    const payload = {
      first_name,
      last_name,
      email,
      ...(addressPayload ? { address: addressPayload } : {}),
    };

    const applicant = await onfidoFetch(`/applicants`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    res.json(applicant);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

/* Pornește workflow */
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

/* Citește applicant (fallback util) */
app.get("/api/applicants/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const applicant = await onfidoFetch(`/applicants/${encodeURIComponent(id)}`, {
      method: "GET",
    });
    res.json(applicant);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

/* Get workflow run + fallback pe applicant + adresă formatată */
app.get("/api/workflow_runs/:id", async (req, res) => {
  try {
    const runId = req.params.id;
    const run = await onfidoFetch(`/workflow_runs/${encodeURIComponent(runId)}`, {
      method: "GET",
    });

    const status = run?.status || null;
    const output = run?.output || {};

    let first_name = output?.first_name ?? null;
    let last_name = output?.last_name ?? null;
    let full_name = output?.full_name ?? null;
    let gender = output?.gender ?? null;
    let dob = output?.dob ?? null;
    let document_type = output?.document_type ?? null;
    let document_number = output?.document_number ?? null;
    let date_expiry = output?.date_expiry ?? null;

    let address_obj = typeof output?.address === "object" ? output.address : null;
    let address_str = typeof output?.address === "string" ? output.address : null;

    if ((!first_name || !last_name || (!address_obj && !address_str)) && run?.applicant_id) {
      try {
        const applicant = await onfidoFetch(
          `/applicants/${encodeURIComponent(run.applicant_id)}`,
          { method: "GET" }
        );
        first_name = first_name || applicant?.first_name || null;
        last_name = last_name || applicant?.last_name || null;
        if (!full_name && (first_name || last_name)) {
          full_name = [first_name, last_name].filter(Boolean).join(" ") || null;
        }
        if (!address_obj && !address_str && applicant?.address) {
          if (typeof applicant.address === "string") address_str = applicant.address;
          else address_obj = applicant.address;
        }
      } catch (e) {
        console.warn("⚠️ Applicant fallback failed:", e?.message || e);
      }
    }

    const address_formatted =
      address_str || formatAddressGeneric(address_obj) || null;

    res.json({
      workflow_run_id: run?.id || runId,
      status,
      applicant_id: run?.applicant_id || null,
      document_type: document_type ?? null,
      document_number: document_number ?? null,
      dob: dob ?? null,
      date_expiry: date_expiry ?? null,
      gender: gender ?? null,
      first_name: first_name ?? null,
      last_name: last_name ?? null,
      full_name: full_name || [first_name, last_name].filter(Boolean).join(" ") || null,
      address: address_obj || address_str || null,
      address_formatted,
      dashboard_url: run?.dashboard_url || null,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.payload });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server pornit pe http://localhost:${PORT}`);
});
