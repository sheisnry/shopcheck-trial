function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseStep2Payload(value) {
  if (!value) return { raw: null, webSummary: null, fullReport: null };

  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  let parsed = null;

  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  } else if (typeof value === 'object') {
    parsed = value;
  }

  return {
    raw,
    webSummary: parsed?.web_summary && typeof parsed.web_summary === 'object' ? parsed.web_summary : null,
    fullReport: parsed?.full_report && typeof parsed.full_report === 'object' ? parsed.full_report : null
  };
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
    const {
      submissionId,
      profile,
      quickAnswers,
      deepAnswers,
      email,
      name,
      lineId,
      deliveryChannel,
      paymentMethod,
      paymentStatus,
      deliveryStatus,
      version,
      step1AIResult,
      step2AIResult,
      step1Prompt,
      step2Prompt,
      status,
      notes
    } = req.body || {};

    if (!submissionId) {
      return res.status(400).json({ error: 'submissionId is required' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const tableName = process.env.SHOPCHECK_SUBMISSIONS_TABLE || 'shopcheck_submissions_v2';

    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: 'Supabase env vars are missing' });
    }

    const patch = {};

    if (profile) {
      patch.shop_name = profile.shopName || null;
      patch.shop_cat = profile.shopCat || null;
      patch.hero_product = profile.heroProduct || null;
      patch.monthly_orders = profile.monthlyOrders || null;
      patch.target_orders = profile.targetOrders || null;
      patch.main_problem = profile.mainProblem || null;
    }

    if (quickAnswers) patch.quick_answers = asObject(quickAnswers);
    if (deepAnswers) patch.deep_answers = asObject(deepAnswers);

    if (typeof email === 'string') {
      patch.customer_email = isValidEmail(email.trim()) ? email.trim() : null;
    }

    if (typeof name === 'string') {
      patch.customer_name = name.trim() || null;
    }

    if (typeof lineId === 'string') {
      patch.customer_line_id = lineId.trim() || null;
    }

    if (deliveryChannel) {
      patch.delivery_channel = deliveryChannel === 'line' ? 'line' : 'email';
    }

    if (paymentMethod) patch.payment_method = paymentMethod;
    if (paymentStatus) patch.payment_status = paymentStatus;
    if (deliveryStatus) patch.delivery_status = deliveryStatus;
    if (status) patch.status = status;
    if (version) patch.version = version;
    if (typeof notes === 'string') patch.notes = notes.trim() || null;

    if (typeof step1Prompt === 'string') patch.step1_prompt = step1Prompt || null;
    if (typeof step2Prompt === 'string') patch.step2_prompt = step2Prompt || null;
    if (typeof step1AIResult === 'string') patch.step1_result_text = step1AIResult || null;

    if (step2AIResult != null) {
      const { raw, webSummary, fullReport } = parseStep2Payload(step2AIResult);
      patch.step2_result_raw = raw;
      patch.step2_web_summary = webSummary;
      patch.step2_full_report = fullReport;
    }

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

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: 'Failed to update submission',
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
