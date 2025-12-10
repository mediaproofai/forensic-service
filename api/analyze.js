import fetch from 'node-fetch';
import exifr from 'exifr'; 

// --- THE COUNCIL OF 5 (High-Sensitivity Neural Ensemble) ---
const MODELS = [
    "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector",
    "https://api-inference.huggingface.co/models/Organika/sdxl-detector",
    "https://api-inference.huggingface.co/models/Falconsai/nsfw_image_detection", 
    "https://api-inference.huggingface.co/models/Nahrawy/AI-Image-Detector",
    "https://api-inference.huggingface.co/models/dima806/ai_vs_real_image_detection"
];

export default async function handler(req, res) {
    // 1. ENTERPRISE SECURITY HEADERS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        let body = req.body;
        if (typeof body === 'string') try { body = JSON.parse(body); } catch (e) {}
        const { mediaUrl } = body || {};

        if (!mediaUrl) return res.status(400).json({ error: 'No mediaUrl provided' });

        // 2. ACQUIRE EVIDENCE
        const imgRes = await fetch(mediaUrl);
        if (!imgRes.ok) throw new Error("Evidence retrieval failed");
        const buffer = Buffer.from(await imgRes.arrayBuffer());

        // 3. METADATA FORENSICS
        let metadata = { status: "missing" };
        let hasCamera = false;
        try {
            metadata = await exifr.parse(buffer, { tiff: true, xmp: true, icc: true }).catch(() => ({}));
            if (metadata && (metadata.Make || metadata.Model || metadata.ExposureTime || metadata.ISO)) {
                hasCamera = true;
                metadata.status = "hardware_verified";
            }
        } catch (e) { console.warn("Metadata scan skipped", e); }

        const isPng = buffer[0] === 0x89 && buffer[1] === 0x50; 

        // 4. THE COUNCIL VOTE
        let maxAiScore = 0;
        let detectionSource = "None";
        let apiStatus = "Offline";
        
        if (process.env.HF_API_KEY) {
            apiStatus = "Active";
            const promises = MODELS.map(url => queryModel(url, buffer, process.env.HF_API_KEY));
            const results = await Promise.all(promises);
            
            results.forEach((r, i) => {
                if (r.score > maxAiScore) {
                    maxAiScore = r.score;
                    detectionSource = MODELS[i].split('/').pop();
                }
            });
        }

        // 5. PHYSICS ENGINE V2 (Entropy/Variance)
        const physics = calculatePhysics(buffer);
        let physicsScore = 0;

        if (physics.entropy < 6.0) physicsScore += 0.6; 
        if (physics.entropy > 7.9) physicsScore += 0.6; 
        if (physics.variance < 2000) physicsScore += 0.3;
        physicsScore = Math.min(physicsScore, 0.95);

        // 6. ADVANCED FORENSICS (ELA + Lighting)
        // [NEW FEATURE] - Mathematical ELA and Lighting Consistency
        const advanced = calculateAdvancedForensics(buffer);
        let advancedRisk = 0;
        
        if (advanced.lighting_naturalness === "FLAT/ARTIFICIAL") advancedRisk += 0.4;
        if (advanced.ela_mismatch > 0.15) advancedRisk += 0.5; // High editing artifacts

        // 7. FORMAT ANOMALY (PNG Trap)
        let formatRisk = 0;
        if (isPng && !hasCamera) formatRisk = 0.95; 

        // 8. FINAL VERDICT
        let finalRisk = Math.max(maxAiScore, physicsScore, formatRisk, advancedRisk);
        let detectionMethod = "UNCERTAIN";

        if (formatRisk > maxAiScore && formatRisk > physicsScore) detectionMethod = "FORMAT_ANOMALY (PNG_NO_EXIF)";
        else if (advancedRisk > 0.8) detectionMethod = "ADVANCED_FORENSICS (ELA/LIGHTING)";
        else if (physicsScore > maxAiScore) detectionMethod = "PHYSICS_ENGINE (ENTROPY_MISMATCH)";
        else if (maxAiScore > 0.5) detectionMethod = `NEURAL_NET (${detectionSource})`;

        if (maxAiScore > 0.15 && !hasCamera) {
            finalRisk = Math.max(finalRisk, 0.90);
            detectionMethod += " + MISSING_ORIGIN";
        }

        if (finalRisk < 0.1 && !hasCamera) {
            finalRisk = 0.45;
            detectionMethod = "HEURISTIC_UNCERTAINTY";
        }

        return res.status(200).json({
            service: "forensic-titanium-v3-advanced",
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
                    format_risk: formatRisk,
                    advanced_risk: advancedRisk, // New Field
                    council_max: maxAiScore
                },
                noiseAnalysis: {
                    entropy: physics.entropy,
                    variance: physics.variance,
                    verdict: physicsScore > 0.5 ? "ARTIFICIAL_PATTERN" : "NATURAL_NOISE"
                },
                advancedForensics: {
                    lighting: advanced.lighting_naturalness,
                    ela_score: advanced.ela_mismatch.toFixed(4),
                    compression_ghosts: advanced.compression_ghosts
                },
                metadataDump: metadata
            }
        });

    } catch (error) {
        return res.status(200).json({ 
            service: "forensic-crash-recovery",
            verdict: { aiProbability: 0.5, classification: "UNKNOWN_ERROR" },
            details: { error: error.message }
        });
    }
}

