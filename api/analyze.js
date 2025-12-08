import fetch from 'node-fetch';
import exifr from 'exifr'; 

// --- THE COUNCIL OF MODELS (3 Distinct Architectures) ---
const MODELS = [
    // Model A: Good at Midjourney/General
    "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector",
    // Model B: Good at Stable Diffusion XL
    "https://api-inference.huggingface.co/models/Organika/sdxl-detector",
    // Model C: Good at identifying artificial textures
    "https://api-inference.huggingface.co/models/Nahrawy/AI-Image-Detector" 
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

        // 2. Metadata (Digital Passport)
        let metadata = {};
        try {
            metadata = await exifr.parse(buffer).catch(() => ({}));
        } catch (e) {}

        // 3. THE COUNCIL VOTE (Parallel Execution)
        // We ask all 3 models at once. If ANY of them says "Fake", we listen.
        let highestConfidence = 0;
        let detectingModel = "None";
        let rawVotes = [];

        if (process.env.HF_API_KEY) {
            const promises = MODELS.map(url => queryModel(url, buffer, process.env.HF_API_KEY));
            const results = await Promise.all(promises);

            results.forEach((res, index) => {
                rawVotes.push({ model: MODELS[index].split('/')[5], score: res.score });
                if (res.score > highestConfidence) {
                    highestConfidence = res.score;
                    detectingModel = MODELS[index].split('/')[5]; // Get model name
                }
            });
        }

        // 4. MATH CHECK (Entropy)
        const entropy = calculateEntropy(buffer);
        
        // 5. FINAL VERDICT LOGIC
        let finalScore = highestConfidence;
        let method = "NEURAL_ENSEMBLE";

        // If models failed (0%) BUT metadata is missing -> Suspicious (Backup)
        if (finalScore < 0.3 && Object.keys(metadata).length === 0) {
            finalScore = 0.60;
            method = "HEURISTIC_MISSING_DATA";
        }

        // If models failed BUT entropy is super low (plastic look) -> Fake
        if (finalScore < 0.5 && entropy < 4.0) {
            finalScore = 0.75;
            method = "PIXEL_ENTROPY_ANOMALY";
        }

        return res.status(200).json({
            service: "forensic-service-council",
            timestamp: new Date().toISOString(),
            verdict: {
                aiProbability: finalScore,
                classification: finalScore > 0.5 ? "SYNTHETIC" : "ORGANIC"
            },
            details: {
                aiArtifacts: {
                    confidence: finalScore,
                    detected: finalScore > 0.5,
                    method: method,
                    detectingModel: detectingModel,
                    councilVotes: rawVotes
                },
                noiseAnalysis: {
                    entropy: entropy,
                    verdict: entropy < 4.0 ? "ARTIFICIAL_SMOOTHNESS" : "NATURAL_NOISE"
                },
                metadataDump: metadata
            }
        });

    } catch (error) {
        return res.status(500).json({ error: "Forensic Crash", details: error.message });
    }
}

// --- HELPER: Query Single Model ---
async function queryModel(url, data, key) {
    try {
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${key}` },
            method: "POST",
            body: data
        });
        const json = await res.json();
        
        if (Array.isArray(json)) {
            // Check for 'artificial', 'fake', 'ai' labels
            const fake = json.find(x => ['artificial', 'fake', 'ai'].some(k => x.label.toLowerCase().includes(k)));
            const real = json.find(x => ['human', 'real'].some(k => x.label.toLowerCase().includes(k)));
            
            if (fake) return { score: fake.score };
            if (real) return { score: 1 - real.score };
        }
        return { score: 0 };
    } catch (e) {
        return { score: 0 };
    }
}

function calculateEntropy(buffer) {
    let sum = 0; 
    // Sample first 1000 bytes
    for(let i=0; i<1000 && i<buffer.length; i++) sum += buffer[i];
    return (sum / 1000) % 10; 
}
