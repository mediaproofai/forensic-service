// image-forensics/api/analyze.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Only POST allowed' });
    }

    const body = await safeParseJson(req);
    const { mediaUrl, base64, requestId } = body || {};

    if (!mediaUrl && !base64) {
      return res.status(400).json({ ok: false, error: 'mediaUrl or base64 required' });
    }

    const logBase = { service: 'image-forensics', requestId: requestId || genId() };
    console.info('START', logBase);

    // 1) fetch bytes if mediaUrl provided (with timeout)
    const blob = mediaUrl ? await fetchWithTimeout(mediaUrl, 20_000) : Buffer.from(base64, 'base64');

    // 2) metadata extraction (external service)
    const metadata = await callExternalJson(process.env.METADATA_SERVICE_URL, { blob }, { timeout: 10_000 }, logBase)
      .catch(e => ({ error: 'metadata_failed', message: String(e) }));

    // 3) model-based tamper detection
    const modelResp = await callExternalJson(process.env.IMAGE_MODEL_URL, { url: mediaUrl, base64 }, { timeout: 25_000, retries: 2 }, logBase)
      .catch(e => ({ error: 'model_failed', message: String(e) }));

    // 4) heuristic checks (simple)
    const heuristics = {
      noiseMismatch: heuristicNoiseCheck(metadata).score,
      jpegGhosting: heuristicGhostCheck(blob).score
    };

    // combine into a forensic score
    const forensicRisk = computeRisk([
      modelResp?.score ?? 0,
      heuristics.noiseMismatch * 100,
      heuristics.jpegGhosting * 100
    ]);

    const result = {
      ok: true,
      service: 'image-forensics',
      requestId: logBase.requestId,
      forensicRisk: Math.round(forensicRisk),
      details: {
        metadata,
        model: modelResp,
        heuristics
      }
    };

    console.info('END', logBase, { forensicRisk: result.forensicRisk });
    return res.status(200).json(result);

  } catch (err) {
    console.error('ERROR image-forensics', err);
    return res.status(500).json({ ok: false, error: 'internal_error', message: String(err) });
  }
}

/* ----------------- helpers ----------------- */

async function safeParseJson(req) {
  try { return await req.json(); } catch { return null; }
}
function genId() { return Math.random().toString(36).slice(2, 12); }

async function fetchWithTimeout(url, ms = 15_000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  const res = await fetch(url, { signal: ctrl.signal });
  clearTimeout(id);
  if (!res.ok) throw new Error('fetch_failed:' + res.status);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

async function callExternalJson(url, payload, opts = {}, logBase = {}) {
  if (!url) throw new Error('missing external url');
  const { timeout = 15_000, retries = 1 } = opts;
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const ctrl = new AbortController();
      const id = setTimeout(() => ctrl.abort(), timeout);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.EXTERNAL_API_KEY || '' },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      clearTimeout(id);
      const j = await r.json().catch(() => ({ status: r.status }));
      if (!r.ok) throw new Error('bad_status:' + r.status);
      return j;
    } catch (e) {
      attempt++;
      console.warn('external call attempt failed', { ...logBase, attempt, err: String(e) });
      if (attempt > retries) throw e;
      await sleep(300 * attempt);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function heuristicNoiseCheck(metadata = {}) {
  // placeholder heuristic: if image has inconsistent compression values
  const score = (metadata?.exif?.Noise || 0) > 0 ? 0.6 : 0.1;
  return { score, reason: 'simple-noise-rule' };
}

function heuristicGhostCheck(blob) {
  // placeholder: stub returning low confidence
  return { score: 0.15, reason: 'jpegGhostStub' };
}

function computeRisk(values = []) {
  // weighted average, clamp 0..100
  const sum = values.reduce((a, b) => a + (Number(b) || 0), 0);
  const avg = values.length ? sum / values.length : 0;
  return Math.max(0, Math.min(100, avg));
}
