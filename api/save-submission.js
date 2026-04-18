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

  const webSummary = parsed?.web_summary && typeof parsed.web_summary === 'object'
    ? parsed.web_summary
    : null;

  const fullReport = parsed?.full_report && typeof parsed.full_report === 'object'
    ? parsed.full_report
    : null;

  return { raw, webSummary, fullReport };
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
      notes
    } = req.body || {};

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
    const tableName = process.env.SHOPCHECK_SUBMISSIONS_TABLE || 'shopcheck_submissions_v2';

    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: 'Supabase env vars are missing' });
    }

    const cleanEmail = typeof email === 'string' ? email.trim() : '';
    const cleanName = typeof name === 'string' ? name.trim() : '';
    const cleanLineId = typeof lineId === 'string' ? lineId.trim() : '';
    const finalDeliveryChannel = deliveryChannel === 'line' ? 'line' : 'email';

    const { raw: step2Raw, webSummary, fullReport } = parseStep2Payload(step2AIResult);

    const payload = {
      shop_name: profile.shopName || null,
      shop_cat: profile.shopCat || null,
      hero_product: profile.heroProduct || null,
      monthly_orders: profile.monthlyOrders || null,
      target_orders: profile.targetOrders || null,
      main_problem: profile.mainProblem || null,

      customer_name: cleanName || null,
      customer_email: isValidEmail(cleanEmail) ? cleanEmail : null,
      customer_line_id: cleanLineId || null,

      payment_method: paymentMethod || null,
      payment_status: paymentStatus || 'pending',
      delivery_channel: finalDeliveryChannel,
      delivery_status: deliveryStatus || 'pending',

      quick_answers: asObject(quickAnswers),
      deep_answers: asObject(deepAnswers),

      version: version || 'shopcheck_v2',
      source: 'shopcheck-web',
      status: isValidEmail(cleanEmail) || cleanLineId ? 'new' : 'draft',

      step1_prompt: step1Prompt || null,
      step2_prompt: step2Prompt || null,
      step1_result_text: step1AIResult || null,
      step2_result_raw: step2Raw,
      step2_web_summary: webSummary,
      step2_full_report: fullReport,
      notes: typeof notes === 'string' ? notes.trim() || null : null
    };

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

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: submissionId ? 'Failed to update submission' : 'Failed to save submission',
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
