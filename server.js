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

// ── プロンプト ────────────────────────────────────────────────────────────────
const SYSTEM = `You are an AI drawing assistant. A human draws partial strokes, and you complete the drawing by guessing what they are trying to make.

IMPORTANT: Instead of raw pixel coordinates, describe shapes using the types below. The app will convert them to accurate lines automatically.

Shape types (all fields required unless marked optional):
  {"type":"ellipse", "cx":X, "cy":Y, "rx":W, "ry":H}          — oval / eye shape
  {"type":"circle",  "cx":X, "cy":Y, "r":R}                    — circle / pupil / sun
  {"type":"arc",     "cx":X, "cy":Y, "r":R, "startAngle":A, "endAngle":B}  — partial circle (degrees: 0=right 90=bottom 180=left 270=top)
  {"type":"line",    "x1":X1,"y1":Y1,"x2":X2,"y2":Y2}         — straight line
  {"type":"curve",   "points":[[x,y],...]}                      — freehand curve (5–12 points)

Each shape also takes: "color":"#rrggbb", "width":1–6, "opacity":0.5–1.0

Canvas: 800 wide × 600 tall. Top-left=(0,0), bottom-right=(800,600).

Respond with ONLY valid JSON:
{"message":"（推測した内容を一文で日本語で）","shapes":[...]}

Examples:

Human drew top half of a face → complete with eyes, nose, mouth:
{"message":"顔を描こうとしていると思ったので、目・鼻・口を描き足しました。","shapes":[
  {"type":"ellipse","cx":280,"cy":220,"rx":35,"ry":20,"color":"#1a1a1a","width":2,"opacity":0.9},
  {"type":"ellipse","cx":520,"cy":220,"rx":35,"ry":20,"color":"#1a1a1a","width":2,"opacity":0.9},
  {"type":"circle","cx":280,"cy":220,"r":8,"color":"#1a1a1a","width":3,"opacity":1},
  {"type":"circle","cx":520,"cy":220,"r":8,"color":"#1a1a1a","width":3,"opacity":1},
  {"type":"line","x1":390,"y1":260,"x2":410,"y2":280,"color":"#1a1a1a","width":2,"opacity":0.8},
  {"type":"arc","cx":400,"cy":330,"r":60,"startAngle":20,"endAngle":160,"color":"#1a1a1a","width":2,"opacity":0.9}
]}

Human drew a diagonal line → complete as a mountain:
{"message":"山を描こうとしていると思ったので、反対側の斜面と麓を描き足しました。","shapes":[
  {"type":"line","x1":400,"y1":100,"x2":600,"y2":400,"color":"#1a1a1a","width":2,"opacity":0.9},
  {"type":"line","x1":100,"y1":400,"x2":600,"y2":400,"color":"#1a1a1a","width":2,"opacity":0.9}
]}`;

// ── 形状 → 座標点 変換 ────────────────────────────────────────────────────────
function shapeToPoints(shape) {
  const steps = (n) => Array.from({ length: n + 1 }, (_, i) => i / n);

  switch (shape.type) {
    case 'ellipse':
    case 'oval': {
      const { cx = 400, cy = 300, rx = 50, ry = 30 } = shape;
      const n = Math.max(16, Math.round((rx + ry) * 0.5));
      return steps(n).map(t => {
        const a = t * 2 * Math.PI;
        return [Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a))];
      });
    }
    case 'circle': {
      const { cx = 400, cy = 300, r = 50 } = shape;
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
      const { x1 = 0, y1 = 0, x2 = 100, y2 = 100 } = shape;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.max(2, Math.round(len / 15));
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
      width:   Math.max(0.5, Math.min(12, s.width   ?? 2)),
      opacity: Math.max(0.1, Math.min(1,  s.opacity ?? 0.9)),
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

// ── API エンドポイント ────────────────────────────────────────────────────────
app.post('/api/draw', async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data' });

  try {
    const response = await client.chat.completions.create({
      model: AI_MODEL,
      max_tokens: 1024,
      temperature: 0.5,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageData } },
            { type: 'text', text: 'Look at the canvas and complete the drawing. Reply with JSON only.' },
          ],
        },
      ],
    });

    const text = response.choices[0].message.content.trim();
    console.log('AI raw response:', text.slice(0, 300));

    const data = repairJSON(text);

    // shapes 形式 → strokes 形式に変換
    if (Array.isArray(data.shapes)) {
      data.strokes = shapesToStrokes(data.shapes);
      delete data.shapes;
    }

    // 旧来の strokes 形式にも対応
    if (Array.isArray(data.strokes)) {
      data.strokes = data.strokes
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

    res.json(data);
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
