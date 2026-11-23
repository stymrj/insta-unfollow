/**
 * Insta Unfollow — payment + member backend (Cloudflare Worker).
 *
 * Creates Razorpay payment links, tracks their payment status and, once paid, issues
 * a signed premium entitlement that the extension verifies with its embedded public key.
 * Also keeps a registry of every user the extension has seen, and serves the admin
 * console that controls memberships. The Razorpay secret and the signing key never
 * leave this worker.
 *
 * DEPLOY (once):
 *   1. Create a worker on Cloudflare (dashboard) or:  npm i -g wrangler && wrangler deploy
 *   2. Create a KV namespace and bind it to the worker as PAYMENTS_KV.
 *   3. Set env vars:
 *        RAZORPAY_KEY_ID       — from dashboard.razorpay.com (API Keys)
 *        RAZORPAY_KEY_SECRET   — same page, keep secret
 *        RAZORPAY_WEBHOOK_SECRET — Razorpay webhook secret (dashboard -> Settings -> Webhooks)
 *        SIGN_PRIVATE_KEY      — the Ed25519 private seed hex (32 bytes)
 *        ADMIN_EMAIL           — the Google email that runs the admin console
 *   4. Put the worker URL in the extension's premium-config.js (PAYMENT_API_URL).
 *
 * ENDPOINTS
 *   POST /register          {googleId,email,name,picture}   -> user registry upsert
 *   POST /create-link       {plan: '1mo'|'3mo'|'6mo'|'9mo'|'12mo',userId} -> {short_url, linkId}
 *   GET  /status?u=<googleUserId>&email=<email>             -> {premium, token, pendingProof} | {banned}
 *   GET  /health                                            -> {ok:true}
 *   GET  /payment-methods                                   -> {paytm:false, upi:true, razorpay:false} (UPI only)
 *   POST /submit-proof    {userId, plan, method, utr, screenshot} -> {ok:true, proof}
 *   POST /webhook/razorpay   (HMAC-verified Razorpay webhook) -> {ok:true}
 *
 * PAYTM FIXED LINKS — DORMANT, kept exactly as the original code.
 *   When a plan has a fixed Paytm payment link set below (or as PAYTM_MONTHLY_URL /
 *   PAYTM_YEARLY_URL worker env vars), /create-link returns that link instead of creating
 *   a Razorpay one. Fixed links cannot be verified automatically — there is no webhook and
 *   no way to poll Paytm for the order, so the response says paytm:true/auto_verify:false
 *   and premium is activated from the admin console after the payment is confirmed.
 *   NOTE (2026-11-19): the Paytm-link option was DROPPED from the user-facing flow —
 *   Paytm dashboard links expire after max 3 days, so a static link would die in 3 days
 *   and need regenerating + a worker redeploy every 3 days. Nothing in the new flow calls
 *   /create-link for Paytm; UPI + screenshot proof is the only payment method. This block
 *   stays only so the old fallback still exists, dormant, if it is ever needed.
 *
 * ADMIN ENDPOINTS (Authorization: Bearer <admin token from /admin/login>)
 *   POST /admin/login      {googleToken}                    -> {token} (1h session)
 *   GET  /admin/stats                                       -> totals
 *   GET  /admin/users?q=<query>&page=<n>&limit=<n>          -> {users, total, page, pages}
 *   POST /admin/users/<id>/grant   {days}                   -> grant premium
 *   POST /admin/users/<id>/revoke                           -> remove premium
 *   POST /admin/users/<id>/ban                              -> block the account
 *   POST /admin/users/<id>/unban                            -> unblock
 *   POST /admin/users/<id>/delete                           -> remove every record
 *   GET  /admin/proofs?status=<pending|approved|rejected>&page=<n>&limit=<n>
 *                                                            -> {proofs, total, page, pages}
 *   GET  /admin/proofs/<id>                                 -> full proof, screenshot included
 *   POST /admin/proofs/<id>/approve                         -> grant premium, mark approved
 *   POST /admin/proofs/<id>/reject    {reason}              -> mark rejected
 */

/**
 * Razorpay amounts are in paise: ₹1 = 100 paise, so 1mo = ₹49 (4900 paise),
 * 3mo = ₹129 (12900 paise), 6mo = ₹249 (24900 paise), 9mo = ₹399 (39900 paise)
 * and 12mo = ₹499 (49900 paise). `days` is how many days of premium each plan
 * buys, counted from the payment date.
 */
const PLANS = {
  '1mo': { amount: 4900, currency: 'INR', days: 30, description: 'Insta Unfollow Premium — 1 Month' },
  '3mo': { amount: 12900, currency: 'INR', days: 90, description: 'Insta Unfollow Premium — 3 Months' },
  '6mo': { amount: 24900, currency: 'INR', days: 180, description: 'Insta Unfollow Premium — 6 Months' },
  '9mo': { amount: 39900, currency: 'INR', days: 270, description: 'Insta Unfollow Premium — 9 Months' },
  '12mo': { amount: 49900, currency: 'INR', days: 365, description: 'Insta Unfollow Premium — 12 Months' }
};

