import fs from "fs";
import { file as tmpFile } from "tmp-promise";
import fetch from "node-fetch";
import FormData from "form-data";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST requests allowed." });
    }

    const { imageBase64, metadata } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "Image missing in payload." });
    }

    // 1. Write image into temp file
    const { path, cleanup } = await tmpFile({ postfix: ".jpg" });
    const imageBuffer = Buffer.from(imageBase64, "base64");
    await fs.promises.writeFile(path, imageBuffer);

    // 2. Prepare forensic pipeline request
    const form = new FormData();
    form.append("file", fs.createReadStream(path));
    form.append(
      "metadata",
      JSON.stringify({
        receivedAt: new Date().toISOString(),
        source: "mediaproof-worker",
        ...metadata,
      })
    );

    // 3. Forward to your forensic model / pipeline (replace this)
    const forensicURL = process.env.FORENSIC_MODEL_URL;

    const forensicResponse = await fetch(forensicURL, {
      method: "POST",
      body: form,
    });

    const forensicJSON = await forensicResponse.json();

    cleanup();

    return res.json({
      success: true,
      analysis: forensicJSON,
      pipeline: {
        checksum: generateChecksum(imageBuffer),
        processedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("FORNSVC ERROR:", err);
    return res.status(500).json({
      error: "Internal forensic processing error.",
      details: err.toString(),
    });
  }
}

// Enterprise checksum (tamper-evidence)
function generateChecksum(buffer) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
