// api/analyze.js
// Forensic microservice handler (Node serverless, works with @vercel/node)
// Supports JSON { data: "<base64>" } or { url }, or raw binary body.
// Optional: HUGGINGFACE_API_KEY to call an image model for inference.
// Optional: ADMIN_API_KEYS env var (comma-separated) to protect endpoints.

const DEFAULT_MAX_BYTES = 14 * 1024 * 1024; // 14 MB

// ---------- Helpers ----------
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-worker-secret"
  };
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(JSON.stringify(body, null, 2));
}

function jsonError(res, status, message, detail) {
  const out = { ok: false, error: message };
  if (detail) out.detail = detail;
  return jsonResponse(res, status, out);
}

function parseBase64(b64) {
  try {
    // strip data: prefix
    const m = b64.match(/^data:(.+);base64,(.*)$/);
    if (m) b64 = m[2];
    return Buffer.from(b64, "base64");
  } catch (e) {
    return null;
  }
}

function detectMimeFromBuffer(buf) {
  if (!buf || buf.length < 12) return "application/octet-stream";
  const sig = buf.slice(0, 12).toString("hex").toLowerCase();
  // JPEG FF D8
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  // PNG 89 50 4E 47 0D 0A 1A 0A
  if (sig.startsWith("89504e470d0a1a0a")) return "image/png";
  // GIF 47 49 46
  if (buf.slice(0, 3).toString() === "GIF") return "image/gif";
  // PDF %PDF
  if (buf.slice(0, 4).toString() === "%PDF") return "application/pdf";
  // WAV "RIFF" ... "WAVE"
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WAVE") return "audio/wav";
  // MP3: frame sync or ID3
  if (buf.slice(0, 3).toString() === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  // fallback
  return "application/octet-stream";
}

function entropyEstimate(buf) {
  if (!buf || buf.length === 0) return 0;
  const freq = new Uint32Array(256);
  for (let i = 0; i < buf.length; i++) freq[buf[i]]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    if (!freq[i]) continue;
    const p = freq[i] / buf.length;
    sum += -p * Math.log2(p);
  }
  return Number((sum / 8).toFixed(3)); // normalized 0..1
}

// simple pHash stub (not cryptographic) - returns hex string
function pHashStub(buf) {
  try {
    let s = 2166136261 >>> 0;
    for (let i = 0; i < Math.min(buf.length, 4096); i += 4) {
      s = Math.imul(s ^ buf[i], 16777619) >>> 0;
    }
    return ("00000000" + (s >>> 0).toString(16)).slice(-8);
  } catch (e) {
    return null;
  }
}

// Extract JPEG quantization tables (if JPEG) - returns array of tables (approx)
function extractJpegQuantTables(buf) {
  try {
    if (!buf || buf.length < 4) return null;
    if (!(buf[0] === 0xff && buf[1] === 0xd8)) return null;
    let i = 2;
    const tables = [];
    while (i < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      i += 2;
      if (marker === 0xda) break; // start of scan
      const len = buf.readUInt16BE(i);
      if (marker === 0xdb) {
        // DQT
        let j = i + 2;
        while (j < i + len) {
          const pqTq = buf[j++];
          const pq = pqTq >> 4; // 0: 8-bit, 1:16-bit
          const tq = pqTq & 0x0f;
          const table = [];
          const entries = pq === 0 ? 64 : 128;
          for (let e = 0; e < 64; e++) {
            const v = pq === 0 ? buf[j++] : buf.readUInt16BE(j); j += pq === 0 ? 0 : 2;
            table.push(v);
          }
          tables.push({ id: tq, valuesSample: table.slice(0, 8) });
        }
      }
      i += len;
    }
    return tables.length ? tables : null;
  } catch (e) {
    return null;
  }
}

// safe fetch wrapper with timeout
async function safeFetch(url, opts = {}) {
  try {
    const controller = new AbortController();
    const timeout = opts.timeout || 15000;
    const t = setTimeout(() => controller.abort(), timeout);
    const r = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(t);
    return r;
  } catch (e) {
    return null;
  }
}

// Call Hugging Face inference model (image); returns parsed JSON or null
async function callHuggingFaceImage(buffer, mimeType) {
  try {
    const key = String(process.env.HUGGINGFACE_API_KEY || "").trim();
    if (!key) return null;
    // replace with your model id for manipulation detection
    const MODEL = process.env.HF_IMAGE_MODEL || "openmmlab/detected-image-manipulation";
    const url = `https://api-inference.huggingface.co/models/${MODEL}`;
    // Try sending raw bytes first
    let resp = await safeFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": mimeType || "application/octet-stream" },
      body: buffer,
      timeout: 20000
    });
    if (!resp || !resp.ok) {
      // fallback: base64 in JSON
      const base64 = buffer.toString("base64");
      resp = await safeFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: base64 }),
        timeout: 30000
      });
    }
    if (!resp) return null;
    const text = await resp.text().catch(() => null);
    try { return text ? JSON.parse(text) : null; } catch (e) { return { raw: text }; }
  } catch (e) {
    return null;
  }
}