/**
 * Fixed Paytm payment links (one per plan). Paste the links Paytm business gave you below.
 * A worker env var PAYTM_MONTHLY_URL / PAYTM_YEARLY_URL overrides the matching entry.
 * Leave one empty to keep Razorpay for that plan.
 */
const PAYTM_FIXED_URLS = {
  monthly: 'PASTE-YOUR-PAYTM-MONTHLY-LINK-HERE',
  yearly: 'PASTE-YOUR-PAYTM-YEARLY-LINK-HERE'
};

const PREMIUM_DAYS = 365; // validity of one signed token
const ADMIN_SESSION_MS = 60 * 60 * 1000; // admin sessions last one hour
const ADMIN_PAYLOAD_KEY = 'adm';
const ADMIN_PROFILE_PREFIX = 'profile:';
const ADMIN_IDX_PREFIX = 'idx:email:';
const ADMIN_GRANT_PREFIX = 'grant:';
const ADMIN_BAN_PREFIX = 'ban:';
const ADMIN_PAYMENT_PREFIX = 'user:';
const PROOF_PREFIX = 'proof:';
/** Max screenshot size for a manual-payment proof: 1 MB of data-URL text. */
const MAX_PROOF_SCREENSHOT_CHARS = 1048576;

const base64url = {
  encode: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (str) => {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
};

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

/** PKCS8 DER for an Ed25519 seed is this fixed prefix followed by the 32 seed bytes. */
const ED25519_PKCS8_PREFIX = '302e020100300506032b657004220420';

async function importPrivateKey(env) {
  const der = new Uint8Array([...hexToBytes(ED25519_PKCS8_PREFIX), ...hexToBytes(env.SIGN_PRIVATE_KEY)]);
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function signMessage(env, message) {
  const key = await importPrivateKey(env);
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message));
}

/**
 * Admin tokens are signed with the worker's own key, and Ed25519 signatures are
 * deterministic, so verifying one is simply signing the same message again and
 * comparing signatures. This avoids deriving a public key from the seed, which
 * works everywhere the sign path does.
 */
async function verifyAdminToken(env, token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64url.decode(parts[1])));
  } catch (error) {
    return false;
  }
  if (!payload || payload[ADMIN_PAYLOAD_KEY] !== true || typeof payload.exp !== 'number') return false;
  if (Date.now() > payload.exp) return false;
  try {
    const expected = await signMessage(env, base64url.decode(parts[1]));
    return bytesEqual(expected, base64url.decode(parts[2]));
  } catch (error) {
    return false;
  }
}

async function signToken(env, userId, plan, expiresAt) {
  const payload = JSON.stringify({
    sub: String(userId),
    plan,
    exp: expiresAt || Date.now() + PREMIUM_DAYS * 24 * 60 * 60 * 1000,
    iss: 'insta-unfollow-worker'
  });
  const message = new TextEncoder().encode(payload);
  const signature = await signMessage(env, message);
  return `v1.${base64url.encode(message)}.${base64url.encode(signature)}`;
}

