// ============================================================
// /api/claim-trial
// ------------------------------------------------------------
// Called when the user clicks "ปลดล็อกฟรี (Trial)" on the Part 1
// result screen. This is the gate that grants free Part 2 access.
// It performs an ATOMIC single-seat claim so that even if the FB
// link is shared and two people click at exactly the same moment,
// only one of them wins.
//
// Request body:
//   {
//     fingerprint: string,      // stable per-browser id (required)
//     submissionId?: string,    // supabase submission row id
//     email?: string,           // optional, becomes second lock
//     lineId?: string,
//     userAgent?: string
//   }
//
// Response shape on success:
//   { ok: true, claim: { id, claimed_at, fingerprint, email } }
//
// Response shape on rejection:
//   409 { ok: false, reason: "already_claimed" | "budget_exhausted" | "trial_closed" }
//
// Required env vars (same set as verify-trial.js).
// ============================================================

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_\-]{8,64}$/.test(trimmed)) return null;
  return trimmed;
}

function extractIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  if (Array.isArray(xf) && xf.length) return String(xf[0]).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { fingerprint, submissionId, email, lineId, userAgent } = req.body || {};

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const table = process.env.SHOPCHECK_TRIAL_CLAIMS_TABLE || 'shopcheck_trial_claims';
    const trialOpenFlag = String(process.env.SHOPCHECK_TRIAL_OPEN || 'false').toLowerCase() === 'true';
    const budgetRaw = Number(process.env.SHOPCHECK_TRIAL_BUDGET ?? 50);
    const budget = Number.isFinite(budgetRaw) ? budgetRaw : 50;

    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: 'Supabase env vars are missing' });
    }

    if (!trialOpenFlag) {
      return res.status(409).json({ ok: false, reason: 'trial_closed' });
    }

    const fp = normalizeFingerprint(fingerprint);
    if (!fp) {
      return res.status(400).json({ ok: false, reason: 'invalid_fingerprint' });
    }

    const em = normalizeEmail(email);
    const cleanLineId = typeof lineId === 'string' ? lineId.trim() || null : null;
    const cleanUA = typeof userAgent === 'string' ? userAgent.slice(0, 400) : null;
    const ip = extractIp(req);

    const headers = {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    };

    // --- Step A: fast pre-check. Has this fp/email already claimed? ---
    // (The unique partial indexes in the DB are the real guarantee —
    //  this pre-check just lets us return a clean 409 before the INSERT.)
    const conditions = [`fingerprint.eq.${encodeURIComponent(fp)}`];
    if (em) conditions.push(`email.eq.${encodeURIComponent(em)}`);
    const orClause = `or=(${conditions.join(',')})`;

    const dupRes = await fetch(
      `${supabaseUrl}/rest/v1/${table}?select=id&revoked=eq.false&${orClause}&limit=1`,
      { headers }
    );
    if (dupRes.ok) {
      const rows = await dupRes.json();
      if (Array.isArray(rows) && rows.length > 0) {
        return res.status(409).json({ ok: false, reason: 'already_claimed' });
      }
    }

    // --- Step B: budget check ---
    if (budget >= 0) {
      const countRes = await fetch(
        `${supabaseUrl}/rest/v1/${table}?select=id&revoked=eq.false`,
        { headers: { ...headers, Prefer: 'count=exact', Range: '0-0' } }
      );
      const contentRange = countRes.headers.get('content-range') || '';
      const match = contentRange.match(/\/(\d+)$/);
      const activeClaims = match ? Number(match[1]) : 0;
      if (activeClaims >= budget) {
        return res.status(409).json({ ok: false, reason: 'budget_exhausted' });
      }
    }

    // --- Step C: INSERT. The unique indexes guarantee single-winner. ---
    const payload = {
      fingerprint: fp,
      email: em,
      line_id: cleanLineId,
      submission_id: submissionId || null,
      ip: ip || null,
      user_agent: cleanUA
    };

    const insertRes = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify(payload)
    });

    const inserted = await insertRes.json();

    if (!insertRes.ok) {
      // 23505 = unique_violation. Someone else claimed the same fp/email
      // in the microsecond gap between step A and step C (race lost).
      const code = inserted?.code || inserted?.details || '';
      if (String(code).includes('23505') || String(inserted?.message || '').toLowerCase().includes('duplicate')) {
        return res.status(409).json({ ok: false, reason: 'already_claimed' });
      }
      return res.status(500).json({
        ok: false,
        reason: 'insert_failed',
        details: inserted
      });
    }

    const row = Array.isArray(inserted) ? inserted[0] : inserted;

    return res.status(200).json({
      ok: true,
      claim: {
        id: row?.id || null,
        claimed_at: row?.claimed_at || null,
        fingerprint: row?.fingerprint || fp,
        email: row?.email || em
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      reason: 'server_error',
      details: error.message
    });
  }
}
