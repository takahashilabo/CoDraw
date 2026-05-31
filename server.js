'use strict';

require('dotenv').config();

const express = require('express');
const OpenAI = require('openai');

const BASE_URL = process.env.AI_BASE_URL || 'http://localhost:1234/v1';
const API_KEY  = process.env.AI_API_KEY  || 'lm-studio';
const AI_MODEL = process.env.AI_MODEL    || 'qwen2.5-vl-3b-instruct';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const client = new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY });

// ── 形状 → 座標点 変換 ────────────────────────────────────────────────────────
function shapeToPoints(shape) {
  const steps = (n) => Array.from({ length: n + 1 }, (_, i) => i / n);

  switch (shape.type) {
    case 'ellipse':
    case 'oval': {
      const { cx = 400, cy = 300, rx = 60, ry = 40 } = shape;
      const n = Math.max(20, Math.round((rx + ry)));
      return steps(n).map(t => {
        const a = t * 2 * Math.PI;
        return [Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a))];
      });
    }
    case 'circle': {
      const { cx = 400, cy = 300, r = 60 } = shape;
      return shapeToPoints({ ...shape, type: 'ellipse', rx: r, ry: r });
    }
    case 'arc': {
      const { cx = 400, cy = 300, r = 80, startAngle = 0, endAngle = 180 } = shape;
      const s = (startAngle * Math.PI) / 180;
      const e = (endAngle   * Math.PI) / 180;
      const n = Math.max(8, Math.round(Math.abs(e - s) * r / 8));
      return steps(n).map(t => {
        const a = s + t * (e - s);
        return [Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))];
      });
    }
    case 'line': {
      const { x1 = 0, y1 = 0, x2 = 800, y2 = 0 } = shape;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.max(2, Math.round(len / 10));
      return steps(n).map(t => [Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t)]);
    }
    case 'curve':
    default:
      return (shape.points || [])
        .map(p => Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y])
        .filter(([x, y]) => x >= 0 && x <= 800 && y >= 0 && y <= 600);
  }
}

function shapesToStrokes(shapes) {
  return shapes
    .map(s => ({
      color:   s.color   || '#1a1a1a',
      width:   Math.max(1, Math.min(12, s.width   ?? 2)),
      opacity: Math.max(0.5, Math.min(1,  s.opacity ?? 0.9)),
      points:  shapeToPoints(s).filter(([x, y]) => x >= 0 && x <= 800 && y >= 0 && y <= 600),
    }))
    .filter(s => s.points.length >= 2);
}

// ── JSON 修復 ─────────────────────────────────────────────────────────────────
function repairJSON(text) {
  try { return JSON.parse(text); } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }

  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON found in response');
  const partial = text.slice(start);

  const stack = [];
  let repaired = '';
  for (const ch of partial) {
    if (ch === '[' || ch === '{') {
      stack.push(ch); repaired += ch;
    } else if (ch === ']') {
      if (stack.at(-1) === '[') stack.pop();
      repaired += ch;
    } else if (ch === '}') {
      while (stack.length && stack.at(-1) === '[') { repaired += ']'; stack.pop(); }
      if (stack.at(-1) === '{') stack.pop();
      repaired += ch;
    } else {
      repaired += ch;
    }
  }
  for (const ch of [...stack].reverse()) repaired += ch === '[' ? ']' : '}';

  try { return JSON.parse(repaired); } catch {}
  throw new Error('Could not parse AI response as JSON');
}

// ── AI レスポンスを strokes に変換 ───────────────────────────────────────────
function toStrokes(data) {
  if (Array.isArray(data.shapes)) {
    return shapesToStrokes(data.shapes);
  }
  if (Array.isArray(data.strokes)) {
    return data.strokes
      .map(s => {
        if (s.type && s.type !== 'curve') {
          return { ...s, points: shapeToPoints(s).filter(([x, y]) => x >= 0 && x <= 800 && y >= 0 && y <= 600) };
        }
        const pts = (s.points || [])
          .map(p => Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y])
          .filter(([x, y]) => x >= 0 && x <= 800 && y >= 0 && y <= 600);
        return { ...s, points: pts };
      })
      .filter(s => s.points.length >= 2);
  }
  return [];
}