async function razorpay(env, path, options = {}) {
  const response = await fetch(`https://api.razorpay.com${path}`, {
    method: options.method || 'GET',
    headers: {
      'Authorization': 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`),
      'Content-Type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Razorpay ${path}: ${response.status} ${text}`);
  }
  return response.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

/**
 * Validate a Google access token (Authorization: Bearer <token>) by asking
 * Google who it belongs to. The returned user id must equal expectedId, and
 * when an email is supplied it must match the returned email (case-insensitive).
 * Any failure — missing token, Google fetch failing, id/email mismatch — is false.
 */
async function verifyGoogleAccessToken(token, expectedId, expectedEmail) {
  if (!token || !expectedId) return false;
  let response;
  try {
    response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
  } catch (error) {
    return false;
  }
  if (!response.ok) return false;
  const userInfo = await response.json();
  if (String(userInfo.id || '') !== String(expectedId)) return false;
  if (expectedEmail) {
    if (String(userInfo.email || '').toLowerCase() !== String(expectedEmail).toLowerCase()) return false;
  }
  return true;
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a Razorpay webhook signature: hex HMAC-SHA256 of the RAW request body,
 * keyed with env.RAZORPAY_WEBHOOK_SECRET. Sign-then-compare (constant-time
 * comparison) — Workers crypto.subtle has no direct HMAC verify shortcut here.
 * Missing secret or signature, or a mismatch, is false.
 */
async function verifyRazorpaySignature(env, rawBody, signature) {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.RAZORPAY_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  );
  const expected = bytesToHex(digest);
  return bytesEqual(
    new TextEncoder().encode(expected.toLowerCase()),
    new TextEncoder().encode(String(signature).toLowerCase())
  );
}

/** Expiry for a plan, anchored to the moment it was paid. */
function expiryForPlan(plan, paidAt) {
  const days = (PLANS[plan] && PLANS[plan].days) || 30;
  return paidAt + days * 24 * 60 * 60 * 1000;
}

/**
 * Fixed Paytm link for a plan, mirroring /create-link exactly: env var first,
 * then the PAYTM_FIXED_URLS table. Returns '' when nothing real is configured.
 */
function paytmUrlForPlan(env, plan) {
  const url = (env[`PAYTM_${String(plan).toUpperCase()}_URL`] || PAYTM_FIXED_URLS[plan] || '');
  return url && !url.includes('PASTE-YOUR') ? url : '';
}

/** Load every stored manual-payment proof (KV scan, paged until list_complete). */
async function listAllProofs(env) {
  const kv = env.PAYMENTS_KV;
  if (!kv) return [];
  const proofs = [];
  let cursor = null;
  let listComplete = false;
  do {
    const list = await kv.list({ prefix: PROOF_PREFIX, limit: 500, cursor: cursor || undefined });
    const chunk = await Promise.all(
      list.keys.map((k) => kv.get(k.name).then((raw) => JSON.parse(raw || 'null')))
    );
    proofs.push(...chunk.filter(Boolean));
    cursor = list.cursor;
    listComplete = list.list_complete;
  } while (!listComplete && cursor);
  return proofs;
}

/** The pending proof for one user+plan, if any (one pending proof per user+plan). */
async function findPendingProof(env, userId, plan) {
  const proofs = await listAllProofs(env);
  return proofs.find((p) => p.userId === String(userId) && p.plan === plan && p.status === 'pending') || null;
}

/** True when the user has any proof still under review (any plan). */
async function hasPendingProof(env, userId) {
  if (!userId) return false;
  const proofs = await listAllProofs(env);
  return proofs.some((p) => p.userId === String(userId) && p.status === 'pending');
}

/** Proof as list/approve/reject responses carry it: never the screenshot bytes. */
function proofPublic(proof) {
  if (!proof) return null;
  const { screenshot, ...rest } = proof;
  return rest;
}

/**
 * Grant premium for a plan, extending from the later of now and the current
 * grant's expiry so an existing grant is never shortened: the new period
 * starts when the old one ends. Returns the new expiry timestamp.
 */
async function grantPremiumForPlan(env, userId, plan, grantedBy) {
  const kv = env.PAYMENTS_KV;
  const days = (PLANS[plan] && PLANS[plan].days) || 30;
  const now = Date.now();
  let grantedAt = now;
  if (kv) {
    const existing = JSON.parse((await kv.get(`${ADMIN_GRANT_PREFIX}${userId}`)) || 'null');
    if (existing && existing.days && existing.grantedAt) {
      const currentExpiry = existing.grantedAt + existing.days * 24 * 60 * 60 * 1000;
      if (currentExpiry > now) {
        grantedAt = Math.max(now, currentExpiry - days * 24 * 60 * 60 * 1000);
      }
    }
    await kv.put(`${ADMIN_GRANT_PREFIX}${userId}`, JSON.stringify({
      days,
      plan,
      grantedAt,
      grantedBy: grantedBy || 'admin'
    }));
  }
  return grantedAt + days * 24 * 60 * 60 * 1000;
}

async function handleCreateLink(request, env) {
  const body = await request.json();
  const plan = PLANS[body.plan];
  if (!plan) return json({ error: 'unknown plan' }, 400);

  const userId = String(body.userId || '');
  if (!userId) return json({ error: 'missing userId' }, 400);

  // The caller must prove they are this Google user.
  if (!(await verifyGoogleAccessToken(bearerToken(request), userId, body.email || ''))) {
    return json({ error: 'unauthorized' }, 401);
  }

  // Fixed Paytm link for this plan? Return it directly; the extension opens it and the
  // admin confirms the payment from the console (no auto-verification possible).
  const paytmUrl = (env[`PAYTM_${body.plan.toUpperCase()}_URL`] || PAYTM_FIXED_URLS[body.plan] || '');
  if (paytmUrl && !paytmUrl.includes('PASTE-YOUR')) {
    return json({ short_url: paytmUrl, paytm: true, auto_verify: false });
  }

  const kv = env.PAYMENTS_KV;
  const key = `${ADMIN_PAYMENT_PREFIX}${userId}`;
  const existing = kv ? JSON.parse((await kv.get(key)) || 'null') : null;

  if (existing && existing.linkId && existing.plan === body.plan) {
    // Reuse a stored link ONLY while it is still live and for the same plan.
    // A link created for a different plan charges the wrong amount, and an
    // expired/cancelled link, or one whose expire_by has passed, is dead —
    // never hand either back; fall through and create a fresh one instead.
    const link = await razorpay(env, `/v1/payment_links/${existing.linkId}`);
    const live = link.status === 'created' || link.status === 'partially_paid';
    const notExpired = !link.expire_by || link.expire_by * 1000 > Date.now();
    if (live && notExpired) {
      if (kv) await kv.put(key, JSON.stringify({ ...existing, linkStatus: link.status }));
      return json({ short_url: link.short_url, linkId: link.id });
    }
  }

  const created = await razorpay(env, '/v1/payment_links', {
    method: 'POST',
    body: {
      amount: plan.amount,
      currency: plan.currency,
      description: plan.description,
      notes: { ext_user: userId },
      reminder_enable: false,
      expire_by: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
    }
  });

  if (kv) await kv.put(key, JSON.stringify({ linkId: created.id, plan: body.plan, createdAt: Date.now(), linkStatus: created.status || 'created' }));
  return json({ short_url: created.short_url, linkId: created.id });
}

/**
 * GET /payment-methods — public, no auth. Which payment methods are live right
 * now. UPI is the ONLY live method (the UPI ID lives in extension config, not the
 * worker). Paytm links were dropped 2026-11-19: Paytm dashboard links expire after
 * max 3 days, so a static link would die in 3 days. Razorpay is not set up (no keys).
 * The endpoint shape is kept for future methods.
 */
async function handlePaymentMethods(request, env) {
  return json({
    paytm: false,
    upi: true,
    razorpay: false
  });
}

/**
 * POST /submit-proof — manual-payment proof (UPI screenshot / Paytm screenshot).
 * The caller must prove they are this Google user (same check as /create-link).
 * One pending proof per user+plan: a second submission while one is under
 * review is a 409 naming the existing proof. Screenshots are capped at 1 MB.
 */
async function handleSubmitProof(request, env) {
  const kv = env.PAYMENTS_KV;
  if (!kv) return json({ error: 'KV not bound' }, 500);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'invalid JSON' }, 400);

  const userId = String(body.userId || '');
  if (!userId) return json({ error: 'missing userId' }, 400);

  // The caller must prove they are this Google user.
  if (!(await verifyGoogleAccessToken(bearerToken(request), userId, body.email || ''))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const plan = String(body.plan || '');
  if (!PLANS[plan]) return json({ error: 'plan must be one of 1mo, 3mo, 6mo, 9mo, 12mo' }, 400);
  const method = String(body.method || '');
  if (method !== 'upi' && method !== 'paytm') return json({ error: 'method must be upi or paytm' }, 400);

  const screenshot = body.screenshot;
  if (typeof screenshot !== 'string' || !screenshot.startsWith('data:image/')) {
    return json({ error: 'screenshot must be an image data URL' }, 400);
  }
  if (screenshot.length > MAX_PROOF_SCREENSHOT_CHARS) {
    return json({ error: 'screenshot exceeds the 1 MB limit' }, 413);
  }

  // One pending proof per user+plan: an earlier proof still under review blocks a new one.
  const existing = await findPendingProof(env, userId, plan);
  if (existing) {
    return json({
      error: 'A proof for this plan is already under review',
      proofId: existing.id,
      submittedAt: existing.submittedAt
    }, 409);
  }

  const proof = {
    id: crypto.randomUUID(),
    userId,
    email: String(body.email || ''),
    name: String(body.name || ''),
    plan,
    method,
    utr: String(body.utr || ''),
    screenshot,
    status: 'pending',
    submittedAt: Date.now()
  };
  await kv.put(`${PROOF_PREFIX}${proof.id}`, JSON.stringify(proof));
  return json({ ok: true, proof: proofPublic(proof) });
}

async function handleRegister(request, env) {
  const kv = env.PAYMENTS_KV;
  if (!kv) return json({ ok: false, error: 'KV not bound' }, 500);

  const body = await request.json();
  const googleId = String(body.googleId || '');
  if (!googleId) return json({ error: 'missing googleId' }, 400);

  // The caller must prove they are this Google user.
  if (!(await verifyGoogleAccessToken(bearerToken(request), googleId, body.email || ''))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const email = String(body.email || '').toLowerCase();
  const now = Date.now();
  const profileKey = `${ADMIN_PROFILE_PREFIX}${googleId}`;
  const existing = JSON.parse((await kv.get(profileKey)) || 'null');
  const profile = {
    id: googleId,
    email,
    name: String(body.name || existing?.name || ''),
    picture: String(body.picture || existing?.picture || ''),
    firstSeen: existing?.firstSeen || now,
    lastSeen: now
  };
  await kv.put(profileKey, JSON.stringify(profile));

  if (email) {
    const indexKey = `${ADMIN_IDX_PREFIX}${email}`;
    const current = await kv.get(indexKey);
    if (current && current !== googleId) {
      // An email should map to one user; if the account was recreated, keep the newest id.
      const currentProfile = JSON.parse((await kv.get(`${ADMIN_PROFILE_PREFIX}${current}`)) || 'null');
      if (!currentProfile || currentProfile.lastSeen < now) {
        await kv.put(indexKey, googleId);
      }
    } else if (!current) {
      await kv.put(indexKey, googleId);
    }
  }
  if (existing?.email && existing.email !== email) {
    const oldIndex = await kv.get(`${ADMIN_IDX_PREFIX}${existing.email}`);
    if (oldIndex === googleId) await kv.delete(`${ADMIN_IDX_PREFIX}${existing.email}`);
  }

  return json({ ok: true });
}

async function handleStatus(request, env) {
  const url = new URL(request.url);
  const userId = url.searchParams.get('u') || '';

  const kv = env.PAYMENTS_KV;
  const key = `${ADMIN_PAYMENT_PREFIX}${userId}`;

  // Manual-payment proof under review (any plan). Additive only — no existing
  // field changes value or meaning; every branch below carries it.
  const pendingProof = await hasPendingProof(env, userId);

  // Banned accounts stay banned; nothing below can restore them.
  const banned = kv ? await kv.get(`${ADMIN_BAN_PREFIX}${userId}`) : null;
  if (banned) return json({ banned: true, pendingProof });

  // An admin grant outranks everything and is re-signed from its own expiry date.
  const grantKey = `${ADMIN_GRANT_PREFIX}${userId}`;
  const grant = kv ? JSON.parse((await kv.get(grantKey)) || 'null') : null;
  if (grant && grant.days && grant.grantedAt) {
    const expiresAt = grant.grantedAt + grant.days * 24 * 60 * 60 * 1000;
    if (expiresAt > Date.now()) {
      const token = await signToken(env, userId, grant.plan || '1mo', expiresAt);
      return json({ premium: true, token, granted: true, pendingProof });
    }
  }

  const existing = kv ? JSON.parse((await kv.get(key)) || 'null') : null;

  // A paid, unrevoked record with a known expiry needs no Razorpay call: the
  // token is signed with that stored expiry, never a fresh 365 days.
  if (existing && existing.paid && !existing.revoked && existing.expiresAt) {
    if (existing.expiresAt > Date.now()) {
      const token = await signToken(env, userId, existing.plan || '1mo', existing.expiresAt);
      return json({ premium: true, token, pendingProof });
    }
    // Expired: fall through to the admin-email check, then {premium:false}.
    // The record is kept, not deleted.
  }

  if (existing && existing.linkId) {
    const now = Date.now();
    // Unpaid links are re-checked at most once every 5 minutes; a recent
    // negative check answers from the stored record without calling Razorpay.
    const recentlyChecked =
      !existing.paid &&
      existing.lastRazorpayCheck &&
      now - existing.lastRazorpayCheck < 5 * 60 * 1000;
    if (!recentlyChecked) {
      const link = await razorpay(env, `/v1/payment_links/${existing.linkId}`);
      if (link.status === 'paid') {
        // First time this payment is seen: anchor expiry to the payment moment.
        // A repeat sighting never moves paidAt/expiresAt.
        const paidAt = existing.paidAt || now;
        const expiresAt = existing.expiresAt || expiryForPlan(existing.plan || '1mo', paidAt);
        const updated = {
          ...existing,
          paid: true,
          paidAt,
          expiresAt,
          linkStatus: link.status,
          lastRazorpayCheck: now
        };
        if (kv) await kv.put(key, JSON.stringify(updated));
        // A revoked payment stays revoked even though Razorpay says paid.
        if (!updated.revoked && expiresAt > now) {
          const token = await signToken(env, userId, existing.plan || '1mo', expiresAt);
          return json({ premium: true, token, pendingProof });
        }
        // Revoked or already expired: fall through to {premium:false}.
      } else {
        if (kv) {
          await kv.put(
            key,
            JSON.stringify({ ...existing, linkStatus: link.status, lastRazorpayCheck: now })
          );
        }
      }
    }
  }

  const email = (url.searchParams.get('email') || '').toLowerCase();
  if (env.ADMIN_EMAIL && email === env.ADMIN_EMAIL.toLowerCase()) {
    const token = await signToken(env, userId, '1mo');
    return json({ premium: true, token, pendingProof });
  }

  return json({ premium: false, pendingProof });
}

/**
 * POST /webhook/razorpay — Razorpay payment-link webhook.
 * Verifies HMAC-SHA256 (header x-razorpay-signature over the raw body, keyed
 * with env.RAZORPAY_WEBHOOK_SECRET); 401 on a missing/bad secret or signature.
 * On payment_link.paid, marks that user's KV payment record paid, anchoring
 * paidAt/expiresAt to the event — only if not already paid, so repeat events
 * never move paidAt. Unknown events are acknowledged and ignored.
 */
async function handleRazorpayWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-razorpay-signature') || '';
  if (!(await verifyRazorpaySignature(env, rawBody, signature))) {
    return json({ error: 'invalid webhook signature' }, 401);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (error) {
    return json({ error: 'invalid JSON' }, 400);
  }

  // Razorpay sends either a flat payment_link object or the nested webhook
  // envelope payload.payment_link.entity — accept both.
  const linkRaw = body.payload?.payment_link || body.payment_link || null;
  const link = linkRaw?.entity || linkRaw || null;
  const event = body.event || '';
  const isPaid = event === 'payment_link.paid' || link?.status === 'paid';
  if (!isPaid) return json({ ok: true, ignored: true });

  const extUser =
    link?.notes?.ext_user ||
    link?.reference_id ||
    body.payload?.payment_link?.entity?.notes?.ext_user ||
    '';
  if (!extUser) return json({ ok: true, ignored: true });

  const kv = env.PAYMENTS_KV;
  if (kv) {
    const key = `${ADMIN_PAYMENT_PREFIX}${extUser}`;
    const existing = JSON.parse((await kv.get(key)) || 'null');
    if (!existing?.paid) {
      const now = Date.now();
      const plan = existing?.plan || '1mo';
      const paidAt = now;
      await kv.put(
        key,
        JSON.stringify({
          ...(existing || {}),
          linkId: link?.id || existing?.linkId || null,
          plan,
          paid: true,
          paidAt,
          expiresAt: expiryForPlan(plan, paidAt),
          linkStatus: 'paid',
          createdAt: existing?.createdAt || now
        })
      );
    }
    // Already paid: leave paidAt/expiresAt exactly as they are.
  }

  return json({ ok: true });
}

async function handleAdminLogin(request, env) {
  if (!env.ADMIN_EMAIL) return json({ error: 'ADMIN_EMAIL is not set on the worker' }, 500);
  const body = await request.json();
  const googleToken = String(body.googleToken || '');
  if (!googleToken) return json({ error: 'missing googleToken' }, 400);

  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { 'Authorization': `Bearer ${googleToken}`, 'Accept': 'application/json' }
  });
  if (!response.ok) return json({ error: 'invalid Google token' }, 401);
  const userInfo = await response.json();

  const email = String(userInfo.email || '').toLowerCase();
  if (email !== env.ADMIN_EMAIL.toLowerCase()) {
    return json({ error: 'not an admin account' }, 403);
  }

  const payload = JSON.stringify({
    [ADMIN_PAYLOAD_KEY]: true,
    sub: email,
    exp: Date.now() + ADMIN_SESSION_MS,
    iss: 'insta-unfollow-admin'
  });
  const message = new TextEncoder().encode(payload);
  const signature = await signMessage(env, message);
  return json({ token: `v1.${base64url.encode(message)}.${base64url.encode(signature)}`, email });
}

