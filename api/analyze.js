import { runForensicPipeline } from "../lib/inference.js";

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "10mb"
  }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Only POST allowed"
    });
  }

  try {
    const buffer = await readBinary(req);

    if (!buffer || buffer.length < 100) {
      return res.status(400).json({
        ok: false,
        error: "Invalid image data"
      });
    }

    const report = await runForensicPipeline(buffer);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(report);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Internal forensic engine error",
      details: e.message
    });
  }
}

// ---- Helper: Read binary stream ----
async function readBinary(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
