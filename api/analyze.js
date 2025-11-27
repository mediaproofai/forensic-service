// api/analyze.js
// Minimal Node Serverless handler that ALWAYS logs and returns JSON.
// This is a DEBUG helper to ensure Vercel runs your function and produces logs.

module.exports = async function handler(req, res) {
  try {
    console.log("analyze invoked", { method: req.method, headers: req.headers ? Object.keys(req.headers) : null });

    if (req.method === "GET") {
      console.log("GET health called");
      return res.status(200).json({ ok: true, note: "health ok" });
    }

    // Read body (works for JSON)
    let body = req.body;
    if (!body) {
      try {
        body = await new Promise((resolve, reject) => {
          let d = "";
          req.on("data", (c) => (d += c));
          req.on("end", () => resolve(d ? JSON.parse(d) : null));
          req.on("error", reject);
        });
      } catch (e) {
        body = null;
      }
    }

    console.log("Request body (truncated):", typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body || {}).slice(0,200));

    // Safety response
    return res.status(200).json({ ok: true, received: !!body, sampleHeader: req.headers["x-worker-secret"] || null });
  } catch (err) {
    console.error("handler error:", err);
    return res.status(500).json({ error: "internal", message: String(err) });
  }
};

