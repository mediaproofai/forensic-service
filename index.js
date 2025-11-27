import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));

// Security header
const REQUIRED_SECRET = process.env.WORKER_SECRET;

// Health endpoint
app.get("/", (req, res) => {
  res.json({ ok: true, service: "forensic-service" });
});

// Main forensic endpoint
app.post("/analyze", async (req, res) => {
  const t0 = Date.now();

  try {
    // 1 — Security check
    const clientSecret = req.headers["x-worker-secret"];
    if (!clientSecret || clientSecret !== REQUIRED_SECRET) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    // 2 — Validate payload
    const payload = req.body;

    if (!payload?.jobId || !payload?.source?.bytes) {
      return res.status(400).json({
        ok: false,
        error: "BAD_PAYLOAD",
        message: "Missing jobId or source.bytes"
      });
    }

    // 3 — Decode Base64
    const rawBuffer = Buffer.from(payload.source.bytes, "base64");

    // 4 — Run forensic analysis (MODEL MOCK)
    // Replace this with real model later
    const authenticity = Math.random() * 0.4 + 0.6; // 0.6–1.0
    const manipulated = authenticity < (payload.settings?.threshold || 0.5);

    // You can add heatmap detection later here
    const fakeRegions = manipulated ? [{ x: 100, y: 40, w: 60, h: 30 }] : [];

    // 5 — Final response
    return res.json({
      ok: true,
      jobId: payload.jobId,
      stats: {
        elapsedMs: Date.now() - t0,
        model: "forensic-v1",
        confidence: Number(authenticity.toFixed(3))
      },
      result: {
        authenticityScore: authenticity,
        manipulationsDetected: manipulated,
        regions: fakeRegions,
        summary: manipulated
          ? "Potential manipulation detected."
          : "No manipulation detected."
      }
    });

  } catch (err) {
    console.error("Forensic error:", err);
    return res.status(500).json({
      ok: false,
      jobId: req.body?.jobId || null,
      error: {
        type: "PROCESSING_ERROR",
        message: err.message
      }
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Forensic microservice running on ${PORT}`)
);
