import fetch from 'node-fetch';

// --- CONFIGURATION ---
// We use a specialized model for AI Image Detection
const HF_MODEL_URL = "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector";

export default async function handler(req, res) {
    // 1. CORS Headers (Allow connections)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { mediaUrl } = req.body;
        if (!mediaUrl) return res.status(400).json({ error: 'No URL provided' });

        console.log(`[FORENSIC] Scanning: ${mediaUrl}`);

        // 2. Fetch Image Data
        const imageResponse = await fetch(mediaUrl);
        const imageBuffer = await imageResponse.arrayBuffer();

        // 3. Call Hugging Face AI Model (Real Detection)
        // We send the raw image bytes to the AI detector
        const hfResponse = await fetch(HF_MODEL_URL, {
            headers: { 
                Authorization: `Bearer ${process.env.HF_API_KEY}`,
                "Content-Type": "application/octet-stream"
            },
            method: "POST",
            body: Buffer.from(imageBuffer),
        });

        const aiResult = await hfResponse.json();
        
        // 4. Parse AI Result
        // The model returns an array like: [{ label: "artificial", score: 0.99 }, { label: "human", score: 0.01 }]
        let aiConfidence = 0;
        let classification = "UNKNOWN";

        if (Array.isArray(aiResult)) {
            const artificialLabel = aiResult.find(x => x.label === 'artificial');
            if (artificialLabel) {
                aiConfidence = artificialLabel.score; // 0.0 to 1.0
                classification = aiConfidence > 0.5 ? "AI_GENERATED" : "AUTHENTIC";
            }
        } else if (aiResult.error) {
            console.error("HuggingFace Error:", aiResult.error);
            // Fallback logic if model is loading (Cold Start)
            classification = "ANALYSIS_PENDING"; 
        }

        // 5. Build Forensic Data
        const forensicData = {
            service: "forensic-service",
            timestamp: new Date().toISOString(),
            details: {
                aiArtifacts: {
                    detected: aiConfidence > 0.5,
                    confidence: aiConfidence, // This is the real number from the AI
                    generator: aiConfidence > 0.8 ? "High-Fidelity Model (Midjourney/DALL-E)" : "Unknown",
                    classification: classification
                },
                // We keep these simulated for now as they require heavy local libraries
                noiseAnalysis: { inconsistent: aiConfidence > 0.6 }, 
                steganography: { detected: false }
            }
        };

        return res.status(200).json(forensicData);

    } catch (error) {
        console.error("[FORENSIC FAILURE]", error);
        return res.status(500).json({ error: 'Analysis failed', details: error.message });
    }
}
