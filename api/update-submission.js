function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asTextOrJSON(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value || null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildAnswerPatch(body) {
  const {
    profile,
    quickAnswers,
    deepAnswers,
    email,
    name,
    lineId,
    paymentMethod,
    version,
    step1AIResult,
    step2AIResult,
    step1Prompt,
    step2Prompt,
    leadStage,
    isDraftLead
  } = body || {};

  const patch = {
    raw_payload: body || {}
  };

  if (leadStage !== undefined) patch.lead_stage = leadStage || null;
  if (version !== undefined) patch.version = version || 'shopcheck_v2';

  if (profile && typeof profile === 'object') {
    const safeProfile = asObject(profile);
    patch.shop_name = safeProfile.shopName || null;
    patch.shop_cat = safeProfile.shopCat || null;
    patch.hero_product = safeProfile.heroProduct || null;
    patch.monthly_orders = safeProfile.monthlyOrders || null;
    patch.target_orders = safeProfile.targetOrders || null;
    patch.main_problem = safeProfile.mainProblem || null;
    patch.viral_scenario = Boolean(safeProfile.viralScenario);
    patch.profile = safeProfile;
  }

  if (quickAnswers !== undefined) patch.quick_answers = asObject(quickAnswers);
  if (deepAnswers !== undefined) patch.deep_answers = asObject(deepAnswers);

  if (typeof email === 'string') {
    const cleanEmail = email.trim();
    patch.email = isValidEmail(cleanEmail) ? cleanEmail : null;
  }

  if (typeof name === 'string') patch.customer_name = name.trim() || null;
  if (typeof lineId === 'string') patch.line_id = lineId.trim() || null;
  if (paymentMethod !== undefined) patch.payment_method = paymentMethod || null;
  if (isDraftLead !== undefined) patch.is_draft_lead = Boolean(isDraftLead);

  if (step1AIResult !== undefined) patch.step1_ai_result = asTextOrJSON(step1AIResult);
  if (step2AIResult !== undefined) patch.step2_ai_result = asTextOrJSON(step2AIResult);
  if (step1Prompt !== undefined) patch.step1_prompt = asTextOrJSON(step1Prompt);
  if (step2Prompt !== undefined) patch.step2_prompt = asTextOrJSON(step2Prompt);

  return patch;
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { submissionId } = body;

    if (!submissionId) {
      return res.status(400).json({ error: 'submissionId is required' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const tableName = process.env.SHOPCHECK_ANSWERS_TABLE || 'shopcheck_answer_submissions_v1';

    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: 'Supabase env vars are missing' });
    }

    const patch = buildAnswerPatch(body);

    const response = await fetch(
      `${supabaseUrl}/rest/v1/${tableName}?id=eq.${encodeURIComponent(submissionId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: 'return=representation'
        },
        body: JSON.stringify(patch)
      }
    );

    const data = await readJsonSafe(response);

    if (!response.ok) {
      return res.status(500).json({
        error: 'Failed to update answer submission',
        details: data
      });
    }

    return res.status(200).json({
      ok: true,
      submission: Array.isArray(data) ? data[0] || null : data || null
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Unexpected server error',
      details: error.message
    });
  }
}
