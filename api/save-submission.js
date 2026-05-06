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

function buildAnswerPayload(body) {
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

  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanLineId = typeof lineId === 'string' ? lineId.trim() : '';
  const safeProfile = asObject(profile);

  return {
    source: 'shopcheck-web',
    lead_stage: leadStage || null,
    version: version || 'shopcheck_v2',

    shop_name: safeProfile.shopName || null,
    shop_cat: safeProfile.shopCat || null,
    hero_product: safeProfile.heroProduct || null,
    monthly_orders: safeProfile.monthlyOrders || null,
    target_orders: safeProfile.targetOrders || null,
    main_problem: safeProfile.mainProblem || null,
    viral_scenario: Boolean(safeProfile.viralScenario),

    customer_name: cleanName || null,
    email: isValidEmail(cleanEmail) ? cleanEmail : null,
    line_id: cleanLineId || null,
    payment_method: paymentMethod || null,
    is_draft_lead: Boolean(isDraftLead),

    profile: safeProfile,
    quick_answers: asObject(quickAnswers),
    deep_answers: asObject(deepAnswers),

    step1_ai_result: asTextOrJSON(step1AIResult),
    step2_ai_result: asTextOrJSON(step2AIResult),
    step1_prompt: asTextOrJSON(step1Prompt),
    step2_prompt: asTextOrJSON(step2Prompt),

    raw_payload: body || {}
  };
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
    const { submissionId, profile } = body;

    if (
      !profile?.shopCat ||
      !profile?.heroProduct ||
      !profile?.monthlyOrders ||
      !profile?.targetOrders
    ) {
      return res.status(400).json({ error: 'Missing required profile fields' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const tableName = process.env.SHOPCHECK_ANSWERS_TABLE || 'shopcheck_answer_submissions_v1';

    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: 'Supabase env vars are missing' });
    }

    const payload = buildAnswerPayload(body);

    const headers = {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: 'return=representation'
    };

    let response;

    if (submissionId) {
      response = await fetch(
        `${supabaseUrl}/rest/v1/${tableName}?id=eq.${encodeURIComponent(submissionId)}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify(payload)
        }
      );
    } else {
      response = await fetch(`${supabaseUrl}/rest/v1/${tableName}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
    }

    const data = await readJsonSafe(response);

    if (!response.ok) {
      return res.status(500).json({
        error: submissionId ? 'Failed to update answer submission' : 'Failed to save answer submission',
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