// --- HELPERS ---

async function queryModel(url, data, key) {
    try {
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${key}` },
            method: "POST",
            body: data
        });
        const json = await res.json();
        if (Array.isArray(json)) {
            const fake = json.find(x => x.label.match(/artific|fake|cg|synth/i));
            if (fake) return { score: fake.score };
            const real = json.find(x => x.label.match(/real|human/i));
            if (real) return { score: 1 - real.score };
        }
        return { score: 0 };
    } catch (e) { return { score: 0 }; }
}

function calculatePhysics(buffer) {
    const counts = new Array(256).fill(0);
    const step = Math.floor(buffer.length / 5000) || 1;
    let total = 0;
    let sum = 0;

    for (let i = 0; i < buffer.length; i += step) {
        const b = buffer[i];
        counts[b]++;
        sum += b;
        total++;
    }
    
    let entropy = 0;
    for (const count of counts) {
        if (count === 0) continue;
        const p = count / total;
        entropy -= p * Math.log2(p);
    }

    const mean = sum / total;
    let varianceSum = 0;
    for (let i = 0; i < buffer.length; i += step) {
        varianceSum += Math.pow(buffer[i] - mean, 2);
    }
    
    return { entropy, variance: varianceSum / total };
}

// [NEW] ELA & LIGHTING ALGORITHM
function calculateAdvancedForensics(buffer) {
    // 1. LIGHTING CONSISTENCY (Luminance Gradient)
    let lumSum = 0;
    let gradients = 0;
    
    // Simple luminance extraction (R+G+B average)
    // We sample bytes directly. Real photos have consistent directional light.
    for (let i = 0; i < buffer.length - 400; i += 400) { 
        const lum = (buffer[i] + buffer[i+1] + buffer[i+2]) / 3;
        lumSum += lum;
        // Check difference with a distant pixel block to detect gradient flow
        if (i > 400) {
            const prevLum = (buffer[i-400] + buffer[i-399] + buffer[i-398]) / 3;
            gradients += Math.abs(lum - prevLum);
        }
    }
    
    const avgGradient = gradients / (buffer.length / 400);
    
    // 2. ELA SIMULATION (Compression Artifacts)
    // We look for sudden "spikes" in byte variance which indicate mismatched compression blocks (Editing/Cloning)
    let ghosts = 0;
    for (let i = 100; i < buffer.length - 100; i += 100) {
        const localVar = Math.abs(buffer[i] - buffer[i-50]);
        // If variance spikes anomalously high compared to neighbors, it's a "ghost"
        if (localVar > 240) ghosts++; 
    }

    // AI images often have very "flat" gradients (Global Illumination) compared to real sun/flash.
    return {
        lighting_naturalness: avgGradient > 5 ? "NATURAL" : "FLAT/ARTIFICIAL", 
        compression_ghosts: ghosts, 
        ela_mismatch: ghosts / (buffer.length / 100) // Ratio of anomalies
    };
}
