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
    const response = await fetch(window.PAYMENT_API_URL + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ googleToken: auth_token })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.token) {
      throw new Error(payload.error || ('admin login failed: ' + response.status));
    }
    state.adminToken = payload.token;
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

  function renderUsers(users) {
    const body = $('adminTableBody');
    $('adminEmpty').style.display = users.length ? 'none' : 'block';
    body.innerHTML = '';
    if (!users.length) return;

    const fragment = document.createDocumentFragment();
    users.forEach((user, index) => {
      const membership = user.membership || {};
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
      const status = membership.status || 'free';
      badge.className = 'admin-badge ' + status;
      badge.textContent = membership.label || 'Free';
      if (status === 'grant' || status === 'premium') {
        const sub = document.createElement('span');
        sub.className = 'admin-badge-sub';
        if (status === 'grant' && user.grant) {
          const left = (user.grant.grantedAt + user.grant.days * 86400000) - Date.now();
          sub.textContent = ' · ' + Math.max(0, Math.round(left / 86400000)) + 'd left';
        } else if (user.payment) {
          sub.textContent = ' · paid';
        }
        badgeTd.appendChild(badge);
        badgeTd.appendChild(sub);
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
        if (status === 'free') {
          actions.appendChild(actionButton('grant', 'Grant 30d', 'primary', '30'));
          actions.appendChild(actionButton('grant', 'Grant 365d', 'primary', '365'));
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
      revoke: 'Revoke premium from this user? Their paid status is removed too.',
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

  function debounceSearch() {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.query = $('adminSearch').value.trim();
      state.page = 1;
      loadUsers().catch((error) => toast(error.message, false));
    }, 300);
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
      Promise.all([loadUsers(), loadStats()]).catch((error) => toast(error.message, false));
    });
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
      runAction(row.dataset.userId, button.dataset.action, button.dataset.extra);
    });

    try {
      await Promise.all([loadUsers(), loadStats()]);
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