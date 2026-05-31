'use strict';

require('dotenv').config();

const express = require('express');
const OpenAI = require('openai');

const BASE_URL  = process.env.AI_BASE_URL  || 'http://localhost:1234/v1';
const API_KEY   = process.env.AI_API_KEY   || 'lm-studio';
const AI_MODEL  = process.env.AI_MODEL     || 'local-model';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const client = new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY });

const SYSTEM = `You are a collaborative AI artist. A human draws on an 800x600 canvas, then you add strokes that complement their drawing. Together you build one artwork.

Respond with ONLY valid JSON — no markdown, no explanation, nothing else before or after:
{"message":"(one short sentence in Japanese describing what you added)","strokes":[{"color":"#rrggbb","width":2,"opacity":0.8,"points":[[x,y],[x,y],[x,y]]}]}

Strict rules:
- Output raw JSON only. Do not wrap in markdown fences.
- x: integer 0-800, y: integer 0-600.
- Add 3 to 5 strokes. Each stroke needs 5 to 15 points.
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

function repairJSON(text) {
  // 直接パース
  try { return JSON.parse(text); } catch {}

  // マークダウンのコードブロックを除去
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }

  // JSON オブジェクトを探す
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON found in response');
  let partial = text.slice(start);

  // 閉じ括弧を補完して修復を試みる
  let sq = 0, cu = 0;
  for (const ch of partial) {
    if (ch === '[') sq++; else if (ch === ']') sq--;
    if (ch === '{') cu++; else if (ch === '}') cu--;
  }
  const repaired = partial + ']'.repeat(Math.max(0, sq)) + '}'.repeat(Math.max(0, cu));
  try { return JSON.parse(repaired); } catch {}

  throw new Error('Could not parse AI response as JSON');
}

app.post('/api/draw', async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data' });

  try {
    const response = await client.chat.completions.create({
      model: AI_MODEL,
      max_tokens: 1024,
      temperature: 0.7,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageData } },
            { type: 'text', text: 'Add your strokes to this canvas. Reply with JSON only.' },
          ],
        },
      ],
    });

    const text = response.choices[0].message.content.trim();
    console.log('AI raw response:', text.slice(0, 200));

    const data = repairJSON(text);

    if (Array.isArray(data.strokes)) {
      data.strokes = data.strokes
        .map(s => ({ ...s, points: normalizePoints(s.points) }))
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
  console.log(`\nCoDraw 起動中 → http://localhost:${PORT}`);
  console.log(`AI エンドポイント: ${BASE_URL} / モデル: ${AI_MODEL}\n`);
});