async function adminAuthorize(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return verifyAdminToken(env, token);
}

/** Enrich profile records with payment, grant and ban state. */
async function loadUserState(env, profiles) {
  const kv = env.PAYMENTS_KV;
  if (!kv) return profiles.map((p) => ({ ...p, payment: null, grant: null, banned: false }));
  const results = await Promise.all(
    profiles.map(async (profile) => {
      const [payment, grant, banned] = await Promise.all([
        kv.get(`${ADMIN_PAYMENT_PREFIX}${profile.id}`),
        kv.get(`${ADMIN_GRANT_PREFIX}${profile.id}`),
        kv.get(`${ADMIN_BAN_PREFIX}${profile.id}`)
      ]);
      return {
        ...profile,
        payment: payment ? JSON.parse(payment) : null,
        grant: grant ? JSON.parse(grant) : null,
        banned: Boolean(banned)
      };
    })
  );
  return results;
}

function membershipOf(user) {
  if (user.banned) return { status: 'banned', label: 'Banned' };
  // A grant counts only while it is still inside its own window.
  if (user.grant && user.grant.days && user.grant.grantedAt) {
    const expiresAt = user.grant.grantedAt + user.grant.days * 24 * 60 * 60 * 1000;
    if (expiresAt > Date.now()) return { status: 'grant', label: 'Premium', granted: true };
  }
  const payment = user.payment;
  if (payment && payment.paid && !payment.revoked && payment.expiresAt && payment.expiresAt > Date.now()) {
    return { status: 'premium', label: 'Premium', paid: true };
  }
  // Revoked takes precedence over expired: a revoked payment that has not
  // yet expired reads 'Revoked'; a revoked payment past its expiry is just Free.
  // A paid record with no expiresAt is a legacy record — treat it as Free.
  if (payment && payment.paid && payment.revoked && payment.expiresAt && payment.expiresAt > Date.now()) {
    return { status: 'revoked', label: 'Revoked' };
  }
  return { status: 'free', label: 'Free' };
}

