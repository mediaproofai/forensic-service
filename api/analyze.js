// forensic-service/api/analyze.js
// Vercel Serverless function. POST JSON { filename, mimetype, data (base64) OR url }.
// Returns: { score: float (0..1), details: { pHash, exif, hf, ela_base64? } }

const fetch = require('node-fetch');
const exifr = require('exifr');
const sharp = require('sharp');
const crypto = require('crypto');

function bufFromBase64(b64) {
  return Buffer.from(b64, 'base64');
}

// simple pHash-like function (fast SHA on resized image) — good fingerprint
async function pHash(buffer) {
  const resized = await sharp(buffer).resize(32, 32, { fit: 'fill' }).grayscale().raw().toBuffer();
  return crypto.createHash('sha256').update(resized).digest('hex').slice(0, 16);
}

// simple lightweight ELA: recompress at quality 90 and diff
async function computeELA(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    // Only attempt for images with reasonable size
    const recompressed = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
    const origRaw = await sharp(buffer).raw().toBuffer();
    const recRaw = await sharp(recompressed).raw().toBuffer();
    const len = Math.min(origRaw.length, recRaw.length);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = Math.min(255, Math.abs(origRaw[i] - recRaw[i]) * 6);
    const png = await sharp(out, { raw: { width: meta.width, height: meta.height, channels: meta.channels || 3 } }).png().toBuffer();
    return png.toString('base64');
  } catch (e) {
    return null;
  }
}

// call Hugging Face model (binary or JSON fallback)
async function callHF(buffer, mimetype) {
  const token = String(globalThis["HUGGINGFACE_API_KEY"] || "").trim();
  if (!token) return { error: "HUGGINGFACE_API_KEY not configured" };

  // Default model — change to your preferred tampering model or endpoint
  const MODEL_ID = 'openmmlab/detected-image-manipulation'; // replace if needed
  const url = `https://api-inference.huggingface.co/models/${MODEL_ID}`;

  // try binary
  try {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimetype || 'application/octet-stream' }, body: buffer });
    if (r.ok) {
      const c = r.headers.get('content-type') || '';
      if (c.includes('application/json')) {
        const json = await r.json().catch(()=>null);
        return json;
      } else {
        const text = await r.text().catch(()=>null);
        return { raw: text };
      }
    }
    // fallback: base64 JSON
    const text1 = await r.text().catch(()=>null);
    const base64 = buffer.toString('base64');
    const r2 = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: base64 }) });
    if (!r2.ok) {
      const t2 = await r2.text().catch(()=>null);
      return { error: 'HF model failed', status1: r.status, text1, status2: r2.status, text2: t2 };
    }
    const j2 = await r2.json().catch(()=>null);
    return j2;
  } catch (e) {
    return { error: String(e) };
  }
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = req.body;
    if (!body) return res.status(400).json({ error: 'Missing JSON body' });

    let buffer;
    let filename = body.filename || `upload-${Date.now()}`;
    let mimetype = body.mimetype || 'application/octet-stream';

    if (body.data) {
      buffer = bufFromBase64(body.data);
    } else if (body.url) {
      // fetch remote resource
      const r = await fetch(body.url);
      if (!r.ok) return res.status(400).json({ error: 'Failed to fetch URL' });
      buffer = Buffer.from(await r.arrayBuffer());
      mimetype = r.headers.get('content-type') || mimetype;
    } else {
      return res.status(400).json({ error: 'Provide data (base64) or url' });
    }

    if (buffer.length > 12 * 1024 * 1024) return res.status(413).json({ error: 'File too large (12MB)' });

    // EXIF
    let exif = null;
    try { exif = await exifr.parse(buffer).catch(()=>null); } catch(e) { exif = null; }

    // pHash
    const ph = await pHash(buffer).catch(()=>null);

    // ELA (best-effort)
    const ela = await computeELA(buffer).catch(()=>null);

    // call HF
    const hfRaw = await callHF(buffer, mimetype);

    // attempt to extract a numeric score from HF response
    let aiScore = null;
    try {
      if (Array.isArray(hfRaw) && hfRaw[0] && (hfRaw[0].score || hfRaw[0].probability)) aiScore = hfRaw[0].score ?? hfRaw[0].probability;
      else if (hfRaw.score) aiScore = hfRaw.score;
    } catch (e) { aiScore = null; }

    // combine a composite score (example weighting)
    const heurEntropy = 0.5; // placeholder for heuristics if you add them later
    const composite = Math.round(((Number(aiScore || 0) * 0.8) + (heurEntropy * 0.2)) * 100) / 100;

    const result = {
      score: composite,
      breakdown: { ai: aiScore, heuristics: heurEntropy },
      details: { pHash: ph, exif, ela, hf: hfRaw }
    };

    return res.status(200).json(result);
  } catch (err) {
    console.error('forensic error', err);
    return res.status(500).json({ error: String(err) });
  }
};
