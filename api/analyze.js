// api/analyze.js  (Forensic microservice)
// Paste into your forensic-service repo under /api/analyze.js
// Node.js serverless (CommonJS). No special runtime config.

const crypto = require("crypto");
const { URL } = require("url");
const https = require("https");

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB

// Helpers
function jsonResponse(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-worker-secret");
  res.statusCode = status;
  res.end(JSON.stringify(body, null, 2));
}

function jsonError(res, status, message, detail) {
  const out = { ok: false, error: message };
  if (detail) out.detail = String(detail);
  return jsonResponse(res, status, out);
}

function sha256Base64(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function simpleEntropyEstimate(buffer) {
  try {
    const freq = new Uint32Array(256);
    for (let i = 0; i < buffer.length; i++) freq[buffer[i]]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      if (freq[i] > 0) {
        const p = freq[i] / buffer.length;
        sum += -p * Math.log2(p);
      }
    }
    return Math.round((sum / 8) * 100) / 100;
  } catch (e) {
    return 0;
  }
}

function base64FromBuffer(buf) {
  return Buffer.from(buf).toString("base64");
}

async function safeFetchJson(url, opts = {}, timeout = 15_000) {
  // uses global fetch if available (Vercel Node has fetch), fallback to https.request
  if (typeof fetch === "function") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      const txt = await resp.text().catch(() => "");
      try {
        return { ok: resp.ok, status: resp.status, json: txt ? JSON.parse(txt) : null, text: txt };
      } catch {
        return { ok: resp.ok, status: resp.status, json: null, text: txt };
      }
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  } else {
    // fallback minimal impl (rare on Vercel)
    return { ok: false, error: "fetch unavailable" };
  }
}

// Call configured external forensic microservice (if set)
async function callExternalForensic(payload) {
  const url = String(process.env.FORENSIC_BACKEND_URL || "").trim();
  if (!url) return null;
  const headers = { "Content-Type": "application/json" };
  const workerSecret = String(process.env.WORKER_SECRET || "").trim();
  if (workerSecret) headers["X-Worker-Secret"] = workerSecret;
  const resp = await safeFetchJson(url, { method: "POST", headers, body: JSON.stringify(payload) }, 20000);
  return resp;
}

