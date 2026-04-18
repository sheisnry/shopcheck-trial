export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, answers, score, total } = req.body || {};
  if (!prompt && !answers) return res.status(400).json({ error: 'Missing prompt or answers' });

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-5.4';

  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is missing' });
  }

  const finalPrompt = prompt || `Analyze this Shopee store with score ${score}/${total}:\n${answers}`;
  const isStep2 = /"web_summary"|"full_report"|ตอบเป็น JSON object เท่านั้น|ผลลัพธ์ 2 ชั้นพร้อมกัน/i.test(finalPrompt);

  const developerInstruction = [
    'You are ShopCheck analysis engine for Thai Shopee sellers.',
    'Write natural Thai that sounds like a real consultant, not like AI copy.',
    'Every recommendation must be tied to the provided shop profile and answers.',
    'Avoid generic filler. Be specific about what is weak, why it matters, and what to do next.',
    'Rank issues by business impact, not by how easy they are to mention.',
    'If the shop has some strengths, mention them honestly. If it does not, say so plainly.',
    isStep2
      ? 'For step 2, return strict JSON only. No markdown, no code fences, no commentary before or after JSON.'
      : 'For step 1, follow the requested heading structure exactly and return only the final answer.'
  ].join(' ');

  function extractOutputText(data) {
    if (typeof data?.output_text === 'string' && data.output_text.trim()) {
      return data.output_text.trim();
    }

    const items = Array.isArray(data?.output) ? data.output : [];
    const chunks = [];

    for (const item of items) {
      if (item?.type !== 'message' || !Array.isArray(item?.content)) continue;
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part?.text === 'string') {
          chunks.push(part.text);
        }
      }
    }

    return chunks.join('\n').trim();
  }

  function extractJSONObject(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();

    const start = raw.indexOf('{');
    if (start === -1) return '';

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) return raw.slice(start, i + 1).trim();
      }
    }

    return '';
  }

  function safeParseJSON(text) {
    const candidate = extractJSONObject(text);
    if (!candidate) return null;
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  function cleanText(value, fallback = '') {
    if (value == null) return fallback;
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text || fallback;
  }

  function normalizeTag(tag, idx) {
    const t = cleanText(tag).toLowerCase();
    if (t.includes('ทำได้')) return 'ทำได้เลย';
    if (t.includes('impact') || t.includes('สูง')) return 'impact สูง';
    return idx === 2 ? 'ทำได้เลย' : 'impact สูง';
  }

  function clampPct(value, fallback = 75) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  function listOrFallback(value, fallback = []) {
    return Array.isArray(value) ? value : fallback;
  }

  function normalizeStep2Payload(payload) {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const web = raw.web_summary && typeof raw.web_summary === 'object' ? raw.web_summary : {};
    const full = raw.full_report && typeof raw.full_report === 'object' ? raw.full_report : {};

    const fallbackFocus = [
      {
        title: 'ทำให้สินค้าที่อยากดันมีเหตุผลให้ซื้อชัดขึ้น',
        desc: 'ปรับภาพหน้าสินค้าและจุดขายให้ลูกค้าเข้าใจได้เร็วขึ้นตั้งแต่ก่อนเลื่อนอ่านรายละเอียด',
        tag: 'impact สูง'
      },
      {
        title: 'จัดการเรื่องความคุ้มค่าให้ชัด',
        desc: 'ทำให้ลูกค้าเห็นความคุ้มจากข้อมูลสินค้าและข้อเสนอ ไม่ใช่ปล่อยให้เทียบกันที่ราคาอย่างเดียว',
        tag: 'impact สูง'
      },
      {
        title: 'ค่อยใช้โปรกับสินค้าที่พร้อมก่อน',
        desc: 'เริ่มจากตัวที่หน้าสินค้าพร้อมและมีโอกาสปิดการขายได้ก่อน แล้วค่อยขยาย',
        tag: 'ทำได้เลย'
      }
    ];

    const fallbackWeeks = [
      {
        week: 'สัปดาห์ที่ 1',
        title: 'จัดหน้าสินค้าให้ชัดขึ้น',
        detail: 'เริ่มจาก 5 ภาพแรกของสินค้าที่อยากดันและข้อความที่ลูกค้าเห็นก่อนตัดสินใจ'
      },
      {
        week: 'สัปดาห์ที่ 2',
        title: 'จัดข้อเสนอให้ลูกค้าเห็นความคุ้ม',
        detail: 'ปรับโปรหรือ bundle ให้ช่วยปิดการขายโดยไม่ทำให้กำไรหายเกินไป'
      },
      {
        week: 'สัปดาห์ที่ 3',
        title: 'เก็บคำถามจริงจากลูกค้า',
        detail: 'เอาคำถามที่เจอบ่อยมาปรับในภาพและรายละเอียดสินค้าเพื่อลดการลังเล'
      },
      {
        week: 'สัปดาห์ที่ 4',
        title: 'ต่อยอดด้วยเครื่องมือที่เหมาะ',
        detail: 'ค่อยใช้แคมเปญหรือโปรกับสินค้าที่หน้าพร้อมแล้วจริง ๆ'
      }
    ];

    const webFocus = listOrFallback(web.focus_3).slice(0, 3).map((item, idx) => ({
      title: cleanText(item?.title, fallbackFocus[idx]?.title || `เรื่องที่ ${idx + 1}`),
      desc: cleanText(item?.desc, fallbackFocus[idx]?.desc || ''),
      tag: normalizeTag(item?.tag, idx)
    }));

    const webWeeks = listOrFallback(web.plan_30_days).slice(0, 4).map((item, idx) => ({
      week: cleanText(item?.week, fallbackWeeks[idx]?.week || `สัปดาห์ที่ ${idx + 1}`),
      title: cleanText(item?.title, fallbackWeeks[idx]?.title || `แผนสัปดาห์ ${idx + 1}`),
      detail: cleanText(item?.detail, fallbackWeeks[idx]?.detail || '')
    }));

    const fullFocus = listOrFallback(full.focus_areas).slice(0, 3).map((item, idx) => ({
      title: cleanText(item?.title, webFocus[idx]?.title || fallbackFocus[idx]?.title || `เรื่องที่ ${idx + 1}`),
      why: cleanText(item?.why, ''),
      steps: listOrFallback(item?.steps).slice(0, 4).map(step => cleanText(step)).filter(Boolean),
      expected_result: cleanText(item?.expected_result, '')
    }));

    const fullWeeks = listOrFallback(full.plan_30_days).slice(0, 4).map((item, idx) => ({
      week: cleanText(item?.week, webWeeks[idx]?.week || fallbackWeeks[idx]?.week || `สัปดาห์ที่ ${idx + 1}`),
      title: cleanText(item?.title, webWeeks[idx]?.title || fallbackWeeks[idx]?.title || `แผนสัปดาห์ ${idx + 1}`),
      details: listOrFallback(item?.details).slice(0, 4).map(detail => cleanText(detail)).filter(Boolean)
    }));

    return {
      web_summary: {
        headline: cleanText(
          web.headline,
          'ร้านนี้ยังมีโอกาสโตบน Shopee ต่อได้ แต่ตอนนี้ยังต้องแก้ปัญหาหลักให้ตรงจุด'
        ),
        main_problem: cleanText(
          web.main_problem,
          'ตอนนี้ลูกค้าเริ่มเห็นสินค้าแล้ว แต่ยังไม่เห็นเหตุผลชัดพอว่าทำไมควรซื้อร้านนี้แทนร้านอื่น'
        ),
        focus_3: webFocus.length === 3 ? webFocus : fallbackFocus,
        plan_30_days: webWeeks.length === 4 ? webWeeks : fallbackWeeks,
        channel_fit: {
          score_pct: clampPct(web.channel_fit?.score_pct, 75),
          label: cleanText(web.channel_fit?.label, 'ยังเหมาะ'),
          summary: cleanText(
            web.channel_fit?.summary,
            'Shopee ยังเหมาะกับร้านนี้ แต่ต้องแก้ปัญหาหลักก่อนเร่งยอด'
          )
        }
      },
      full_report: {
        overview: cleanText(
          full.overview,
          'ร้านนี้ยังมีโอกาสโตต่อได้ แต่ตอนนี้ควรแก้สิ่งที่ทำให้ลูกค้าลังเลก่อนเร่งโปรหรือดันทราฟฟิกเพิ่ม'
        ),
        focus_areas:
          fullFocus.length === 3
            ? fullFocus
            : fallbackFocus.map(item => ({
                title: item.title,
                why: item.desc,
                steps: [item.desc],
                expected_result: 'ช่วยให้ลูกค้าตัดสินใจง่ายขึ้นและลดยอดที่หลุดไปแบบไม่จำเป็น'
              })),
        plan_30_days:
          fullWeeks.length === 4
            ? fullWeeks
            : fallbackWeeks.map(item => ({
                week: item.week,
                title: item.title,
                details: [item.detail]
              })),
        channel_fit: {
          score_pct: clampPct(full.channel_fit?.score_pct, clampPct(web.channel_fit?.score_pct, 75)),
          label: cleanText(full.channel_fit?.label, cleanText(web.channel_fit?.label, 'ยังเหมาะ')),
          long_reason: cleanText(
            full.channel_fit?.long_reason,
            cleanText(web.channel_fit?.summary, 'Shopee ยังเหมาะกับร้านนี้ แต่ต้องแก้ปัญหาหลักก่อนเร่งยอด')
          ),
          conclusion_lines: listOrFallback(full.channel_fit?.conclusion_lines)
            .slice(0, 3)
            .map(line => cleanText(line))
            .filter(Boolean)
        }
      }
    };
  }

  function hasRequiredSections(text) {
    if (!text) return false;

    if (isStep2) {
      const payload = safeParseJSON(text);
      return Boolean(
        payload?.web_summary?.headline &&
          Array.isArray(payload?.web_summary?.focus_3) &&
          payload.web_summary.focus_3.length >= 3 &&
          Array.isArray(payload?.web_summary?.plan_30_days) &&
          payload.web_summary.plan_30_days.length >= 4 &&
          payload?.full_report?.overview &&
          Array.isArray(payload?.full_report?.focus_areas) &&
          payload.full_report.focus_areas.length >= 3
      );
    }

    return (
      /\*\*ภาพรวมร้าน/i.test(text) &&
      /\*\*จุดเด่นของร้านที่ต้องรักษาไว้\*\*/i.test(text) &&
      /\*\*จุดที่ต้องแก้ก่อน\*\*/i.test(text) &&
      /\*\*Action plan 1 ข้อที่ทำได้เลยสัปดาห์นี้\*\*/i.test(text)
    );
  }

  async function runOpenAI(input, maxOutputTokens = 3800) {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: maxOutputTokens,
        instructions: developerInstruction,
        input
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const message = data?.error?.message || 'OpenAI request failed';
      throw new Error(message);
    }

    return data;
  }

  try {
    const firstPass = await runOpenAI(finalPrompt, isStep2 ? 5200 : 3200);
    let text = extractOutputText(firstPass);

    if (!hasRequiredSections(text)) {
      const repairPrompt = [
        isStep2
          ? 'Convert the following answer into the exact JSON structure requested in the original prompt. Return JSON only.'
          : 'Repair the following answer so it follows the required headings exactly.',
        'Keep the substance, sharpen specificity, and remove generic filler.',
        '',
        'ORIGINAL REQUEST:',
        finalPrompt,
        '',
        'CURRENT ANSWER:',
        text || '[empty]'
      ].join('\n');

      const repaired = await runOpenAI(repairPrompt, isStep2 ? 5200 : 3400);
      const repairedText = extractOutputText(repaired);
      if (repairedText) text = repairedText;
    }

    if (!text) {
      throw new Error('Model returned empty output');
    }

    if (isStep2) {
      const parsed = safeParseJSON(text);
      if (!parsed) {
        throw new Error('Step 2 output is not valid JSON');
      }
      const payload = normalizeStep2Payload(parsed);
      return res.status(200).json({ result: JSON.stringify(payload) });
    }

    return res.status(200).json({ result: text });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error' });
  }
}