// ── プロンプト定義 ────────────────────────────────────────────────────────────
const COMPLETE_SYSTEM = `You are an AI drawing assistant. A human draws partial strokes, and you complete the drawing by guessing what they are trying to make.

Shape types you can output:
  {"type":"ellipse","cx":X,"cy":Y,"rx":W,"ry":H}
  {"type":"circle","cx":X,"cy":Y,"r":R}
  {"type":"arc","cx":X,"cy":Y,"r":R,"startAngle":A,"endAngle":B}   (degrees: 0=right 90=down 180=left 270=up)
  {"type":"line","x1":X1,"y1":Y1,"x2":X2,"y2":Y2}
  {"type":"curve","points":[[x,y],...]}

Each shape also needs: "color":"#rrggbb", "width":1–5, "opacity":0.8–1.0

Canvas: 800 wide × 600 tall.

Size guidelines — shapes must be CLEARLY VISIBLE:
- Face / head: circle r:120–180, or ellipse rx:120–160 ry:150–200
- Eyes: ellipse rx:35–55 ry:20–30 (pair them left/right of center)
- Pupil: circle r:12–18
- Mouth smile: arc r:40–70 startAngle:10 endAngle:170
- Sun: circle r:50–80
- Mountain: lines spanning 200–600px
- House roof: lines at least 200px wide
- Minimum circle radius: 20px. Minimum ellipse axis: 15px.

IMPORTANT: Use dark colors (#1a1a1a, #333, or matching the user's color). Avoid light colors like #ccc or #eee on white canvas.

Respond with ONLY valid JSON (no markdown):
{"message":"（推測した内容を一文で日本語で）","shapes":[...]}`;

const REFINE_SYSTEM = `You are a drawing beautifier. Look at the hand-drawn strokes and replace each one with a clean geometric shape.

Recognize each stroke:
- Roughly straight lines → {"type":"line", x1,y1,x2,y2}
- Roughly circular strokes → {"type":"circle", cx,cy,r}
- Oval / elongated circles → {"type":"ellipse", cx,cy,rx,ry}
- Partial circles / arcs → {"type":"arc", cx,cy,r,startAngle,endAngle}
- Complex curves → {"type":"curve","points":[[x,y],...]}

Rules:
- Keep the SAME approximate position and size as the drawn strokes.
- Keep the same color as the original stroke (use the dominant color you see).
- Output one clean shape per hand-drawn stroke.
- Make lines perfectly straight, circles perfectly round.

Canvas: 800 × 600. Use same coordinate system.

Respond with ONLY valid JSON (no markdown):
{"message":"（認識した図形を日本語で説明。例：直線2本と楕円1つに整形しました。）","shapes":[...]}`;

// ── API エンドポイント ────────────────────────────────────────────────────────
async function callAI(systemPrompt, imageData) {
  const response = await client.chat.completions.create({
    model: AI_MODEL,
    max_tokens: 1024,
    temperature: 0.4,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageData } },
          { type: 'text', text: 'Reply with JSON only.' },
        ],
      },
    ],
  });

  const text = response.choices[0].message.content.trim();
  console.log('AI raw response:', text.slice(0, 300));
  const data = repairJSON(text);
  return { message: data.message || '', strokes: toStrokes(data) };
}

app.post('/api/draw', async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data' });
  try {
    res.json(await callAI(COMPLETE_SYSTEM, imageData));
  } catch (e) {
    console.error('AI error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refine', async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data' });
  try {
    res.json(await callAI(REFINE_SYSTEM, imageData));
  } catch (e) {
    console.error('AI error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nCoDraw 起動中 → http://localhost:${PORT}`);
  console.log(`AI: ${BASE_URL} / ${AI_MODEL}\n`);
});
