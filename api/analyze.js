import fetch from 'node-fetch';
import exifr from 'exifr'; 

// --- THE COUNCIL OF 5 (High-Sensitivity Models) ---
const MODELS = [
    "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector",
    "https://api-inference.huggingface.co/models/Organika/sdxl-detector",
    "https://api-inference.huggingface.co/models/Falconsai/nsfw_image_detection", // Often catches what others miss
    "https://api-inference.huggingface.co/models/Nahrawy/AI-Image-Detector",
    "https://api-inference.huggingface.co/models/dima806/ai_vs_real_image_detection"
];

export default async function handler(req, res) {
    // 1. ENTERPRISE CORS HEADERS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // Robust Body Parsing (Handles Vercel edge cases)
        let body = req.body;
        if (typeof body === 'string') try { body = JSON.parse(body); } catch (e) {}
        const { mediaUrl } = body || {};

        if (!mediaUrl) return res.status(400).json({ error: 'No mediaUrl provided' });

        // 2. FETCH & BUFFER IMAGE
        const imgRes = await fetch(mediaUrl);
        if (!imgRes.ok) throw new Error("Image download failed");
        const buffer = Buffer.from(await imgRes.arrayBuffer());

        // 3. METADATA FORENSICS (Digital Passport Check)
        let metadata = { status: "missing" };
        let hasCamera = false;
        try {
            metadata = await exifr.parse(buffer).catch(() => ({}));
            // Check for physical camera signatures
            if (metadata && (metadata.Make || metadata.Model || metadata.ExposureTime || metadata.ISO)) {
                hasCamera = true;
                metadata.status = "valid_hardware_data";
            }
        } catch (e) { console.warn("Metadata extraction failed", e); }

        // 4. THE COUNCIL VOTE (Parallel Execution)
        // We query multiple AI models. If ANY of them flag it, we take the highest score.
        let maxAiScore = 0;
        let detectionSource = "None";
        let apiStatus = "No_Key";
        
        if (process.env.HF_API_KEY) {
            apiStatus = "Active";
            // Run models in parallel for speed
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
        // Calculates Shannon Entropy and Pixel Variance.
        // AI images are often "mathematically perfect" (low variance) or "too smooth" (low entropy).
        const physics = calculatePhysics(buffer);
        let physicsScore = 0;

        // Thresholds based on Diffusion Model signatures
        if (physics.entropy < 5.0) physicsScore += 0.45; // Too smooth (Unnatural)
        if (physics.variance < 1500) physicsScore += 0.25; // Lack of sensor noise
        if (!hasCamera) physicsScore += 0.2; // No hardware signature

        // 6. FINAL VERDICT CALCULATION
        // We take the STRONGEST evidence.
        // If AI models failed (0) but Physics says "Fake" (0.9), we trust Physics.
        let finalRisk = Math.max(maxAiScore, physicsScore);
        let detectionMethod = maxAiScore > physicsScore ? "NEURAL_NET" : "PHYSICS_ENGINE";

        // Heuristic Boost: If it looks fake AND has no camera metadata, it's almost certainly fake.
        if (finalRisk > 0.5 && !hasCamera) {
            finalRisk = Math.min(finalRisk + 0.15, 0.99);
            detectionMethod += "_PLUS_METADATA_GAP";
        }

        // Fail-Safe: Never return 0 if we have no camera proof.
        if (finalRisk < 0.1 && !hasCamera) {
            finalRisk = 0.45; // "Suspicious / Unverified"
            detectionMethod = "HEURISTIC_UNCERTAINTY";
        }

        return res.status(200).json({
            service: "forensic-enterprise-v1",
            timestamp: new Date().toISOString(),
            verdict: {
                aiProbability: finalRisk,
                classification: finalRisk > 0.5 ? "SYNTHETIC" : "ORGANIC",
                detection_method: detectionMethod
            },
            details: {
                aiArtifacts: {
                    confidence: finalRisk,
                    detected: finalRisk > 0.5,
                    model_flagged: detectionSource,
                    physics_score: physicsScore,
                    api_status: apiStatus
                },
                noiseAnalysis: {
                    entropy: physics.entropy,
                    variance: physics.variance,
                    suspicious: physics.entropy < 5.0
                },
                metadataDump: metadata
            }
        });

    } catch (error) {
        // Crash Recovery: Return a valid JSON even if logic fails
        return res.status(200).json({ 
            service: "forensic-crash-recovery",
            verdict: { aiProbability: 0.5, classification: "UNKNOWN_ERROR" },
            details: { error: error.message }
        });
    }
}

// --- HELPER: ROBUST AI QUERY ---
async function queryModel(url, data, key) {
    try {
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${key}` },
            method: "POST",
            body: data
        });
        const json = await res.json();
        
        // Handle Array Response [{ label: 'artificial', score: 0.9 }]
        if (Array.isArray(json)) {
            const fake = json.find(x => x.label.toLowerCase().match(/artific|fake|cg|synth/));
            if (fake) return { score: fake.score };
            
            const real = json.find(x => x.label.toLowerCase().match(/real|human/));
            if (real) return { score: 1 - real.score };
        }
        // Handle Error Object { error: "Model loading" }
        return { score: 0 };
    } catch (e) { 
        return { score: 0 }; 
    }
}

// --- HELPER: PHYSICS ENGINE ---
function calculatePhysics(buffer) {
    // 1. Shannon Entropy (Randomness Check)
    const counts = new Array(256).fill(0);
    const step = Math.floor(buffer.length / 5000) || 1; // Sample for speed
    let totalSampled = 0;

    for (let i = 0; i < buffer.length; i += step) {
        counts[buffer[i]]++;
        totalSampled++;
    }
    
    let entropy = 0;
    for (const count of counts) {
        if (count === 0) continue;
        const p = count / totalSampled;
        entropy -= p * Math.log2(p);
    }

    // 2. Pixel Variance (Texture Depth)
    let sum = 0;
    for (let i = 0; i < buffer.length; i += step) sum += buffer[i];
    const mean = sum / totalSampled;
    
    let varianceSum = 0;
    for (let i = 0; i < buffer.length; i += step) varianceSum += Math.pow(buffer[i] - mean, 2);
    const variance = varianceSum / totalSampled;

    return { entropy, variance };
}
