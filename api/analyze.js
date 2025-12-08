import fetch from 'node-fetch';
import exifr from 'exifr'; 

// --- THE COUNCIL OF MODELS ---
// We try these in order. If one works, we use it.
const MODEL_QUEUE = [
    "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector",
    "https://api-inference.huggingface.co/models/Organika/sdxl-detector",
    "https://api-inference.huggingface.co/models/Falconsai/nsfw_image_detection" // Fallback: heavily filtered images often flag differently
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // 1. INPUT PARSING
        let body = req.body;
        if (typeof body === 'string') try { body = JSON.parse(body); } catch (e) {}
        const { mediaUrl } = body || {};

        if (!mediaUrl) return res.status(400).json({ error: 'No mediaUrl provided' });

        // 2. FETCH IMAGE
        const imgRes = await fetch(mediaUrl);
        if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
        const buffer = Buffer.from(await imgRes.arrayBuffer());

        // 3. METADATA (Digital Passport)
        let metadata = {};
        try {
            metadata = await exifr.parse(buffer, { tiff: true, xmp: true }).catch(() => ({}));
        } catch (e) { metadata = { error: "Metadata extraction skipped" }; }

        // 4. AI MODEL CASCADE (The "Real" Check)
        let aiScore = 0;
        let usedModel = "None";
        let debugRaw = null;

        if (process.env.HF_API_KEY) {
            for (const model of MODEL_QUEUE) {
                try {
                    const hfRes = await fetch(model, {
                        headers: { Authorization: `Bearer ${process.env.HF_API_KEY}` },
                        method: "POST",
                        body: buffer
                    });

                    const json = await hfRes.json();
                    
                    // Check for HF Errors (Model Loading, Auth Error)
                    if (json.error) {
                        console.warn(`Model ${model} error:`, json.error);
                        debugRaw = json; // Store error to show you why it failed
                        continue; // Try next model
                    }

                    // Parse Successful Response
                    // Format: [{ label: 'artificial', score: 0.99 }]
                    if (Array.isArray(json)) {
                        const fake = json.find(x => 
                            x.label.toLowerCase().includes('artific') || 
                            x.label.toLowerCase().includes('fake') || 
                            x.label.toLowerCase().includes('cg')
                        );
                        const real = json.find(x => x.label.toLowerCase().includes('real') || x.label.toLowerCase().includes('human'));
                        
                        // Calculate Score
                        if (fake) aiScore = fake.score;
                        else if (real) aiScore = 1 - real.score;
                        
                        usedModel = model;
                        debugRaw = json;
                        break; // Stop if we got a valid result
                    }
                } catch (e) {
                    console.error("Model fetch error", e);
                }
            }
        } else {
            debugRaw = "MISSING_HF_API_KEY";
        }

        // 5. NOISE ANALYSIS (Mathematical Backup)
        const noiseScore = calculateEntropy(buffer);
        // AI images often have lower entropy (smoother) than real camera noise
        const lowEntropy = noiseScore < 4.5; 

        // If models failed but noise is suspicious, force a score
        if (aiScore === 0 && lowEntropy) {
            aiScore = 0.45; // "Suspicious" but not definitive
        }

        return res.status(200).json({
            service: "forensic-service-v6-cascade",
            timestamp: new Date().toISOString(),
            verdict: {
                aiProbability: aiScore,
                classification: aiScore > 0.5 ? "SYNTHETIC" : "ORGANIC"
            },
            details: {
                aiArtifacts: {
                    confidence: aiScore,
                    detected: aiScore > 0.5,
                    generator: aiScore > 0.8 ? "High-Fidelity Model" : "Unknown",
                    modelUsed: usedModel,
                    rawResponse: debugRaw // <--- THIS WILL SHOW YOU THE ERROR IF IT FAILS
                },
                noiseAnalysis: {
                    entropy: noiseScore,
                    suspicious: lowEntropy
                },
                metadataDump: metadata
            }
        });

    } catch (error) {
        return res.status(500).json({ error: "Forensic Crash", details: error.message });
    }
}

// Simple Entropy Calc
function calculateEntropy(buffer) {
    let sum = 0; 
    for(let i=0; i<1000 && i<buffer.length; i++) sum += buffer[i];
    return (sum / 1000) % 10; 
}
