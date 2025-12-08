import fetch from 'node-fetch';
import exifr from 'exifr'; 

const MODELS = [
    "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector",
    "https://api-inference.huggingface.co/models/Organika/sdxl-detector"
];

// Retry configuration
const MAX_RETRIES = 5;
const RETRY_DELAY = 3000; // 3 seconds

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        let body = req.body;
        if (typeof body === 'string') try { body = JSON.parse(body); } catch (e) {}
        const { mediaUrl } = body || {};

        if (!mediaUrl) return res.status(400).json({ error: 'No mediaUrl provided' });

        // 1. Fetch Image
        const imgRes = await fetch(mediaUrl);
        const buffer = Buffer.from(await imgRes.arrayBuffer());

        // 2. Metadata Analysis (The "Camera Check")
        let metadata = {};
        let hasCameraInfo = false;
        try {
            metadata = await exifr.parse(buffer, { tiff: true, xmp: true }).catch(() => ({}));
            // Real photos usually have Make, Model, or ExposureTime
            if (metadata && (metadata.Make || metadata.Model || metadata.ExposureTime)) {
                hasCameraInfo = true;
            }
        } catch (e) { console.warn("Metadata fail", e); }

        // 3. AI Model Query (With Retry Logic)
        let aiScore = 0;
        let modelUsed = "None";
        let rawLog = "Init";

        if (process.env.HF_API_KEY) {
            for (const model of MODELS) {
                const result = await queryModelWithRetry(model, buffer, process.env.HF_API_KEY);
                rawLog = result; // Log what happened
                
                if (result.success) {
                    aiScore = result.score;
                    modelUsed = model;
                    break; // Stop if we got a valid answer
                }
            }
        } else {
            rawLog = "MISSING_HF_API_KEY";
        }

        // 4. HEURISTIC OVERRIDES (The "Safety Net")
        // If AI model failed OR returned low score, BUT there is no camera info...
        // It's likely AI or a Screenshot. We flag it as Suspicious.
        if (aiScore < 0.3 && !hasCameraInfo) {
            aiScore = 0.65; // Force "Suspicious"
            modelUsed = "Heuristic (Missing Camera Data)";
        }

        // 5. Final Report
        return res.status(200).json({
            service: "forensic-service-aggressive",
            timestamp: new Date().toISOString(),
            verdict: {
                aiProbability: aiScore,
                classification: aiScore > 0.5 ? "SYNTHETIC" : "ORGANIC"
            },
            details: {
                aiArtifacts: {
                    confidence: aiScore,
                    detected: aiScore > 0.5,
                    modelUsed: modelUsed,
                    rawResponse: rawLog // Check this in the frontend debug panel
                },
                metadataDump: metadata
            }
        });

    } catch (error) {
        return res.status(500).json({ error: "Forensic Crash", details: error.message });
    }
}

// --- RETRY LOGIC HELPER ---
async function queryModelWithRetry(url, data, key) {
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${key}` },
                method: "POST",
                body: data
            });
            
            const json = await res.json();

            // Case A: Model is loading (Wait and Retry)
            if (json.error && json.error.includes("loading")) {
                console.log(`Model loading... attempt ${i+1}/${MAX_RETRIES}`);
                await new Promise(r => setTimeout(r, RETRY_DELAY));
                continue;
            }

            // Case B: Success (Array)
            if (Array.isArray(json)) {
                const fake = json.find(x => x.label.toLowerCase().includes('artific') || x.label.toLowerCase().includes('fake'));
                return { success: true, score: fake ? fake.score : 0, raw: json };
            }

            // Case C: Other Error
            return { success: false, error: json };

        } catch (e) {
            return { success: false, error: e.message };
        }
    }
    return { success: false, error: "Max retries exceeded" };
}
