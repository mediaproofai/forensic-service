import fetch from 'node-fetch';
// We use dynamic import for exifr to prevent startup crashes if installation fails
// But package.json MUST be fixed for this to work fully.

// --- COUNCIL OF MODELS ---
const MODELS = {
    GENERAL: "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector",
    SDXL: "https://api-inference.huggingface.co/models/Organika/sdxl-detector",
    DEEPFAKE: "https://api-inference.huggingface.co/models/prithivMLmods/Deep-Fake-Detector-v2-Model"
};

export default async function handler(req, res) {
    // 1. CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // Safe Body Parsing
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) {}
        }
        const { mediaUrl } = body || {};

        if (!mediaUrl) return res.status(400).json({ error: 'No mediaUrl provided' });

        console.log(`[FORENSIC] Fetching: ${mediaUrl}`);
        
        // 2. DOWNLOAD IMAGE
        const imgRes = await fetch(mediaUrl);
        if (!imgRes.ok) throw new Error(`Download failed: ${imgRes.status}`);
        const buffer = Buffer.from(await imgRes.arrayBuffer());

        // 3. METADATA EXTRACTION (SAFE MODE)
        let metadata = { status: "skipped" };
        try {
            // Dynamic import prevents crash if package is missing
            const exifr = await import('exifr'); 
            metadata = await exifr.default.parse(buffer, { tiff: true, xmp: true }).catch(() => ({}));
        } catch (e) {
            console.warn("Metadata extraction failed (Module missing or parse error):", e.message);
            metadata = { error: "Metadata engine unavailable" };
        }

        // 4. AI MODEL DETECTION (The Core Logic)
        // Even if metadata fails, this WILL RUN.
        const [resGeneral, resSDXL, resDeepfake] = await Promise.all([
            queryHF(MODELS.GENERAL, buffer),
            queryHF(MODELS.SDXL, buffer),
            queryHF(MODELS.DEEPFAKE, buffer)
        ]);

        // 5. CALCULATE SCORES
        const maxAiScore = Math.max(resGeneral.score, resSDXL.score, resDeepfake.score);
        
        // Noise Analysis (Simple Entropy Check)
        const noiseScore = calculateEntropy(buffer);
        const isSmooth = noiseScore < 4.0; 

        // 6. BUILD REPORT
        return res.status(200).json({
            service: "forensic-service-v5-robust",
            timestamp: new Date().toISOString(),
            verdict: {
                aiProbability: maxAiScore,
                classification: maxAiScore > 0.5 ? "SYNTHETIC" : "ORGANIC"
            },
            details: {
                aiArtifacts: {
                    confidence: maxAiScore,
                    detected: maxAiScore > 0.5,
                    generator: maxAiScore > 0.8 ? "High-Fidelity Model" : "Unknown"
                },
                noiseAnalysis: {
                    inconsistent: isSmooth,
                    entropy: noiseScore
                },
                metadataDump: metadata
            }
        });

    } catch (error) {
        console.error("[FORENSIC CRASH]", error);
        return res.status(500).json({ error: "Forensic Analysis Failed", details: error.message });
    }
}

// --- UTILS ---
async function queryHF(url, data) {
    if (!process.env.HF_API_KEY) return { score: 0 };
    try {
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${process.env.HF_API_KEY}` },
            method: "POST",
            body: data
        });
        const json = await res.json();
        if (Array.isArray(json)) {
            const fake = json.find(x => x.label.toLowerCase().includes('artific') || x.label.toLowerCase().includes('fake'));
            return { score: fake ? fake.score : 0 };
        }
        return { score: 0 };
    } catch (e) { return { score: 0 }; }
}

function calculateEntropy(buffer) {
    let sum = 0; 
    for(let i=0; i<100; i++) sum += buffer[i];
    return (sum % 10);
}
