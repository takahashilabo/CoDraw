'use strict';

require('dotenv').config();

const express = require('express');
const OpenAI = require('openai');

if (!process.env.OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY が設定されていません');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'http://localhost:3000',
    'X-Title': 'CoDraw',
  },
});

const SYSTEM = `You are a collaborative AI artist. A human draws on an 800x600 canvas, then you add strokes that complement their drawing. Together you build one artwork.

Respond with ONLY valid JSON — no markdown, no explanation, nothing else before or after:
{"message":"(one short sentence in Japanese describing what you added)","strokes":[{"color":"#rrggbb","width":2,"opacity":0.8,"points":[[x,y],[x,y],[x,y]]}]}

Strict rules:
- Output raw JSON only. Do not wrap in markdown fences.
- x: integer 0-800, y: integer 0-600.
- Add 3 to 6 strokes. Each stroke needs 5 to 20 points.
- Pick colors that fit the drawing's mood.
- The "message" value must be a single sentence written in Japanese.

Example output:
{"message":"夕暮れの空に、鳥が羽ばたいていく。","strokes":[{"color":"#ff6b35","width":3,"opacity":0.9,"points":[[100,200],[150,180],[200,160],[250,150],[300,155]]},{"color":"#4a90d9","width":1,"opacity":0.6,"points":[[0,300],[100,280],[200,290],[300,270],[400,260],[500,275],[600,265],[700,270],[800,260]]}]}`;

function normalizePoints(points) {
  if (!Array.isArray(points)) return [];
  return points
    .map(p => {
      if (Array.isArray(p)) return [p[0], p[1]];
      if (p && typeof p === 'object') return [p.x ?? p[0], p.y ?? p[1]];
      return null;
    })
    .filter(p => p && typeof p[0] === 'number' && typeof p[1] === 'number'
      && p[0] >= 0 && p[0] <= 800 && p[1] >= 0 && p[1] <= 600);
}

app.post('/api/draw', async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data' });

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.2-11b-vision-instruct',
      max_tokens: 2048,
      temperature: 0.7,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageData } },
            { type: 'text', text: 'このキャンバスに、あなたの絵筆を加えてください。JSONのみで返してください。' },
          ],
        },
      ],
    });

    let text = response.choices[0].message.content.trim();
    console.log('AI raw response:', text.slice(0, 300));

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('AIの返答からJSONを抽出できませんでした');
      data = JSON.parse(m[0]);
    }

    if (Array.isArray(data.strokes)) {
      data.strokes = data.strokes
        .map(s => ({
          ...s,
          points: normalizePoints(s.points),
        }))
        .filter(s => s.points.length >= 2);
    }

    res.json(data);
  } catch (e) {
    console.error('AI error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nCoDraw 起動中 → http://localhost:${PORT}\n`);
});
