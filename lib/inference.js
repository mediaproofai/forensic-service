import crypto from "crypto";
import { fileTypeFromBuffer } from "file-type";
import fetch from "node-fetch";

export async function runForensicPipeline(buffer) {
  const report = {
    ok: true,
    meta: {},
    ai: {},
    scores: {},
    errors: []
  };

  // 1. SHA256 fingerprint
  try {
    report.meta.sha256 = crypto
      .createHash("sha256")
      .update(buffer)
      .digest("hex");
  } catch (e) {
    report.errors.push("Fingerprinting failed");
  }

  // 2. File type detection
  try {
    const type = await fileTypeFromBuffer(buffer);
    report.meta.fileType = type || null;
  } catch {
    report.errors.push("File type couldn't be read");
  }

  // 3. EXIF extraction (Cloudflare Worker will do offline EXIF too)
  try {
    report.meta.exif = await extractEXIF(buffer);
  } catch {
    report.meta.exif = null;
    report.errors.push("EXIF extraction failed");
  }

  // 4. AI Forgery Detection (HuggingFace inference)
  try {
    const aiResult = await callHFAI(buffer);
    report.ai = aiResult;
  } catch (e) {
    report.ai = null;
    report.errors.push("AI model inference failed");
  }

  // 5. Scoring system
  report.scores = {
    forgeryScore: generateScore(report.ai),
    metadataIntegrity: report.meta.exif ? 0.92 : 0.4,
    compressionSuspicion:
      report.ai?.jpeg_artifacts ?? 0.3
  };

  return report;
}

// ---- Helper: HuggingFace model call ----
async function callHFAI(buffer) {
  const HF_URL = process.env.HF_MODEL_URL;
  const HF_KEY = process.env.HF_API_KEY;

  const resp = await fetch(HF_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_KEY}`,
      "Content-Type": "application/octet-stream"
    },
    body: buffer
  });

  if (!resp.ok) throw new Error("HF Inference Error");

  return await resp.json();
}

// ---- Helper: Dummy EXIF extractor ----
// (Cloudflare Worker can override this with full EXIF)
async function extractEXIF() {
  return {
    hasEXIF: false,
    camera: null,
    lat: null,
    lng: null
  };
}

// ---- Helper: Final scoring function ----
function generateScore(ai) {
  if (!ai) return 0.5;
  return (
    ai.manipulation_probability ??
    ai.forgery ??
    ai.score ??
    0.5
  );
}
