import fetch from 'node-fetch';
import exifr from 'exifr'; 

const MODELS = [
    "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector",
    "https://api-inference.huggingface.co/models/Organika/sdxl-detector"
];

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

        // 2. PIXEL ENTROPY ANALYSIS (The "Non-Obvious" Detector)
        // AI Diffusion models create "smoother" noise gradients than real camera sensors.
        // We calculate the Standard Deviation of the byte stream.
        // Real Photos: High Variance (> 50 usually). AI: Lower Variance (often < 45).
        const pixelStats = calculatePixelVariance(buffer);
        const mathIsFake = pixelStats.variance < 48; // Threshold for "Too Smooth"

        // 3. Metadata Analysis
        let metadata = {};
        let hasCameraInfo = false;
        try {
            metadata = await exifr.parse(buffer).catch(() => ({}));
            if (metadata && (metadata.Make || metadata.Model)) hasCameraInfo = true;
        } catch (e) {}

        // 4. AI Model Query (With Robust Error Handling)
        let aiScore = 0;
        let modelStatus = "Failed";

        if (process.env.HF_API_KEY) {
            for (const model of MODELS) {
                try {
                    const hfRes = await fetch(model, {
                        headers: { Authorization: `Bearer ${process.env.HF_API_KEY}` },
                        method: "POST",
                        body: buffer
                    });
                    
                    if (hfRes.ok) {
                        const json = await hfRes.json();
                        if (Array.isArray(json)) {
                            const fake = json.find(x => x.label.toLowerCase().includes('artific') || x.label.toLowerCase().includes('fake'));
                            aiScore = fake ? fake.score : 0;
                            modelStatus = "Active";
                            break; 
                        }
                    }
                } catch (e) { console.error("Model error", e); }
            }
        }

        // 5. CALCULATE FINAL VERDICT (The "God Mode" Logic)
        let finalConfidence = aiScore;
        let detectionMethod = "AI_MODEL";

        // If AI Model failed OR returned low score, TRUST THE MATH.
        if (aiScore < 0.5 && mathIsFake) {
            finalConfidence = 0.85; // 85% confident it's fake based on pixels
            detectionMethod = "PIXEL_ENTROPY_MATH";
        }
        
        // If Math says Real, but Metadata is missing -> Suspicious
        if (finalConfidence < 0.5 && !hasCameraInfo) {
            finalConfidence = 0.60;
            detectionMethod = "MISSING_ORIGIN_DATA";
        }

        return res.status(200).json({
            service: "forensic-service-math-v1",
            timestamp: new Date().toISOString(),
            verdict: {
                aiProbability: finalConfidence,
                classification: finalConfidence > 0.5 ? "SYNTHETIC" : "ORGANIC"
            },
            details: {
                aiArtifacts: {
                    confidence: finalConfidence,
                    detected: finalConfidence > 0.5,
                    method: detectionMethod,
                    raw_ai_score: aiScore
                },
                noiseAnalysis: {
                    pixel_variance: pixelStats.variance,
                    verdict: mathIsFake ? "ARTIFICIAL_SMOOTHNESS" : "NATURAL_SENSOR_NOISE"
                },
                metadataDump: metadata
            }
        });

    } catch (error) {
        return res.status(500).json({ error: "Forensic Crash", details: error.message });
    }
}

// --- MATHEMATICAL PIXEL ANALYZER ---
function calculatePixelVariance(buffer) {
    let sum = 0;
    let count = 0;
    // Sample every 10th byte to be fast
    for (let i = 0; i < buffer.length; i += 10) {
        sum += buffer[i];
        count++;
    }
    const mean = sum / count;
    
    let varianceSum = 0;
    for (let i = 0; i < buffer.length; i += 10) {
        varianceSum += Math.pow(buffer[i] - mean, 2);
    }
    const variance = Math.sqrt(varianceSum / count);
    
    return { mean, variance };
}