// ---------- Auth ----------
function isAuthRequired() {
  try {
    const raw = String(process.env.ADMIN_API_KEYS || "").trim();
    return raw.length > 0;
  } catch (e) { return false; }
}
function validateApiKey(key) {
  if (!key) return false;
  const raw = String(process.env.ADMIN_API_KEYS || "").trim();
  const allowed = raw.split(",").map(s => s.trim()).filter(Boolean);
  return allowed.includes(key);
}

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  try {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (isAuthRequired()) {
      const key = req.headers["x-api-key"] || req.headers["authorization"];
      if (!validateApiKey(key)) return jsonError(res, 401, "Unauthorized: missing or invalid x-api-key");
    }

    if (req.method === "GET") {
      return jsonResponse(res, 200, { ok: true, service: "MediaProof Forensic", version: "enterprise-1.0", timestamp: new Date().toISOString() });
    }

    if (req.method !== "POST") return jsonError(res, 405, "Only POST allowed");

    // Read body. Support JSON (base64/url), raw binary. Multipart not supported here (mention busboy).
    let buf = null;
    let contentType = (req.headers["content-type"] || "").toLowerCase();

    // If @vercel/node, req.body may already be parsed if small.
    if (req.body && typeof req.body !== "string" && Buffer.isBuffer(req.body)) {
      buf = req.body;
    } else if (contentType.includes("application/json")) {
      // body parsed by platform or can be read
      let body = req.body;
      if (!body) {
        // read raw
        body = await new Promise((resolve) => {
          let d = "";
          req.on("data", c => d += c);
          req.on("end", () => resolve(d ? JSON.parse(d) : {}));
          req.on("error", () => resolve({}));
        }).catch(() => ({}));
      }
      if (body.data) {
        buf = parseBase64(String(body.data));
        contentType = body.mimetype || contentType || detectMimeFromBuffer(buf);
      } else if (body.url) {
        const fetched = await safeFetch(String(body.url));
        if (!fetched || !fetched.ok) return jsonError(res, 400, "Failed to fetch remote url");
        const ab = await fetched.arrayBuffer().catch(() => null);
        if (!ab) return jsonError(res, 400, "Failed to read remote content");
        buf = Buffer.from(ab);
        contentType = fetched.headers.get("content-type") || detectMimeFromBuffer(buf);
      } else {
        return jsonError(res, 400, "JSON must include `data` (base64) or `url`");
      }
    } else if (contentType.includes("multipart/form-data")) {
      // multipart parsing requires busboy/formidable; not installed by default.
      return jsonError(res, 400, "multipart/form-data not supported in this build. Send JSON with base64 or a public url. To enable multipart, install busboy and update handler.");
    } else {
      // raw binary
      const chunks = [];
      await new Promise((resolve) => {
        req.on("data", (c) => chunks.push(c));
        req.on("end", resolve);
        req.on("error", resolve);
      });
      if (chunks.length) buf = Buffer.concat(chunks);
      contentType = contentType || detectMimeFromBuffer(buf);
    }

    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return jsonError(res, 400, "No file data found");
    if (buf.length > (parseInt(process.env.MAX_BYTES || DEFAULT_MAX_BYTES))) return jsonError(res, 413, "File too large");

    // Basic metadata
    const metadata = {
      byteLength: buf.length,
      mimeType: contentType || detectMimeFromBuffer(buf),
      filename: (req.body && req.body.filename) || null,
      sha256: require("crypto").createHash("sha256").update(buf).digest("hex").slice(0, 16)
    };

    // Heuristics
    const heuristics = {
      entropy: entropyEstimate(buf),
      pHash: pHashStub(buf),
      mimeGuess: detectMimeFromBuffer(buf),
      jpegQuantTables: null
    };

    if ((metadata.mimeType || "").startsWith("image/") || metadata.mimeType === "image/jpeg") {
      heuristics.jpegQuantTables = extractJpegQuantTables(buf) || null;
    }

    // Optional: call Hugging Face image model if configured
    let hf = null;
    if ((metadata.mimeType || "").startsWith("image/")) {
      hf = await callHuggingFaceImage(buf, metadata.mimeType).catch(() => null);
    }

    // Composite trust scoring (example)
    const aiScore = Number((hf && (hf.score ?? hf.probability)) || 0);
    const composite = Math.round(((aiScore * 0.7) + (heuristics.entropy * 0.25)) * 100) / 100;

    const result = {
      metadata,
      heuristics,
      hf,
      trustScore: { composite, breakdown: { ai: aiScore, entropy: heuristics.entropy } },
      receivedAt: new Date().toISOString()
    };

    // Optional fire-and-forget sink
    try {
      const sink = String(process.env.STORAGE_WEBHOOK_URL || "").trim();
      if (sink) {
        fetch(sink, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "forensic", metadata, result, timestamp: new Date().toISOString() })
        }).catch(() => {});
      }
    } catch (e) {}

    return jsonResponse(res, 200, { ok: true, filename: metadata.filename || "upload", result });
  } catch (err) {
    console.error("analyze error:", err);
    return jsonError(res, 500, "internal", String(err));
  }
};