async function readRequestBody(req) {
  // If request has body parsed by platform, prefer it
  if (req.body) return req.body;

  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on("data", (d) => {
      chunks.push(d);
      len += d.length;
      if (len > MAX_BYTES + 1024) {
        // too large - stop reading
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks, len)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return jsonResponse(res, 204, null);
    if (req.method !== "POST" && req.method !== "GET") return jsonError(res, 405, "Only POST allowed");

    // Health check
    if (req.method === "GET") {
      return jsonResponse(res, 200, { ok: true, service: "forensic-service", version: "enterprise-1.0" });
    }

    const contentType = (req.headers["content-type"] || "").toLowerCase();

    // Parse input:
    // - application/json { data: "<base64>" } or { url: "https://..." }
    // - raw binary body
    let buffer = null;
    let filename = `upload-${Date.now()}`;
    let mimetype = "application/octet-stream";

    if (contentType.includes("application/json")) {
      const raw = await readRequestBody(req);
      let body = raw;
      try {
        if (Buffer.isBuffer(raw)) body = JSON.parse(raw.toString("utf8"));
      } catch (e) {
        return jsonError(res, 400, "Invalid JSON body", e.message);
      }
      if (!body) return jsonError(res, 400, "Empty JSON body");
      if (body.url) {
        // fetch remote
        const fetched = await safeFetchJson(String(body.url), { method: "GET" }, 20000);
        if (!fetched.ok) return jsonError(res, 400, "Failed to fetch remote URL", fetched.error || fetched.status);
        // fetched.text may be string; if binary needed, re-fetch using fetch binary in Node fetch scenario
        // Use platform fetch to get arrayBuffer if available
        if (typeof fetch === "function") {
          try {
            const r2 = await fetch(body.url, { method: "GET" });
            if (!r2.ok) return jsonError(res, 400, "Remote fetch failed", r2.status);
            const ab = await r2.arrayBuffer().catch(() => null);
            if (!ab) return jsonError(res, 400, "Failed to read remote binary");
            buffer = Buffer.from(ab);
            mimetype = r2.headers.get("content-type") || mimetype;
            try {
              filename = (new URL(body.url)).pathname.split("/").pop() || filename;
            } catch {}
          } catch (e) {
            return jsonError(res, 400, "Remote fetch error", String(e));
          }
        } else {
          return jsonError(res, 500, "Server fetch not available");
        }
      } else if (body.data) {
        try {
          buffer = Buffer.from(String(body.data), "base64");
        } catch (e) {
          return jsonError(res, 400, "Invalid base64 data");
        }
        filename = body.filename || filename;
        mimetype = body.mimetype || mimetype;
      } else {
        return jsonError(res, 400, "JSON must include `data` (base64) or `url`");
      }
    } else {
      // raw binary
      const raw = await readRequestBody(req).catch((e) => null);
      if (!raw || (raw.length === 0)) return jsonError(res, 400, "No file provided");
      buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      mimetype = contentType || mimetype;
    }

    if (!buffer) return jsonError(res, 400, "No file data found");
    if (buffer.length > MAX_BYTES) return jsonError(res, 413, `File too large (max ${MAX_BYTES} bytes)`);

    // Basic metadata
    const metadata = {
      filename,
      mimetype,
      size: buffer.length,
      sha256: sha256Base64(buffer)
    };

    // Heuristics
    const heuristics = {
      entropy: simpleEntropyEstimate(buffer),
      phash: (function phashStub(buf) {
        // deterministic stub - not a real pHash; microservices should compute real pHash
        let s = 0;
        for (let i = 0; i < Math.min(64, buf.length); i++) s = (s * 31 + buf[i]) >>> 0;
        return s.toString(16).padStart(8, "0");
      })(buffer)
    };

    // Quick HF-style call (if available)
    let hf = { note: "no hf key configured" };
    try {
      const hfKey = String(process.env.HUGGINGFACE_API_KEY || "").trim();
      if (hfKey) {
        // Try safe API call: send base64 in JSON
        const MODEL = "openmmlab/detected-image-manipulation"; // placeholder model id
        const url = `https://api-inference.huggingface.co/models/${MODEL}`;
        const resp = await safeFetchJson(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${hfKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ inputs: base64FromBuffer(buffer) })
        }, 20000);
        if (resp && resp.ok) hf = resp.json || { raw: resp.text };
        else hf = { error: "hf failure", status: resp && resp.status, detail: resp && resp.error };
      }
    } catch (e) {
      hf = { error: "hf error", detail: String(e) };
    }

    // Fire external forensic microservice (if configured) for deep analysis
    let external = null;
    try {
      const externalPayload = { filename, mimetype, sha256: metadata.sha256, data: base64FromBuffer(buffer) };
      const extResp = await callExternalForensic(externalPayload);
      external = extResp;
    } catch (e) {
      external = { error: String(e) };
    }

    // Compose report
    const report = {
      ok: true,
      metadata,
      heuristics,
      hf,
      external,
      processedAt: new Date().toISOString()
    };

    // Optional fire-and-forget sink
    try {
      const sink = String(process.env.STORAGE_WEBHOOK_URL || "").trim();
      if (sink) {
        (async () => {
          try {
            await fetch(sink, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "forensic", metadata, report, timestamp: new Date().toISOString() })
            });
          } catch (_) {}
        })();
      }
    } catch (_) {}

    return jsonResponse(res, 200, report);
  } catch (err) {
    console.error("forensic/analyze error:", err && err.stack ? err.stack : String(err));
    return jsonError(res, 500, "Internal Server Error", String(err));
  }
};
