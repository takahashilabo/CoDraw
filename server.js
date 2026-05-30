'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY が設定されていません');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `あなたは共同創作AIアーティストです。人間とあなたが交互に一枚のキャンバス（800×600ピクセル）に絵を描き、一緒に作品を仕上げていきます。

現在のキャンバスの状態を見て、描かれたものを補完・発展させるようなストロークを加えてください。創造的かつ芸術的な感性を持って取り組んでください。

返答は必ず以下の形式のJSONのみ（前置きやマークダウン不要）：
{
  "message": "あなたが加えたものを詩的な一文で説明（日本語）",
  "strokes": [
    { "color": "#rrggbb", "width": <1〜8>, "opacity": <0.1〜1.0>, "points": [[x,y], ...] }
  ]
}

座標ルール：
- 左上=(0,0)、右上=(800,0)、左下=(0,600)、右下=(800,600)、中心=(400,300)
- xは0〜800、yは0〜600の範囲内
- ストローク数：3〜8本、各ストロークの点の数：5〜30個
- 細い線（width 1〜2）で繊細な描写、太い線（width 4〜8）でダイナミックな表現
- opacity 0.2〜0.4 で影や空気感、0.7〜1.0 でメインの線

芸術的な視点で：キャンバスに描かれているものから「何を描こうとしているのか」を想像し、それを完成に近づける、あるいは新たな物語を加えるストロークを選んでください。キャンバスがほぼ空白の場合は、続きを描きたくなるような誘いの一筆を。`;

app.post('/api/draw', async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data' });

  const b64 = imageData.replace(/^data:image\/\w+;base64,/, '');

  try {
    const msg = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
          { type: 'text', text: 'このキャンバスに、あなたの絵筆を加えてください。JSONのみで返してください。' },
        ],
      }],
    });

    let text = msg.content[0].text.trim();
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
          points: (s.points || []).filter(([x, y]) => x >= 0 && x <= 800 && y >= 0 && y <= 600),
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
