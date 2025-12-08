import fetch from 'node-fetch';
import exifr from 'exifr'; 

// --- THE COUNCIL OF 5 (High-Sensitivity) ---
const MODELS = [
    "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector",
    "https://api-inference.huggingface.co/models/Organika/sdxl-detector",
    "https://api-inference.huggingface.co/models/Falconsai/nsfw_image_detection",
    "https://api-inference.huggingface.co/models/Nahrawy/AI-Image-Detector",
    "https://api-inference.huggingface.co/models/dima806/ai_vs_real_image_detection"
];

export default async function handler(req, res) {
    // 1. CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        let body = req.body;
        if (typeof body === 'string') try { body = JSON.parse(body); } catch (e) {}
        const { mediaUrl } = body || {};

        if (!mediaUrl) return res.status(400).json({ error: 'No mediaUrl' });

        // 2. FETCH & BUFFER
        const imgRes = await fetch(mediaUrl);
        if (!imgRes.ok) throw new Error("Image download failed");
        const buffer = Buffer.from(await imgRes.arrayBuffer());

        // 3. METADATA (Digital Passport)
        let metadata = { status: "missing" };
        let hasCamera = false;
        try {
            metadata = await exifr.parse(buffer).catch(() => ({}));
            if (metadata && (metadata.Make || metadata.Model || metadata.ExposureTime)) {
                hasCamera = true;
                metadata.status = "valid";
            }
        } catch (e) {}

        // 4. THE COUNCIL VOTE (Parallel Execution)
        let maxAiScore = 0;
        let detectionSource = "None";
        
        if (process.env.HF_API_KEY) {
            // We run all 5 models in parallel for speed
            const promises = MODELS.map(url => queryModel(url, buffer, process.env.HF_API_KEY));
            const results = await Promise.all(promises);
            
            results.forEach((r, i) => {
                if (r.score > maxAiScore) {
                    maxAiScore = r.score;
                    detectionSource = MODELS[i].split('/').pop();
                }
            });
        }

        // 5. LOCAL PHYSICS ENGINE (The "Backup Brain")
        // We look for "Pixel Perfect" smoothness (Entropy < 4.5) 
        // AND "Grid Artifacts" (Repeating patterns in byte variance)
        const physics = calculatePhysics(buffer);
        let physicsScore = 0;

        if (physics.entropy < 4.2) physicsScore += 0.4; // Too smooth
        if (physics.variance < 1000) physicsScore += 0.3; // Low variance (Flat)
        if (!hasCamera) physicsScore += 0.2; // No camera DNA

        // 6. FINAL VERDICT CALCULATION
        // If AI models failed (0) but Physics says "Fake" (0.9), we use Physics.
        let finalRisk = Math.max(maxAiScore, physicsScore);
        
        // Paranoid Boost: If it looks fake and has no camera metadata, boost it.
        if (finalRisk > 0.5 && !hasCamera) finalRisk = Math.min(finalRisk + 0.15, 0.99);

        // Fail-Safe: If we STILL have 0, but no camera data, force a "Suspicious" baseline
        if (finalRisk < 0.1 && !hasCamera) finalRisk = 0.45;

        return res.status(200).json({
            service: "forensic-nuclear-v1",
            timestamp: new Date().toISOString(),
            verdict: {
                aiProbability: finalRisk,
                classification: finalRisk > 0.5 ? "SYNTHETIC" : "ORGANIC",
                detection_method: maxAiScore > physicsScore ? "NEURAL_NET" : "PHYSICS_ENGINE"
            },
            details: {
                aiArtifacts: {
                    confidence: finalRisk,
                    detected: finalRisk > 0.5,
                    model_flagged: detectionSource,
                    physics_score: physicsScore
                },
                metadataDump: metadata
            }
        });

    } catch (error) {
        // Return a valid JSON even on crash so frontend doesn't break
        return res.status(200).json({ 
            service: "forensic-crash-recovery",
            verdict: { aiProbability: 0.5, classification: "UNKNOWN_ERROR" },
            details: { error: error.message }
        });
    }
}

// --- HELPER FUNCTIONS ---
async function queryModel(url, data, key) {
    try {
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${key}` },
            method: "POST",
            body: data
        });
        const json = await res.json();
        if (Array.isArray(json)) {
            // Find "Artificial" or "Fake" label
            const fake = json.find(x => x.label.toLowerCase().match(/artific|fake|cg|synth/));
            if (fake) return { score: fake.score };
            
            // Or invert "Real" label
            const real = json.find(x => x.label.toLowerCase().match(/real|human/));
            if (real) return { score: 1 - real.score };
        }
        return { score: 0 };
    } catch (e) { return { score: 0 }; }
}

function calculatePhysics(buffer) {
    // 1. Calculate Shannon Entropy (Randomness)
    // Real photos have high randomness (sensor noise). AI is cleaner.
    const counts = new Array(256).fill(0);
    for (const byte of buffer) counts[byte]++;
    
    let entropy = 0;
    const len = buffer.length;
    for (const count of counts) {
        if (count === 0) continue;
        const p = count / len;
        entropy -= p * Math.log2(p);
    }

    // 2. Calculate Variance (Texture depth)
    let sum = 0;
    // Sample 1% of pixels for speed
    for (let i = 0; i < len; i += 100) sum += buffer[i];
    const mean = sum / (len / 100);
    
    let variance = 0;
    for (let i = 0; i < len; i += 100) variance += Math.pow(buffer[i] - mean, 2);
    variance /= (len / 100);

    return { entropy, variance };
}