function findIndex(records, prefix, id) {
  return records.findIndex((r) => r.startsWith(`${prefix}${id}`));
}

function matchQuery(user, q) {
  if (!q) return true;
  const haystack = `${user.id} ${user.name} ${user.email}`.toLowerCase();
  return haystack.includes(q);
}

async function handleAdminUsers(request, env) {
  const kv = env.PAYMENTS_KV;
  if (!kv) return json({ error: 'KV not bound' }, 500);

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10) || 25));

  // Scan in chunks; a query that matches few rows may need several round trips.
  // Keep listing with the returned cursor until list_complete is true — KV
  // pages at most 500 keys per list call.
  const profiles = [];
  let cursor = null;
  let listComplete = false;
  do {
    const list = await kv.list({ prefix: ADMIN_PROFILE_PREFIX, limit: 500, cursor: cursor || undefined });
    const chunk = await Promise.all(
      list.keys.map((k) => kv.get(k.name).then((raw) => JSON.parse(raw || 'null')))
    );
    profiles.push(...chunk.filter(Boolean));
    cursor = list.cursor;
    listComplete = list.list_complete;
  } while (!listComplete && cursor);

  const users = (await loadUserState(env, profiles))
    .map((u) => {
      const membership = membershipOf(u);
      const grantExpiresAt =
        u.grant && u.grant.days && u.grant.grantedAt
          ? u.grant.grantedAt + u.grant.days * 24 * 60 * 60 * 1000
          : null;
      return {
        ...u,
        membership,
        plan: u.grant?.plan || u.payment?.plan || null,
        paidAt: u.payment?.paidAt || null,
        expiresAt: grantExpiresAt || u.payment?.expiresAt || null,
        revoked: Boolean(u.payment?.revoked),
        linkStatus: u.payment?.linkStatus || null
      };
    })
    .filter((u) => matchQuery(u, q))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  const total = users.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const slice = users.slice((page - 1) * limit, page * limit);
  return { users: slice, total, page, pages };
}

