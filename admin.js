/**
 * Admin console: lists every user the extension has registered with the payment worker
 * and controls their membership. Only the worker's ADMIN_EMAIL can open a session —
 * the Google token is exchanged server-side for a one-hour signed admin token.
 */
(function () {
  'use strict';

  const state = {
    adminToken: null,
    page: 1,
    query: '',
    limit: 25,
    total: 0,
    pages: 1,
    searchTimer: null
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtDate(ms) {
    if (!ms) return '–';
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDuration(ms) {
    if (!ms) return '–';
    const days = Math.floor(ms / 86400000);
    if (days >= 1) return days + 'd ago';
    const hours = Math.floor(ms / 3600000);
    if (hours >= 1) return hours + 'h ago';
    const minutes = Math.max(1, Math.floor(ms / 60000));
    return minutes + 'm ago';
  }

  let toastTimer = null;
  function toast(message, ok = true) {
    const el = $('adminToast');
    if (!el) return;
    el.textContent = message;
    el.className = 'admin-toast ' + (ok ? 'ok' : 'err');
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3200);
  }

  function showGate(name) {
    ['gateLogin', 'gateDenied', 'gateConfig', 'gateError'].forEach((id) => {
      $(id).style.display = id === name ? 'flex' : 'none';
    });
    $('adminGate').style.display = 'flex';
    $('adminPanel').style.display = 'none';
  }

  async function adminLogin() {
    const { auth_token } = await chrome.storage.local.get('auth_token');
    let response = await postAdminLogin(auth_token);

    // Google access tokens expire after about an hour, and the stored one is reused
    // until then. When the worker rejects it, run a fresh Google sign-in and retry once.
    if (response.status === 401) {
      const fresh = await chrome.runtime.sendMessage({ action: 'googleLogin' });
      if (!fresh || !fresh.success) {
        throw new Error('Google login expired — please sign in again.');
      }
      const { auth_token: freshToken } = await chrome.storage.local.get('auth_token');
      response = await postAdminLogin(freshToken);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.token) {
      throw new Error(payload.error || ('admin login failed: ' + response.status));
    }
    state.adminToken = payload.token;
  }

  async function postAdminLogin(googleToken) {
    return fetch(window.PAYMENT_API_URL + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ googleToken })
    });
  }

  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (state.adminToken) headers['Authorization'] = 'Bearer ' + state.adminToken;
    const response = await fetch(window.PAYMENT_API_URL + path, Object.assign({}, options, { headers }));
    if (response.status === 401) {
      // Session expired mid-work — log in again and retry once.
      await adminLogin();
      headers['Authorization'] = 'Bearer ' + state.adminToken;
      return fetch(window.PAYMENT_API_URL + path, Object.assign({}, options, { headers }));
    }
    return response;
  }

  async function loadUsers() {
    const response = await api('/admin/users?q=' + encodeURIComponent(state.query) +
      '&page=' + state.page + '&limit=' + state.limit);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'failed to load users');
    state.total = payload.total || 0;
    state.pages = payload.pages || 1;
    state.page = Math.min(state.page, state.pages);
    renderUsers(payload.users || []);
    renderPagination();
  }

  async function loadStats() {
    const response = await api('/admin/stats');
    const stats = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(stats.error || 'failed to load stats');
    $('statTotal').textContent = stats.total != null ? stats.total : '–';
    $('statPremium').textContent = stats.premium != null ? stats.premium : '–';
    $('statFree').textContent = stats.free != null ? stats.free : '–';
    $('statBanned').textContent = stats.banned != null ? stats.banned : '–';
  }

  // Five-plan labels (final prices set by the owner, 2026-11-19).
  // Unknown / old plan values fall through to the raw value, never a crash.
  const PLAN_LABELS = {
    '1mo': '1 month · ₹49',
    '3mo': '3 months · ₹129',
    '6mo': '6 months · ₹249',
    '9mo': '9 months · ₹399',
    '12mo': '12 months · ₹499',
    trial: 'Trial · 7 days'
  };

  function planLabel(plan) {
    if (plan != null && Object.prototype.hasOwnProperty.call(PLAN_LABELS, plan)) return PLAN_LABELS[plan];
    return plan || '—';
  }

  // Grant durations offered in the admin console: plan key -> days.
  const GRANT_DURATIONS = [
    { days: 10, label: '10 days (Promo)' },
    { days: 7, label: '7 days (Trial)' },
    { days: 14, label: '14 days' },
    { days: 30, label: '1 month' },
    { days: 90, label: '3 months' },
    { days: 180, label: '6 months' },
    { days: 270, label: '9 months' },
    { days: 365, label: '12 months' },
    { days: 'custom', label: 'Custom days…' }
  ];

  function methodLabel(method) {
    if (method === 'upi') return 'UPI';
    if (method === 'paytm') return 'Paytm';
    return method || '—';
  }

  async function loadProofs() {
    const response = await api('/admin/proofs?status=pending&page=1&limit=25');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'failed to load pending payments');
    renderProofs(payload.proofs || []);
  }

  function renderProofs(proofs) {
    const container = $('adminProofs');
    const empty = $('adminProofsEmpty');
    if (!container || !empty) return;
    empty.style.display = proofs.length ? 'none' : 'block';
    container.innerHTML = '';
    if (!proofs.length) return;

    const fragment = document.createDocumentFragment();
    proofs.forEach((proof) => {
      const card = document.createElement('div');
      card.className = 'admin-proof';
      card.dataset.proofId = proof.id;
      card.dataset.email = proof.email || '';
      card.dataset.plan = proof.plan || '';

      const meta = document.createElement('div');
      meta.className = 'admin-proof-meta';
      const nameEl = document.createElement('span');
      nameEl.className = 'admin-user-name';
      nameEl.textContent = proof.name || '(no name)';
      const emailEl = document.createElement('span');
      emailEl.className = 'admin-user-email';
      emailEl.textContent = proof.email || '';
      meta.appendChild(nameEl);
      meta.appendChild(emailEl);
      card.appendChild(meta);

      const submittedMs = new Date(proof.submittedAt).getTime();
      const details = document.createElement('div');
      details.className = 'admin-proof-details';
      const planEl = document.createElement('span');
      planEl.textContent = planLabel(proof.plan);
      const methodEl = document.createElement('span');
      methodEl.textContent = methodLabel(proof.method);
      const utrEl = document.createElement('span');
      utrEl.textContent = 'UTR ' + (proof.utr || '—');
      const submittedEl = document.createElement('span');
      submittedEl.className = 'admin-date-cell';
      submittedEl.title = fmtDate(submittedMs);
      submittedEl.textContent = fmtDuration(Date.now() - submittedMs);
      details.appendChild(planEl);
      details.appendChild(methodEl);
      details.appendChild(utrEl);
      details.appendChild(submittedEl);
      card.appendChild(details);

      const actions = document.createElement('div');
      actions.className = 'admin-actions';
      actions.appendChild(proofButton('view', 'View', 'secondary'));
      actions.appendChild(proofButton('approve', 'Approve', 'primary'));
      actions.appendChild(proofButton('reject', 'Reject', 'danger'));
      card.appendChild(actions);

      fragment.appendChild(card);
    });
    container.appendChild(fragment);
  }

  function proofButton(action, label, kind) {
    const button = document.createElement('button');
    button.className = 'admin-action-btn ' + kind;
    button.dataset.action = action;
    button.textContent = label;
    return button;
  }

  function renderUsers(users) {
    const body = $('adminTableBody');
    $('adminEmpty').style.display = users.length ? 'none' : 'block';
    body.innerHTML = '';
    if (!users.length) return;

    const fragment = document.createDocumentFragment();
    users.forEach((user, index) => {
      const membership = user.membership || {};
      // NOTE (coordinator fix): `status` was used bare below with no declaration,
      // so it resolved to window.status ('') and no Grant/Revoke/Ban button or
      // badge class ever matched. Declare it from the membership payload.
      const status = membership.status || 'free';
      const tr = document.createElement('tr');
      tr.dataset.userId = user.id;

      const numberTd = document.createElement('td');
      numberTd.className = 'row-number';
      numberTd.textContent = String((state.page - 1) * state.limit + index + 1);

      const userTd = document.createElement('td');
      const cell = document.createElement('div');
      cell.className = 'profile-cell';
      const img = document.createElement('img');
      img.className = 'profile-image';
      img.alt = '';
      img.src = user.picture || '';
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      const meta = document.createElement('div');
      meta.className = 'admin-user-meta';
      const nameEl = document.createElement('span');
      nameEl.className = 'admin-user-name';
      nameEl.textContent = user.name || '(no name)';
      const emailEl = document.createElement('span');
      emailEl.className = 'admin-user-email';
      emailEl.textContent = user.email || '';
      meta.appendChild(nameEl);
      meta.appendChild(emailEl);
      cell.appendChild(img);
      cell.appendChild(meta);
      userTd.appendChild(cell);

      const idTd = document.createElement('td');
      idTd.className = 'admin-id-cell';
      idTd.textContent = user.id;

      const joinedTd = document.createElement('td');
      joinedTd.className = 'admin-date-cell';
      joinedTd.title = fmtDate(user.firstSeen);
      joinedTd.textContent = fmtDuration(Date.now() - (user.firstSeen || 0));

      const seenTd = document.createElement('td');
      seenTd.className = 'admin-date-cell';
      seenTd.title = fmtDate(user.lastSeen);
      seenTd.textContent = fmtDuration(Date.now() - (user.lastSeen || 0));

      const badgeTd = document.createElement('td');
      const badge = document.createElement('span');
      const isRevoked = status === 'revoked' || (user.revoked === true && status !== 'banned');
      const effectiveStatus = isRevoked ? 'revoked' : status;
      // theme.css has no .admin-badge.revoked rule, so reuse the muted free styling.
      badge.className = 'admin-badge ' + (isRevoked ? 'free' : status);
      badge.textContent = isRevoked ? (membership.label || 'Revoked') : (membership.label || 'Free');
      if (status === 'grant' || status === 'premium') {
        const sub = document.createElement('span');
        sub.className = 'admin-badge-sub';
        const plan = user.plan || membership.plan || (user.payment && user.payment.plan) || '';
        const planText = plan ? planLabel(plan) : '';
        const expiresAt = user.expiresAt || membership.expiresAt || null;
        let subText = '';
        if (expiresAt) {
          const leftDays = Math.max(0, Math.round((expiresAt - Date.now()) / 86400000));
          subText = ' · ' + (planText ? planText + ' · ' : '') + leftDays + 'd left';
        } else if (status === 'grant' && user.grant && user.grant.grantedAt && user.grant.days) {
          const left = (user.grant.grantedAt + user.grant.days * 86400000) - Date.now();
          subText = ' · ' + (planText ? planText + ' · ' : '') + Math.max(0, Math.round(left / 86400000)) + 'd left';
        } else if (user.payment) {
          subText = ' · paid';
        }
        badgeTd.appendChild(badge);
        if (subText) {
          sub.textContent = subText;
          badgeTd.appendChild(sub);
        }
        const paidAt = user.paidAt || membership.paidAt || (user.payment && user.payment.paidAt) || null;
        if (paidAt) badgeTd.title = 'Paid ' + fmtDate(paidAt);
      } else {
        badgeTd.appendChild(badge);
      }

      const actionsTd = document.createElement('td');
      actionsTd.className = 'admin-actions-cell';
      const actions = document.createElement('div');
      actions.className = 'admin-actions';

      if (status === 'banned') {
        actions.appendChild(actionButton('unban', 'Unban', 'secondary'));
      } else {
        if (status === 'free' || effectiveStatus === 'revoked') {
          // Five durations via a select + one Grant button (no trial button:
          // the 7-day trial is not offered in the admin UI). The Grant button
          // carries no dataset.extra; the click handler below reads the
          // sibling select's value and passes it as `days` to runAction.
          actions.appendChild(grantDurationSelect());
          actions.appendChild(actionButton('grant', 'Grant', 'primary'));
        } else {
          actions.appendChild(actionButton('revoke', 'Revoke', 'danger'));
        }
        actions.appendChild(actionButton('ban', 'Ban', 'danger'));
      }
      actions.appendChild(actionButton('delete', 'Delete', 'ghost'));
      actionsTd.appendChild(actions);

      tr.appendChild(numberTd);
      tr.appendChild(userTd);
      tr.appendChild(idTd);
      tr.appendChild(joinedTd);
      tr.appendChild(seenTd);
      tr.appendChild(badgeTd);
      tr.appendChild(actionsTd);
      fragment.appendChild(tr);
    });
    body.appendChild(fragment);
  }

  function grantDurationSelect() {
    const select = document.createElement('select');
    select.className = 'admin-grant-select';
    select.setAttribute('aria-label', 'Grant duration');
    GRANT_DURATIONS.forEach((option) => {
      const el = document.createElement('option');
      el.value = String(option.days);
      el.textContent = option.label;
      select.appendChild(el);
    });
    return select;
  }

  function actionButton(action, label, kind, extra) {
    const button = document.createElement('button');
    button.className = 'admin-action-btn ' + kind;
    button.dataset.action = action;
    if (extra != null) button.dataset.extra = extra;
    button.textContent = label;
    return button;
  }

  function renderPagination() {
    $('adminPageInfo').textContent = 'Page ' + state.page + ' of ' + state.pages + ' · ' + state.total + ' users';
    $('adminPrev').disabled = state.page <= 1;
    $('adminNext').disabled = state.page >= state.pages;
  }

  async function runAction(userId, action, extra) {
    const labels = {
      grant: extra + ' days of premium for this user?',
      revoke: 'Revoke premium from this user? Their payment record is kept for history.',
      ban: 'Ban this user? They lose premium and access is blocked.',
      unban: 'Unban this user?',
      delete: 'Delete every record of this user? This cannot be undone.'
    };
    if (!window.confirm(labels[action] || action + '?')) return;

    try {
      let path = '/admin/users/' + encodeURIComponent(userId) + '/' + action;
      let options = { method: 'POST' };
      if (action === 'grant') {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({ days: parseInt(extra, 10) });
      }
      const response = await api(path, options);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || ('action failed: ' + response.status));
      toast(action === 'delete' ? 'User deleted.' : action + ' applied.');
      await Promise.all([loadUsers(), loadStats()]);
    } catch (error) {
      toast(error.message, false);
    }
  }

  async function viewProof(proofId) {
    try {
      const response = await api('/admin/proofs/' + encodeURIComponent(proofId));
      const proof = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(proof.error || ('failed to load proof: ' + response.status));
      const detail = (proof.name || '(no name)') + ' (' + (proof.email || '') + ') — ' +
        planLabel(proof.plan) + ' · ' + methodLabel(proof.method) + ' · UTR ' + (proof.utr || '—');
      if (!proof.screenshot) {
        toast(detail + ' — no screenshot attached.', false);
        return;
      }
      const tab = window.open(proof.screenshot, '_blank');
      if (!tab) {
        toast('Popup blocked — allow popups for this page to view the screenshot.', false);
        return;
      }
      toast(detail);
    } catch (error) {
      toast(error.message, false);
    }
  }

  async function runProofAction(proofId, action, card) {
    const email = (card && card.dataset.email) || '';
    const plan = planLabel(card && card.dataset.plan);
    if (action === 'approve') {
      if (!window.confirm('Approve this payment and grant ' + plan + ' Premium to ' + email + '?')) return;
    } else {
      if (!window.confirm('Reject this payment? The user can submit a new proof.')) return;
    }
    let reason = '';
    if (action === 'reject') {
      const answer = window.prompt('Reason for rejection (optional — shown to the user):', '');
      if (answer === null) return; // prompt cancelled — do not reject
      reason = answer.trim();
    }

    try {
      const options = { method: 'POST' };
      if (action === 'reject' && reason) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({ reason });
      }
      const response = await api('/admin/proofs/' + encodeURIComponent(proofId) + '/' + action, options);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || ('action failed: ' + response.status));
      toast(action === 'approve' ? 'Payment approved — premium granted.' : 'Payment rejected.');
      await Promise.all([loadProofs(), loadUsers(), loadStats()]);
    } catch (error) {
      toast(error.message, false);
    }
  }

  function debounceSearch() {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.query = $('adminSearch').value.trim();
      state.page = 1;
      loadUsers().catch((error) => toast(error.message, false));
    }, 300);
  }

  async function exportUsersCsv() {
    toast('Fetching all users for export…');
    try {
      let allUsers = [];
      let p = 1;
      const limit = 50;
      while (true) {
        const response = await api('/admin/users?page=' + p + '&limit=' + limit);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Failed to fetch users');
        const list = payload.users || [];
        allUsers = allUsers.concat(list);
        if (p >= (payload.pages || 1) || list.length === 0) break;
        p++;
      }

      if (!allUsers.length) {
        toast('No users found to export.', false);
        return;
      }

      const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const lines = [['Name', 'Email', 'Google ID', 'Status', 'Plan', 'Joined Date', 'Last Seen Date'].join(',')];
      for (const u of allUsers) {
        const m = u.membership || {};
        lines.push([
          esc(u.name || ''),
          esc(u.email || ''),
          esc(u.id || ''),
          esc(m.status || 'free'),
          esc(u.plan || m.plan || ''),
          esc(u.firstSeen ? new Date(u.firstSeen).toISOString() : ''),
          esc(u.lastSeen ? new Date(u.lastSeen).toISOString() : '')
        ].join(','));
      }

      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `insta-unfollow-users-${allUsers.length}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast(`Exported ${allUsers.length} users successfully!`);
    } catch (e) {
      toast('Export failed: ' + e.message, false);
    }
  }

  async function bulkGrantFreeUsers(days = 10) {
    if (!window.confirm(`Are you sure you want to grant ${days} days of free promotional premium to ALL free users?`)) {
      return;
    }

    toast(`Fetching free users…`);
    try {
      let allUsers = [];
      let p = 1;
      const limit = 50;
      while (true) {
        const response = await api('/admin/users?page=' + p + '&limit=' + limit);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Failed to fetch users');
        const list = payload.users || [];
        allUsers = allUsers.concat(list);
        if (p >= (payload.pages || 1) || list.length === 0) break;
        p++;
      }

      const freeUsers = allUsers.filter(u => {
        const s = (u.membership && u.membership.status) || 'free';
        return s === 'free' || s === 'revoked';
      });

      if (!freeUsers.length) {
        toast('No free users found to grant.');
        return;
      }

      toast(`Granting ${days} days to ${freeUsers.length} users… Please wait.`);
      let grantedCount = 0;
      for (const u of freeUsers) {
        try {
          await api('/admin/users/' + encodeURIComponent(u.id) + '/grant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days: parseInt(days, 10) })
          });
          grantedCount++;
        } catch (err) {
          console.warn('Failed to grant user:', u.email, err);
        }
      }

      toast(`🎉 Granted ${days} days to ${grantedCount} users!`);
      await Promise.all([loadUsers(), loadStats()]);
    } catch (e) {
      toast('Bulk grant failed: ' + e.message, false);
    }
  }

  async function boot() {
    const data = await chrome.storage.local.get(['auth_token', 'user_info']);
    const userInfo = data.user_info;
    const isLoggedIn = Boolean(data.auth_token && userInfo);

    $('adminAvatar').src = (userInfo && userInfo.picture) || '';
    $('adminName').textContent = (userInfo && (userInfo.name || userInfo.given_name)) || '';
    $('adminEmail').textContent = (userInfo && userInfo.email) || '';

    if (!isLoggedIn) {
      $('gateLoginBtn').addEventListener('click', async () => {
        $('gateLoginBtn').disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({ action: 'googleLogin' });
          if (response && response.success) location.reload();
          else throw new Error((response && response.error) || 'login failed');
        } catch (error) {
          toast(error.message, false);
          $('gateLoginBtn').disabled = false;
        }
      });
      showGate('gateLogin');
      return;
    }

    $('adminSignOut').style.display = 'block';
    $('adminSignOut').addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ action: 'logout' });
      } catch (error) { /* storage cleared either way */ }
      location.reload();
    });

    const email = String(userInfo.email || '').toLowerCase();
    const adminEmail = String(window.PREMIUM_ADMIN_EMAIL || '').toLowerCase();
    if (email !== adminEmail) {
      $('deniedEmail').textContent = userInfo.email || 'unknown';
      showGate('gateDenied');
      return;
    }

    if (!window.PAYMENT_API_URL || window.PAYMENT_API_URL.includes('PASTE-YOUR-WORKER')) {
      showGate('gateConfig');
      return;
    }

    $('gateRetryBtn').addEventListener('click', () => location.reload());

    try {
      await adminLogin();
    } catch (error) {
      $('gateErrorText').textContent = error.message;
      showGate('gateError');
      return;
    }

    $('adminGate').style.display = 'none';
    $('adminPanel').style.display = 'block';

    $('adminRefresh').addEventListener('click', () => {
      Promise.all([loadProofs(), loadUsers(), loadStats()]).catch((error) => toast(error.message, false));
    });
    const exportBtn = $('adminExportCsv');
    if (exportBtn) exportBtn.addEventListener('click', exportUsersCsv);
    const bulkGrantBtn = $('adminBulkGrant');
    if (bulkGrantBtn) bulkGrantBtn.addEventListener('click', () => bulkGrantFreeUsers(10));

    $('adminSearch').addEventListener('input', debounceSearch);
    $('adminPrev').addEventListener('click', () => {
      if (state.page > 1) { state.page--; loadUsers().catch((error) => toast(error.message, false)); }
    });
    $('adminNext').addEventListener('click', () => {
      if (state.page < state.pages) { state.page++; loadUsers().catch((error) => toast(error.message, false)); }
    });
    $('adminTableBody').addEventListener('click', (event) => {
      const button = event.target.closest('.admin-action-btn');
      if (!button) return;
      const row = button.closest('tr');
      if (!row || !row.dataset.userId) return;
      let extra = button.dataset.extra;
      if (button.dataset.action === 'grant' && extra == null) {
        // Grant button next to the duration select: read the chosen duration.
        const select = button.closest('.admin-actions') &&
          button.closest('.admin-actions').querySelector('.admin-grant-select');
        extra = select ? select.value : '10';
        if (extra === 'custom') {
          const input = prompt('Enter number of days to grant:', '10');
          if (!input || isNaN(parseInt(input, 10)) || parseInt(input, 10) <= 0) return;
          extra = String(parseInt(input, 10));
        }
      }
      runAction(row.dataset.userId, button.dataset.action, extra);
    });
    $('adminProofs').addEventListener('click', (event) => {
      const button = event.target.closest('.admin-action-btn');
      if (!button) return;
      const card = button.closest('.admin-proof');
      if (!card || !card.dataset.proofId) return;
      const proofId = card.dataset.proofId;
      if (button.dataset.action === 'view') viewProof(proofId);
      else runProofAction(proofId, button.dataset.action, card);
    });

    try {
      await Promise.all([loadProofs(), loadUsers(), loadStats()]);
    } catch (error) {
      toast(error.message, false);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((error) => {
      console.error('Admin console failed:', error);
      $('gateErrorText').textContent = error.message || String(error);
      showGate('gateError');
    });
  });
})();