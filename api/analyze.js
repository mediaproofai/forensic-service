// api/analyze.js
// Node.js Serverless Function (NOT Edge)
// Enterprise-level error handling + Worker Secret auth

const workerSecret = process.env.WORKER_SECRET || "";

module.exports = async (req, res) => {
  try {
    // Allow GET for health check
    if (req.method === "GET") {
      return res.status(200).json({ ok: true });
    }

    // Enforce POST
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // Verify Worker -> Microservice secret
    const incoming = req.headers["x-worker-secret"];
    if (!incoming || incoming !== workerSecret) {
      return res.status(401).json({ error: "Unauthorized - invalid worker secret" });
    }

    // Parse JSON body
    const { filename, mimetype, data } = req.body || {};

    if (!filename || !mimetype || !data) {
      return res.status(400).json({ error: "Missing fields: filename, mimetype, data required" });
    }

    // Decode Base64
    const buffer = Buffer.from(data, "base64");

    // --------------------------------------------
    // 🔍 IMAGE FORENSICS PIPELINE (enterprise level)
    // --------------------------------------------

    const results = {
      ok: true,
      filename,
      mimetype,
      size_bytes: buffer.length,
      analyses: {}
    };

    // 1) Extract EXIF
    try {
      const exifr = require("exifr");
      const exifData = await exifr.parse(buffer).catch(() => null);
      results.analyses.exif = exifData || "No EXIF found";
    } catch (err) {
      results.analyses.exif = `EXIF error: ${err.message}`;
    }

    // 2) Perceptual Hash
    try {
      const sharp = require("sharp");
      const resized = await sharp(buffer).resize(9, 8).greyscale().raw().toBuffer();
      let hash = "";
      for (let i = 1; i < resized.length; i++) {
        hash += resized[i] > resized[0] ? "1" : "0";
      }
      results.analyses.pHash = hash;
    } catch (err) {
      results.analyses.pHash = `pHash error: ${err.message}`;
    }

    // 3) HuggingFace deepfake model (optional)
    // Uncomment once your HF key is ready
    /*
    try {
      const hfRes = await fetch("https://api-inference.huggingface.co/models/your-model", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.HF_API_KEY}`,
          "Content-Type": "application/octet-stream"
        },
        body: buffer
      });

      const hfJson = await hfRes.json();
      results.analyses.hf = hfJson;
    } catch (err) {
      results.analyses.hf = `HF error: ${err.message}`;
    }
    */

    // SUCCESS RESPONSE
    return res.status(200).json(results);

  } catch (err) {
    console.error("Internal server error:", err);
    return res.status(500).json({
      error: "Server crash",
      message: err?.message || "Unknown"
    });
  }
};