async function handleAdminStats(env) {
  const kv = env.PAYMENTS_KV;
  if (!kv) return json({ error: 'KV not bound' }, 500);

  const profiles = [];
  let cursor = null;
  let listComplete = false;
  do {
    const list = await kv.list({ prefix: ADMIN_PROFILE_PREFIX, limit: 500, cursor: cursor || undefined });
    const chunk = await Promise.all(
      list.keys.map((k) => kv.get(k.name).then((raw) => JSON.parse(raw || 'null')))
    );
    profiles.push(...chunk.filter(Boolean));
    cursor = list.cursor;
    listComplete = list.list_complete;
  } while (!listComplete && cursor);

  const users = await loadUserState(env, profiles);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayMs = dayStart.getTime();

  let premium = 0;
  let banned = 0;
  let newToday = 0;
  for (const user of users) {
    const membership = membershipOf(user);
    if (user.banned) banned++;
    else if (membership.status === 'grant' || membership.status === 'premium') premium++;
    if ((user.firstSeen || 0) >= dayMs) newToday++;
  }

  return {
    total: users.length,
    premium,
    free: users.length - premium - banned,
    banned,
    newToday
  };
}

async function handleAdminUserAction(request, env, userId, action) {
  const kv = env.PAYMENTS_KV;
  if (!kv) return json({ error: 'KV not bound' }, 500);

  const profileKey = `${ADMIN_PROFILE_PREFIX}${userId}`;
  const profile = JSON.parse((await kv.get(profileKey)) || 'null');
  if (!profile) return json({ error: 'user not found' }, 404);

  if (action === 'grant') {
    const body = await request.json().catch(() => ({}));
    const days = parseInt(body.days, 10);
    if (![7, 30, 90, 180, 270, 365].includes(days)) return json({ error: 'days must be 7, 30, 90, 180, 270 or 365' }, 400);
    const grantPlan = { 7: 'trial', 30: '1mo', 90: '3mo', 180: '6mo', 270: '9mo', 365: '12mo' }[days];
    await kv.put(`${ADMIN_GRANT_PREFIX}${userId}`, JSON.stringify({
      days,
      plan: grantPlan,
      grantedAt: Date.now(),
      grantedBy: request.headers.get('X-Admin-Email') || 'admin'
    }));
    return json({ ok: true, days });
  }

  if (action === 'revoke') {
    await kv.delete(`${ADMIN_GRANT_PREFIX}${userId}`);
    // Revoke never deletes the payment record: mark it revoked so /status
    // and the admin console keep showing it as Revoked, not Premium.
    const paymentKey = `${ADMIN_PAYMENT_PREFIX}${userId}`;
    const existingPayment = JSON.parse((await kv.get(paymentKey)) || 'null');
    if (existingPayment) {
      await kv.put(
        paymentKey,
        JSON.stringify({ ...existingPayment, revoked: true, revokedAt: Date.now() })
      );
    }
    return json({ ok: true });
  }

  if (action === 'ban') {
    await kv.put(`${ADMIN_BAN_PREFIX}${userId}`, JSON.stringify({ bannedAt: Date.now() }));
    await kv.delete(`${ADMIN_GRANT_PREFIX}${userId}`);
    return json({ ok: true });
  }

  if (action === 'unban') {
    await kv.delete(`${ADMIN_BAN_PREFIX}${userId}`);
    return json({ ok: true });
  }

  if (action === 'delete') {
    await kv.delete(profileKey);
    await kv.delete(`${ADMIN_IDX_PREFIX}${profile.email || ''}`);
    await kv.delete(`${ADMIN_PAYMENT_PREFIX}${userId}`);
    await kv.delete(`${ADMIN_GRANT_PREFIX}${userId}`);
    await kv.delete(`${ADMIN_BAN_PREFIX}${userId}`);
    return json({ ok: true });
  }

  return json({ error: 'unknown action' }, 400);
}

