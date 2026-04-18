// ============================================================
// /api/verify-trial
// ------------------------------------------------------------
// Called by the frontend on page load when the URL contains a
// trial flag (e.g. ?trial=1). Answers two questions:
//   1) Is the trial currently open? (env flag + budget)
//   2) Has THIS visitor already used their free seat?
//
// Response shape:
//   {
//     open: boolean,             // trial window is on
//     budgetLeft: number,        // seats remaining (or -1 = unlimited)
//     alreadyClaimed: boolean,   // this fingerprint/email already used
//     closedReason: string|null  // "off" | "budget" | null
//   }
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SHOPCHECK_TRIAL_OPEN          "true" | "false"  (default "false")
//   SHOPCHECK_TRIAL_BUDGET        integer, e.g. "50" (default 50; set "-1" for unlimited)
//   SHOPCHECK_TRIAL_CLAIMS_TABLE  default "shopcheck_trial_claims"
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { fingerprint, email } = req.body || {};

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const table = process.env.SHOPCHECK_TRIAL_CLAIMS_TABLE || 'shopcheck_trial_claims';
    const trialOpenFlag = String(process.env.SHOPCHECK_TRIAL_OPEN || 'false').toLowerCase() === 'true';
    const budgetRaw = Number(process.env.SHOPCHECK_TRIAL_BUDGET ?? 50);
    const budget = Number.isFinite(budgetRaw) ? budgetRaw : 50;

    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: 'Supabase env vars are missing' });
    }

    // --- 1) Trial switch off → always closed ---
    if (!trialOpenFlag) {
      return res.status(200).json({
        open: false,
        budgetLeft: 0,
        alreadyClaimed: false,
        closedReason: 'off'
      });
    }

    const headers = {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    };

    // --- 2) How many active claims so far? (budget check) ---
    let activeClaims = 0;
    if (budget >= 0) {
      const countRes = await fetch(
        `${supabaseUrl}/rest/v1/${table}?select=id&revoked=eq.false`,
        { headers: { ...headers, Prefer: 'count=exact', Range: '0-0' } }
      );
      const contentRange = countRes.headers.get('content-range') || '';
      const match = contentRange.match(/\/(\d+)$/);
      activeClaims = match ? Number(match[1]) : 0;
    }

    const budgetLeft = budget < 0 ? -1 : Math.max(0, budget - activeClaims);
    const trialOpen = budget < 0 || activeClaims < budget;

    // --- 3) Has this visitor already claimed? ---
    const fp = normalizeFingerprint(fingerprint);
    const em = normalizeEmail(email);

    let alreadyClaimed = false;
    if (fp || em) {
      const conditions = [];
      if (fp) conditions.push(`fingerprint.eq.${encodeURIComponent(fp)}`);
      if (em) conditions.push(`email.eq.${encodeURIComponent(em)}`);
      const orClause = `or=(${conditions.join(',')})`;

      const dupRes = await fetch(
        `${supabaseUrl}/rest/v1/${table}?select=id&revoked=eq.false&${orClause}&limit=1`,
        { headers }
      );
      if (dupRes.ok) {
        const rows = await dupRes.json();
        alreadyClaimed = Array.isArray(rows) && rows.length > 0;
      }
    }

    return res.status(200).json({
      open: trialOpen,
      budgetLeft,
      alreadyClaimed,
      closedReason: trialOpen ? null : 'budget'
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Unexpected server error',
      details: error.message
    });
  }
}
