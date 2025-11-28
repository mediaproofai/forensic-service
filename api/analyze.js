/**
 * MediaProof Forensic Microservice (Enterprise Edition)
 * -----------------------------------------------------
 * Performs:
 *   - Secret-authenticated request validation
 *   - EXIF metadata extraction
 *   - pHash perceptual hashing
 *   - HuggingFace image classifier (optional)
 *   - Full structured forensic report
 *
 * Expected Payload Format (from Cloudflare Worker):
 * {
 *   "filename": "image.png",
 *   "mimetype": "image/png",
 *   "buffer": "<base64>"
 * }
 */

const exifr = require("exifr");
const { imageHash } = require("image-hash");
const axios = require("axios");

const WORKER_SECRET = process.env.WORKER_SECRET || "";
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY || "";


// -------------------------------------------------------
// Utility: Compute pHash with Promise wrapper
// -------------------------------------------------------
function computePHash(buffer) {
  return new Promise((resolve, reject) => {
    imageHash(
      { data: buffer },
      16,
      true, // phash
      (err, hash) => {
        if (err) return reject(err);
        resolve(hash);
      }
    );
  });
}

// -------------------------------------------------------
// Utility: Call HuggingFace image classification
// -------------------------------------------------------
async function runHuggingFace(buffer) {
  try {
    if (!HUGGINGFACE_API_KEY) {
      return { enabled: false, reason: "HUGGINGFACE_API_KEY not set" };
    }

    const HF_URL =
      "https://api-inference.huggingface.co/models/google/vit-base-patch16-224";

    const response = await axios.post(
      HF_URL,
      buffer,
      {
        headers: {
          Authorization: `Bearer ${HUGGINGFACE_API_KEY}`,
          "Content-Type": "application/octet-stream"
        }
      }
    );

    return {
      enabled: true,
      output: response.data
    };
  } catch (err) {
    return {
      enabled: true,
      error: String(err)
    };
  }
}

// -------------------------------------------------------
// Main handler
// -------------------------------------------------------
module.exports = async function handler(req, res) {
  console.log("Forensic Service Invoked", {
    method: req.method,
    path: req.url,
    ts: Date.now()
  });

  try {
    // ---------------------------
    // Health check
    // ---------------------------
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        service: "mediaproof-forensic",
        uptime: process.uptime(),
        message: "Health OK"
      });
    }

    // ---------------------------
    // SECRET CHECK
    // ---------------------------
    const incoming = req.headers["x-worker-secret"];
    if (!incoming || incoming !== WORKER_SECRET) {
      return res
        .status(401)
        .json({ error: "Unauthorized: invalid worker secret" });
    }

    // ---------------------------
    // READ BODY (handles JSON + raw)
    // ---------------------------
    let body = req.body;
    if (!body) {
      body = await new Promise((resolve, reject) => {
        let d = "";
        req.on("data", (c) => (d += c));
        req.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (_) {
            resolve(null);
          }
        });
        req.on("error", reject);
      });
    }

    if (!body || !body.buffer) {
      return res.status(400).json({
        error: "Invalid payload",
        expected: { filename: "...", mimetype: "...", buffer: "<base64>" }
      });
    }

    // ---------------------------
    // Decode image
    // ---------------------------
    const buffer = Buffer.from(body.buffer, "base64");

    // ---------------------------
    // Run EXIF
    // ---------------------------
    let exifData = null;
    try {
      exifData = await exifr.parse(buffer);
    } catch (_) {
      exifData = { error: "Failed to parse EXIF" };
    }

    // ---------------------------
    // Compute pHash
    // ---------------------------
    let pHash = null;
    try {
      pHash = await computePHash(buffer);
    } catch (err) {
      pHash = `Error: ${String(err)}`;
    }

    // ---------------------------
    // HuggingFace inference
    // ---------------------------
    const hfResult = await runHuggingFace(buffer);

    // ---------------------------
    // Build final report
    // ---------------------------
    const report = {
      filename: body.filename,
      mimetype: body.mimetype,
      timestamp: Date.now(),
      exif: exifData,
      phash: pHash,
      huggingface: hfResult,
      status: "analysis_complete"
    };

    console.log("Forensic analysis complete");

    return res.status(200).json(report);
  } catch (err) {
    console.error("Forensic handler error:", err);
    return res.status(500).json({
      error: "internal_error",
      message: String(err),
      ts: Date.now()
    });
  }
};