/**
 * GET /admin/proofs?status=<pending|approved|rejected>&page=<n>&limit=<n>
 * Lists proofs WITHOUT the screenshot bytes, newest first. Same page/limit
 * defaults and clamping as /admin/users. An unknown status value lists all.
 */
async function handleAdminProofs(request, env) {
  const kv = env.PAYMENTS_KV;
  if (!kv) return json({ error: 'KV not bound' }, 500);

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status') || '';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10) || 25));

  let proofs = await listAllProofs(env);
  if (['pending', 'approved', 'rejected'].includes(statusFilter)) {
    proofs = proofs.filter((p) => p.status === statusFilter);
  }
  proofs.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

  const total = proofs.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const slice = proofs.slice((page - 1) * limit, page * limit).map(proofPublic);
  return { proofs: slice, total, page, pages };
}

/** GET /admin/proofs/<id> — the full proof, screenshot data URL included. */
async function handleAdminProofDetail(env, proofId) {
  const kv = env.PAYMENTS_KV;
  if (!kv) return json({ error: 'KV not bound' }, 500);
  const proof = JSON.parse((await kv.get(`${PROOF_PREFIX}${proofId}`)) || 'null');
  if (!proof) return json({ error: 'proof not found' }, 404);
  return json(proof);
}

/**
 * POST /admin/proofs/<id>/approve — grants premium with the existing grant
 * logic (extending, never shortening, an existing grant) and marks the proof
 * approved. No token work: /status re-signs tokens from the grant expiry.
 */
