// Minimal forensic service - /analyze accepts { filename, mimetype, data (base64) OR url }
const express = require('express');
const bodyParser = require('body-parser');
const sharp = require('sharp');
const exifr = require('exifr');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json({ limit: '200mb' }));

function bufFromBase64(b64){ return Buffer.from(b64, 'base64'); }

async function generateELA(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    const recompr = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
    const origRaw = await sharp(buffer).raw().toBuffer();
    const recRaw = await sharp(recompr).raw().toBuffer();
    const len = Math.min(origRaw.length, recRaw.length);
    const out = Buffer.alloc(len);
    for (let i=0;i<len;i++) out[i] = Math.min(255, Math.abs(origRaw[i]-recRaw[i]) * 8);
    const png = await sharp(out, { raw: { width: meta.width, height: meta.height, channels: meta.channels || 3 } }).png().toBuffer();
    return png.toString('base64');
  } catch (e) { return null; }
}

function pHashSimple(buffer){
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0,16);
}

app.post('/analyze', async (req, res) => {
  try {
    const { filename, mimetype, data, url } = req.body;
    let buffer;
    if (data) buffer = bufFromBase64(data);
    else if (url) {
      const r = await fetch(url);
      if (!r.ok) return res.status(400).json({ error: 'fetch failed' });
      buffer = Buffer.from(await r.arrayBuffer());
    } else return res.status(400).json({ error: 'missing data or url' });

    const exif = await exifr.parse(buffer).catch(()=>null);
    const ela = await generateELA(buffer).catch(()=>null);
    const phash = pHashSimple(buffer);

    // naive forensic score - replace with ML model or rule engine
    let score = 0.5;
    if (ela) score += 0.2;
    if (exif && Object.keys(exif).length) score += 0.1;
    if (score>1) score = 1;

    res.json({ score, details: { pHash: phash, exif, ela } });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, ()=>console.log('forensic service started', port));