async function handleAdminProofApprove(env, proofId, adminEmail) {
  const kv = env.PAYMENTS_KV;
  if (!kv) return json({ error: 'KV not bound' }, 500);
  const proof = JSON.parse((await kv.get(`${PROOF_PREFIX}${proofId}`)) || 'null');
  if (!proof) return json({ error: 'proof not found' }, 404);
  if (proof.status === 'approved') return json({ error: 'proof already approved', proof: proofPublic(proof) }, 400);

  const expiresAt = await grantPremiumForPlan(env, proof.userId, proof.plan, adminEmail);
  const updated = { ...proof, status: 'approved', reviewedAt: Date.now(), reviewedBy: adminEmail };
  await kv.put(`${PROOF_PREFIX}${proof.id}`, JSON.stringify(updated));
  return json({ ok: true, proof: proofPublic(updated), expiresAt });
}

/**
 * POST /admin/proofs/<id>/reject — marks the proof rejected. A rejected proof
 * must never un-grant, so an already-approved proof is a 400. The user may
 * submit a fresh proof afterwards (the 409 check only blocks pending proofs).
 */
async function handleAdminProofReject(request, env, proofId, adminEmail) {
  const kv = env.PAYMENTS_KV;
  if (!kv) return json({ error: 'KV not bound' }, 500);
  const proof = JSON.parse((await kv.get(`${PROOF_PREFIX}${proofId}`)) || 'null');
  if (!proof) return json({ error: 'proof not found' }, 404);
  if (proof.status === 'approved') return json({ error: 'proof already approved', proof: proofPublic(proof) }, 400);

  const body = await request.json().catch(() => ({}));
  const updated = {
    ...proof,
    status: 'rejected',
    reviewedAt: Date.now(),
    reviewedBy: adminEmail,
    reason: String((body && body.reason) || '')
  };
  await kv.put(`${PROOF_PREFIX}${proof.id}`, JSON.stringify(updated));
  return json({ ok: true, proof: proofPublic(updated) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization'
        }
      });
    }

    try {
      if (pathname === '/register' && request.method === 'POST') return await handleRegister(request, env);
      if (pathname === '/create-link' && request.method === 'POST') return await handleCreateLink(request, env);
      if (pathname === '/webhook/razorpay' && request.method === 'POST') return await handleRazorpayWebhook(request, env);
      if (pathname === '/status') return await handleStatus(request, env);
      if (pathname === '/health') return json({ ok: true });
      if (pathname === '/payment-methods' && request.method === 'GET') return await handlePaymentMethods(request, env);
      if (pathname === '/submit-proof' && request.method === 'POST') return await handleSubmitProof(request, env);

      if (pathname === '/admin/login' && request.method === 'POST') {
        return await handleAdminLogin(request, env);
      }

      // Everything below /admin requires a fresh admin session.
      if (pathname.startsWith('/admin/')) {
        if (!(await adminAuthorize(request, env))) {
          return json({ error: 'admin session invalid or expired' }, 401);
        }
        const adminEmail = String(env.ADMIN_EMAIL || '').toLowerCase();

        if (pathname === '/admin/stats' && request.method === 'GET') {
          return json({ ...(await handleAdminStats(env)), adminEmail });
        }
        if (pathname === '/admin/users' && request.method === 'GET') {
          return json({ ...(await handleAdminUsers(request, env)), adminEmail });
        }
        if (pathname === '/admin/proofs' && request.method === 'GET') {
          return json({ ...(await handleAdminProofs(request, env)), adminEmail });
        }
        if (pathname.startsWith('/admin/proofs/')) {
          const segments = pathname.split('/').filter(Boolean);
          const proofId = decodeURIComponent(segments[2] || '');
          const action = segments[3] || '';
          if (proofId && !action && request.method === 'GET') {
            return await handleAdminProofDetail(env, proofId);
          }
          if (proofId && action === 'approve' && request.method === 'POST') {
            return await handleAdminProofApprove(env, proofId, adminEmail);
          }
          if (proofId && action === 'reject' && request.method === 'POST') {
            return await handleAdminProofReject(request, env, proofId, adminEmail);
          }
        }
        if (pathname.startsWith('/admin/users/')) {
          const segments = pathname.split('/').filter(Boolean);
          const userId = decodeURIComponent(segments[2] || '');
          const action = segments[3] || '';
          if (userId && ['grant', 'revoke', 'ban', 'unban', 'delete'].includes(action)) {
            const requestWithAdmin = new Request(request, { headers: { ...Object.fromEntries(request.headers), 'X-Admin-Email': adminEmail } });
            return await handleAdminUserAction(requestWithAdmin, env, userId, action);
          }
        }
      }

      return json({ error: 'not found' }, 404);
    } catch (error) {
      return json({ error: String((error && error.message) || error) }, 500);
    }
  }
};
