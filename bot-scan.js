/**
 * Bot follower scan.
 *
 * Two passes, because they cost very different amounts. The cheap pass scores every follower from
 * fields the follow list already carries — no extra requests at all. The deep pass fetches a
 * profile per account, which is one request each, so it is a separate button rather than part of
 * the scan, and it runs only on the accounts the cheap pass already flagged.
 *
 * The score is an ordering aid, not a verdict. Every row shows the reasons behind its number, and
 * nothing on this page removes anybody.
 */
(function () {
  'use strict';

  const PAGE_SIZE = 50;

  /** Reason chips shown inline; anything past this opens in the modal. */
  const MAX_CHIPS = 2;

  /**
   * Rows a free account sees in the table.
   *
   * Matches the +20 a day the analyzer's free plan already grants, so this reads as part of the
   * same allowance rather than a second, unrelated rule.
   *
   * The cap is on the table only. The scan itself covers every follower and the counters above keep
   * reporting the real totals — capping those would misreport what was actually found, and the
   * whole point of the page is that its numbers can be trusted.
   */
  const FREE_ROW_LIMIT = 20;

  let isPremium = false;

  /** One profile request per account, paced so a long deep pass doesn't look like a burst. */
  const DEEP_MIN_DELAY_MS = 700;
  const DEEP_MAX_DELAY_MS = 1400;

  let scored = [];
  let statsById = {};
  let currentPage = 1;
  /** 'bot' | 'suspicious' | 'all' — starts on the likely bots. */
  let filter = 'bot';

  /**
   * Whether the group on screen was chosen by the user or picked for them.
   *
   * Once they click a tab it stays put, even if it is empty — an empty group they asked for is an
   * answer. Before that, the page is free to open on one that has something in it.
   */
  let filterChosenByUser = false;
  let running = false;
  let stopRequested = false;
  let followersComplete = true;

  /**
   * The follower list behind the current table, and whose it is.
   *
   * Kept because the deep pass is now a separate button: it has to re-score the same accounts, and
   * write the result back to the same cache entry, without a second follower read.
   */
  let allUsers = [];
  let viewerId = null;

  /**
   * Accounts Instagram answered for with nothing at all — deleted or deactivated.
   *
   * Held apart from statsById because there are no counts to record, only the fact that we asked.
   * Without it these accounts never leave the deep-check queue and every run pays for them again.
   */
  let unresolvedIds = new Set();

  /**
   * What the run that just finished needs to say, if anything.
   *
   * Instagram cutting a run short used to be reported in the small grey line beside the buttons,
   * at the same weight as "Scan complete." — so the one state the user has to act on looked like
   * routine chatter. Held here so it can be shown as a banner and outrank the standing notices,
   * and cleared the moment a new run starts.
   *
   * @type {{title: string, body: string}|null}
   */
  let runNotice = null;

  const $ = (id) => document.getElementById(id);
  const msg = (key, subs) => {
    try { return chrome.i18n.getMessage(key, subs) || ''; } catch (e) { return ''; }
  };
  /**
   * Reason labels come from the signal table in English so the scorer stays readable on its own.
   * The table shows them, so they have to be translated — resolved by signal id, falling back to
   * the English label when a locale has not got the key.
   */
  const reasonLabel = (r) => msg("botReason_" + r.id) || r.label;
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- i18n
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const text = msg(el.dataset.i18n);
      if (text) el.textContent = text;
    });
  }

  /** Same membership shape the rest of the extension reads, so one plan means one thing. */
  async function loadMembership() {
    try {
      isPremium = (await getPremiumMembership()).turu === 'premium';
    } catch (error) {
      // A storage failure must not silently downgrade a paying customer to the free table.
      console.warn('[bot-scan] uyelik okunamadi, premium varsayiliyor', error);
      isPremium = true;
    }
  }

  // ---------------------------------------------------------------- cache
  /**
   * A scan costs a full follower read plus a request per deep-checked account, so the result is
   * kept and shown again on the next visit instead of spending all of that to redraw the same table.
   *
   * Only a complete read is stored. A truncated one would come back looking like the whole picture —
   * "Scanned: 400" for someone with five thousand followers — and there is nothing on screen to say
   * otherwise. One re-scan is cheaper than a number the user has no reason to doubt.
   *
   * The button always runs a genuinely fresh scan; the cache is only what the page opens with. That
   * keeps "Start Bot Scan" meaning what it says rather than quietly replaying stored profile stats.
   */
  const cacheKey = (userId) => `botScanCache_${userId}`;

  /** Past this the profile-picture links have usually expired, same as the analyzer's warning. */
  const CACHE_STALE_DAYS = 4;

  async function getBotScanCache(userId) {
    try {
      const data = await chrome.storage.local.get([cacheKey(userId)]);
      const cache = data[cacheKey(userId)] || null;
      if (!cache || cache.complete !== true || !Array.isArray(cache.users) || !cache.users.length) {
        return null;
      }
      return cache;
    } catch (error) {
      return null;                    // an unreadable cache is just a missing one
    }
  }

  async function saveBotScanCache(userId, users, stats) {
    // Only the fields the detector and the table actually read. Note that
    // has_anonymous_profile_picture and account_badges are copied as-is and NOT coerced: when the
    // reserve endpoint supplied the list they are absent, and absent has to stay absent. Turning a
    // missing photo signal into `false` would store every bot in the list as clean.
    const slim = users.map((edge) => {
      const n = edge.node || edge;
      const node = {
        id: String(n.id || ''),
        username: n.username,
        full_name: n.full_name,
        is_verified: n.is_verified,
        profile_pic_url: n.profile_pic_url
      };
      if (n.has_anonymous_profile_picture !== undefined) {
        node.has_anonymous_profile_picture = n.has_anonymous_profile_picture;
      }
      if (n.account_badges !== undefined) node.account_badges = n.account_badges;
      return { node };
    });

    try {
      await chrome.storage.local.set({
        [cacheKey(userId)]: { users: slim, stats: stats || {}, unresolved: [...unresolvedIds], complete: true, timestamp: Date.now() }
      });
    } catch (error) {
      console.warn('[bot-scan] cache yazilamadi', error);   // not worth failing the scan over
    }
  }

  /** "Last scan 14:32", plus the picture warning once the links are old enough to have expired. */
  function showCacheAge(timestamp) {
    const when = new Date(timestamp);
    const timeStr = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const days = Math.floor((Date.now() - timestamp) / 86400000);

    let text = msg('botScanCached', [timeStr]) || `Last scan ${timeStr}`;
    if (days >= CACHE_STALE_DAYS) {
      text += '  ·  ' + (msg('cacheExpiryWarning', [String(days)]) || '');
    }
    setStatus(text.trim());
  }

  // ---------------------------------------------------------------- deep pass
  /**
   * Fetch follower/following/post counts for the accounts worth a closer look.
   *
   * Stops the moment Instagram starts refusing rather than working through the rest: a refusal
   * arrives as 200 carrying HTML, and pushing past it only lengthens the pause.
   *
   * @returns {Promise<{checked:number, blocked:boolean}>}
   */
  async function fetchProfileStats(targets, onProgress) {
    let checked = 0;

    for (const entry of targets) {
      if (stopRequested) break;
      const username = entry.user && entry.user.username;
      if (!username) continue;

      let response;
      try {
        response = await fetch(
          `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
          {
            method: 'GET',
            credentials: 'include',
            headers: {
              accept: '*/*',
              'x-ig-app-id': '936619743392459',
              'x-requested-with': 'XMLHttpRequest'
            }
          }
        );
      } catch (error) {
        break;                       // network gone; keep what we have
      }

      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch (error) { body = null; }

      // 200 with a non-JSON body is Instagram declining behind a friendly status code.
      if (!body) return { checked, blocked: true };

      const profile = body?.data?.user;
      if (profile) {
        statsById[entry.id] = {
          followerCount: profile.edge_followed_by?.count ?? 0,
          followingCount: profile.edge_follow?.count ?? 0,
          postCount: profile.edge_owner_to_timeline_media?.count ?? 0
        };
      } else {
        // A 200 with no user is a deleted or deactivated account. Nothing can ever be learned about
        // it, so the attempt itself has to be recorded — otherwise it stays "not yet checked"
        // forever and every later run spends another request arriving at the same nothing. That is
        // the whole reason a handful of accounts would sit on the button and never clear.
        unresolvedIds.add(entry.id);
      }

      checked++;
      if (onProgress) onProgress(checked, targets.length);
      await sleep(rnd(DEEP_MIN_DELAY_MS, DEEP_MAX_DELAY_MS));
    }

    return { checked, blocked: false };
  }

  // ---------------------------------------------------------------- scan
  async function runScan() {
    if (running) return;
    running = true;
    stopRequested = false;
    runNotice = null;
    // Profile counts are deliberately NOT cleared here.
    //
    // They belong to the accounts, not to the follower list: re-reading the list does not make a
    // follower count from ten minutes ago wrong. Clearing them meant every re-scan silently threw
    // away a deep pass that had cost one request per account — a hundred and fifty requests of work
    // gone with nothing on screen to say so. The scan re-reads the list; the button below states
    // plainly how many accounts already carry profile data and how many are still outstanding.
    scored = [];
    currentPage = 1;

    $('startBotScan').disabled = true;
    $('stopBotScan').disabled = false;
    setStatus(msg('botScanReading') || 'Reading your followers…');
    showMessage(msg('botScanReading') || 'Reading your followers…');
    showPanel(true);
    setStage('read');

    try {
      const viewer = await window.UnfollowBridge.getViewer();
      if (!viewer) {
        showMessage(msg('pleaseLoginToInstagram') || 'Please log in to Instagram first.');
        return;
      }
      viewerId = viewer.id;
      $('userName').textContent = viewer.username || '';

      const expected = (await window.UnfollowBridge.getExpectedCounts(viewer.id) || {}).followers;

      // Same reader the rest of the extension uses: an Instagram tab if one is open, otherwise
      // straight from here.
      const report = (p) => {
        setStatus(
          (msg('botScanReadingCount', [String(p.count)]) || `Reading followers… ${p.count}`) +
          (expected ? ` / ${expected.toLocaleString()}` : '')
        );
        // The sub-line carries what the title cannot: a backoff is a minute or two of nothing
        // happening, and a panel that says nothing during it looks frozen.
        drawPanel({
          count: p.count,
          total: expected,
          detail: p.rateLimitedForMs
            ? (msg('scanPaused') || 'Instagram asked us to slow down — waiting…')
            : (msg('botReadSubtitle') || '')
        });
      };

      let result = null;
      const page = window.UnfollowPageBridge;
      if (page && await page.isPageAvailable()) {
        const attempt = await page.runScanInPage({
          userId: viewer.id, listType: 'followers', mode: 'graphql_first', onProgress: report
        });
        if (attempt.delivered && attempt.result) result = attempt.result;
      }
      if (!result) {
        result = await window.UnfollowBridge.scanPeers({
          userId: viewer.id, type: 'followers', expected,
          csrfToken: viewer.csrfToken, onProgress: report,
          shouldStop: () => stopRequested,
          // Graphql leads here and v1 waits in reserve, the reverse of the analyzer's read.
          // The followers list is the long one, and it is the one v1 refuses on large accounts —
          // measured refusing from the first request on a 17,000-follower account while graphql
          // served the same list in the same session. Leading with the endpoint that answers
          // avoids spending the whole v1 attempt only to restart from page one.
          preferGraphql: true
        });
      }

      followersComplete = !!result.complete;
      if (!result.users.length) {
        showMessage(msg('botScanNoData') || 'Could not read your follower list. Instagram is holding us off — try again later.');
        return;
      }

      // The scan is the cheap pass only. Every account is scored from fields the follow list
      // already carried, so this costs no requests beyond reading the list itself. The deep pass
      // spends one request per account and is now the user's decision, on its own button.
      allUsers = result.users;
      // Drop stats for accounts that are no longer followers, so the store does not grow forever
      // with people who left.
      const present = new Set(allUsers.map((e) => String((e.node || e).id)));
      Object.keys(statsById).forEach((id) => { if (!present.has(id)) delete statsById[id]; });

      scored = window.BotDetector.scoreAll(allUsers, statsById);
      render();

      if (followersComplete && !stopRequested) {
        await saveBotScanCache(viewer.id, allUsers, statsById);
      }

      setStatus(followersComplete
        ? (msg('botScanDone') || 'Scan complete.')
        : (msg('botScanPartial') || 'Scan finished, but the follower list came back incomplete.'));

    } catch (error) {
      console.error('[bot-scan]', error);
      showMessage(error.message || msg('errorOccurred') || 'Something went wrong.');
    } finally {
      running = false;
      showPanel(false);
      $('startBotScan').disabled = false;
      $('stopBotScan').disabled = true;
      // After `running` clears, not before: render() runs while the scan is still marked active, so
      // the button it drew was still disabled. Without this the deep pass could never be started.
      updateDeepButton();
    }
  }

  /**
   * The deep pass, on demand.
   *
   * Separated from the scan because the two cost completely different things. Reading the follower
   * list is one stream of requests whatever its length; this spends one request per account against
   * an endpoint that starts refusing when pushed. Running it automatically meant every scan quietly
   * spent that budget whether or not the user wanted the extra detail.
   *
   * It works on whatever is on screen, including a table restored from cache, so a scan does not
   * have to be repeated to get it.
   */
  async function runDeepScan() {
    if (running || !scored.length) return;

    const targets = deepTargets();
    if (!targets.length) {
      setStatus(msg('botDeepNoTargets') || 'No accounts need a deep check.');
      return;
    }

    running = true;
    stopRequested = false;
    runNotice = null;
    $('startBotScan').disabled = true;
    $('runDeepChecks').disabled = true;
    $('stopBotScan').disabled = false;
    showPanel(true);
    setStage('deep');

    try {
      const deep = await fetchProfileStats(targets, (done, total) => {
        setStatus(msg('botScanDeepProgress', [String(done), String(total)])
          || `Checking profiles… ${done}/${total}`);
        drawPanel({ count: done, total, detail: msg('botDeepSubtitle') || '' });
      });

      scored = window.BotDetector.scoreAll(allUsers, statsById);

      // Anything left unchecked is stated. The pass covers the whole flagged list, so a remainder
      // only appears when it was cut short — by Stop, or by Instagram declining part way through.
      const left = deepTargets().length;

      // Instagram cutting the run short is the one outcome the user has to act on, so it goes in
      // the banner rather than the status line, and it says what the results below are worth.
      if (deep.blocked) {
        runNotice = {
          title: msg('botDeepPausedTitle') || 'Instagram paused the profile checks',
          body: (msg('botDeepPausedBody', [String(deep.checked), String(left)])
            || `${deep.checked} accounts were checked before it stopped and ${left} were not. The `
             + 'verdicts below are based only on what was read. There is no set wait — it can be '
             + 'hours, or into tomorrow. Come back later rather than retrying now.')
        };
      }

      render();

      // Stats gathered here belong with the list they describe, so the next visit opens with them.
      if (followersComplete && viewerId) await saveBotScanCache(viewerId, allUsers, statsById);
      const done = msg('botDeepDone', [String(deep.checked)])
        || `Deep checks finished — ${deep.checked} accounts checked.`;
      const remainder = left
        ? '  ' + (msg('botDeepRemaining', [String(left)]) || `${left} were not checked.`)
        : '';

      setStatus((deep.blocked
        ? (msg('botScanDeepPaused') || 'Instagram paused the profile checks — results below are from what was read.')
        : done) + remainder);
    } catch (error) {
      console.error('[bot-scan] deep', error);
      showToastLikeStatus(error);
    } finally {
      running = false;
      showPanel(false);
      $('startBotScan').disabled = false;
      $('stopBotScan').disabled = true;
      updateDeepButton();
    }
  }

  function showToastLikeStatus(error) {
    setStatus(error && error.message ? error.message : (msg('errorOccurred') || 'Something went wrong.'));
  }

  /**
   * Every account still worth a profile request: everything flagged that has not been checked.
   *
   * Deliberately NOT capped by plan, though it was at first.
   *
   * Profile counts do not decorate a row, they change its score: no posts, a lopsided audience and
   * no followers together add fifty-five, which is enough to carry an account from suspicious into
   * likely-bot. Checking only the first twenty on a free plan therefore did not just show less — it
   * produced a different answer, and the counters above the table, which free accounts see in full,
   * reported "0 likely bots" where a full pass found thirty.
   *
   * The plan limits how many rows are displayed. What the page measures, and every number it states
   * about the scan, is the same for everyone.
   */
  function deepTargets() {
    if (!scored.length) return [];
    return window.BotDetector.pickDeepScanTargets(scored, Infinity)
      .filter((e) => !unresolvedIds.has(e.id));
  }

  /**
   * How the flagged list splits between already-checked and outstanding.
   *
   * The button used to show only the outstanding count. After a deep pass that number is small —
   * five, say — while the Flagged card still reads a hundred and fifty, and there is nothing on
   * screen to reconcile the two. It reads as the button being stuck rather than as most of the work
   * already being done.
   */
  function deepScope() {
    const V = window.BotDetector.VERDICT;
    const flagged = scored.filter((e) => e.verdict !== V.CLEAN);
    const checked = flagged.filter((e) => e.deep || unresolvedIds.has(e.id)).length;
    return { flagged: flagged.length, checked, pending: deepTargets().length };
  }

  /**
   * Offers the deep pass over everything that was flagged.
   *
   * There used to be a number beside this button. It read as a finding when it was only the value
   * in the box next to it, and it meant a pass could finish, report success, and leave most of the
   * flagged accounts untouched with nothing on screen to say so. One button covering the whole
   * flagged list removes both problems: what it does is what it says.
   */
  function updateDeepButton() {
    const group = $('deepGroup');
    const button = $('runDeepChecks');
    if (!group || !button) return;

    const { pending, checked } = deepScope();
    group.style.display = scored.length ? 'flex' : 'none';
    button.disabled = running || pending === 0;

    $('deepBtnText').textContent =
      pending === 0 ? (msg('botDeepAllChecked') || 'All flagged accounts checked')
      : checked > 0
        // Says why the number is small: the rest were checked on an earlier run and kept.
        ? (msg('botDeepChecksRemaining', [String(pending), String(checked)])
            || `Deep-check ${pending} left (${checked} already done)`)
        : (msg('botDeepChecksFor', [String(pending)]) || `Deep-check ${pending} accounts`);
  }

  // ---------------------------------------------------------------- scan panel
  /** Circumference of the ring: 2 * pi * 52, matching the r in bot-scan.html. */
  const RING = 326.7;
  let stageStartedAt = 0;

  function showPanel(show) {
    const el = $('botLoading');
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  /**
   * Mark which of the two stages is running.
   *
   * They are very different jobs — reading the list costs nothing extra, checking profiles costs a
   * request each — and the counter restarts between them. Without this the number appears to reset
   * to zero half way through and the whole thing looks like it started over.
   */
  function setStage(stage) {
    stageStartedAt = Date.now();
    const read = $('botStepRead');
    const deep = $('botStepDeep');
    if (read) {
      read.classList.toggle('active', stage === 'read');
      read.classList.toggle('done', stage === 'deep');
    }
    if (deep) deep.classList.toggle('active', stage === 'deep');

    $('botStageTitle').textContent = stage === 'deep'
      ? (msg('botStepDeep') || 'Checking profiles')
      : (msg('botStepReading') || 'Reading followers');
    $('botBigCount').textContent = '0';
    $('botProgress').style.display = 'none';
    $('botRingText').textContent = '';
    document.querySelector('.scan-ring').classList.add('indeterminate');
  }

  /** @param {{count:number, total?:number, detail?:string}} p */
  function drawPanel(p) {
    const { count = 0, total, detail } = p || {};
    const ring = document.querySelector('.scan-ring');
    $('botStageDetail').textContent = detail || '';

    if (!total) {
      // No total to measure against, so the ring sweeps rather than inventing a percentage.
      ring.classList.add('indeterminate');
      $('botBigCount').textContent = count.toLocaleString();
      return;
    }

    ring.classList.remove('indeterminate');
    // The expected total is Instagram's own figure and the read can overshoot it slightly, so this
    // is clamped — but to 100, not 99: "160 / 160, 0 left" beside "%99" reads as a stuck bar.
    const percent = Math.min(100, Math.round((count / total) * 100));
    $('botRingArc').style.strokeDashoffset = String(RING * (1 - percent / 100));
    $('botRingText').textContent = '%' + percent;
    $('botBigCount').textContent = `${count.toLocaleString()} / ${total.toLocaleString()}`;
    $('botProgress').style.display = 'block';
    $('botBar').style.width = percent + '%';

    const remaining = Math.max(0, total - count);
    $('botRemaining').textContent = msg('scanRemaining', [remaining.toLocaleString()])
      || `${remaining.toLocaleString()} left`;

    // From the rate actually achieved, and only once there is enough of it to mean anything.
    const elapsed = Date.now() - stageStartedAt;
    if (count >= 20 && elapsed > 4000) {
      const left = Math.round((elapsed / count) * remaining / 1000);
      if (left >= 5) {
        // Was written in Turkish directly here, which every other locale then read as well.
        $('botEta').textContent = left > 90
          ? (msg('etaMinutes', [String(Math.ceil(left / 60))]) || `~${Math.ceil(left / 60)} min left`)
          : (msg('etaSeconds', [String(left)]) || `~${left} sec left`);
      }
    }
  }

  // ---------------------------------------------------------------- rendering
  function setStatus(text) {
    const el = $('botScanStatus');
    if (el) el.textContent = text;
  }

  function showMessage(text) {
    $('botList').innerHTML = `<tr><td colspan="7" class="no-data-message">${text}</td></tr>`;
    $('botPagination').style.display = 'none';
  }

  /**
   * The rows the current filter asks for.
   *
   * Opens on the likely bots because that is what the page is for: in a list of several thousand
   * followers the ordinary accounts are the overwhelming majority, and showing them first means
   * scrolling past hundreds of "Looks real" to reach the ones worth a decision.
   */
  function visibleRows() {
    const V = window.BotDetector.VERDICT;
    if (filter === 'bot') return scored.filter((e) => e.verdict === V.BOT);
    if (filter === 'suspicious') return scored.filter((e) => e.verdict === V.SUSPICIOUS);
    return scored;
  }

  /**
   * Open on a group that has something in it.
   *
   * The table defaults to "Likely bots" because that is what the page is for, but a scan can
   * legitimately find none — plenty of accounts land in the suspicious band without ever reaching
   * the bot threshold. Opening on the empty tab shows a blank table after reading several hundred
   * followers, which reads as a failed scan rather than as a clean result. Only ever moves before
   * the user has picked a tab themselves.
   */
  function pickNonEmptyFilter() {
    if (filterChosenByUser) return;
    const V = window.BotDetector.VERDICT;
    const counts = {
      bot: scored.filter((e) => e.verdict === V.BOT).length,
      suspicious: scored.filter((e) => e.verdict === V.SUSPICIOUS).length,
      all: scored.length
    };
    if (counts[filter]) return;                       // current group already has rows

    const next = ['bot', 'suspicious', 'all'].find((f) => counts[f]);
    if (!next || next === filter) return;
    filter = next;
    currentPage = 1;
    document.querySelectorAll('.bot-filter-btn')
      .forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
  }

  /**
   * Warn when the scan could not measure its heaviest signal.
   *
   * "No profile photo" is worth 40 — the only signal large enough on its own to carry an account to
   * the bot threshold of 55. It arrives only from the primary follower endpoint; when the reserve
   * one supplied the list, the field is simply absent and every score in the table is 40 low.
   *
   * The counters then read "0 likely bots" in exactly the same confident type as a real finding.
   * Without this line that is a lie by omission: nothing on the page distinguishes "we looked and
   * there are none" from "we could not perform the check that finds them".
   */
  function renderSignalNotice() {
    const el = $('botSignalNotice');
    if (!el) return;
    if (!scored.length) { el.style.display = 'none'; return; }

    // What just happened outranks what is generally true: if Instagram stopped us mid-run, that is
    // the thing the user needs to know, not that some verdicts are still provisional.
    const notice = runNotice || blindSignalNotice() || provisionalNotice();
    if (!notice) { el.style.display = 'none'; return; }

    el.style.display = 'flex';
    el.innerHTML = `<span class="bot-signal-notice-icon">!</span>
      <div><strong>${notice.title}</strong><span>${notice.body}</span></div>`;
  }

  /** The whole read came back without the photo field, so every score is 40 low. */
  function blindSignalNotice() {
    const blind = scored.filter((e) => (e.unavailable || []).includes('anonymous_picture')).length;
    // A handful of odd records is normal; a majority means the reserve endpoint supplied the list.
    if (blind < scored.length * 0.5) return null;
    return {
      title: msg('botBlindTitle') || 'The profile-photo check could not be run',
      body: msg('botBlindBody')
        || 'Instagram returned the follower list without profile-photo data, so every score here is '
         + 'lower than it should be and some bots will be missed. Open Instagram in a tab and run '
         + 'the scan again for a complete result.'
    };
  }

  /**
   * Flagged accounts exist that nobody has deep-checked yet.
   *
   * The scan on its own reads only what the follower list carries, and that is rarely enough to
   * reach the bot threshold: it is the fetched post and follower counts that push an account over.
   * So a fresh scan very often reports "0 likely bots" — which is not a finding, it is the state
   * before the check that finds them has been run. The counters look just as settled either way,
   * and the only honest fix is to say which one the user is looking at.
   */
  function provisionalNotice() {
    const { pending } = deepScope();
    if (!pending) return null;
    return {
      title: msg('botProvisionalTitle') || 'These verdicts are not final yet',
      body: msg('botProvisionalBody', [String(pending)])
        || `${pending} flagged accounts have not been profile-checked. Most bots are only confirmed `
         + 'by that check, so run it before trusting the "likely bots" count.'
    };
  }

  function renderFilterCounts() {
    const V = window.BotDetector.VERDICT;
    $('botFilterCountBot').textContent = scored.filter((e) => e.verdict === V.BOT).length.toLocaleString();
    $('botFilterCountSuspicious').textContent =
      scored.filter((e) => e.verdict === V.SUSPICIOUS).length.toLocaleString();
    $('botFilterCountAll').textContent = scored.length.toLocaleString();
  }

  function verdictChip(verdict) {
    const V = window.BotDetector.VERDICT;
    if (verdict === V.BOT) {
      return `<span class="bot-chip bot-chip-high">${msg('botVerdictLikely') || 'Likely bot'}</span>`;
    }
    if (verdict === V.SUSPICIOUS) {
      return `<span class="bot-chip bot-chip-mid">${msg('botVerdictSuspicious') || 'Suspicious'}</span>`;
    }
    return `<span class="bot-chip bot-chip-low">${msg('botVerdictClean') || 'Looks real'}</span>`;
  }

  function render() {
    pickNonEmptyFilter();
    const rows = visibleRows();
    const V = window.BotDetector.VERDICT;

    const bots = scored.filter((e) => e.verdict === V.BOT).length;
    const suspicious = scored.filter((e) => e.verdict === V.SUSPICIOUS).length;

    $('botScanned').textContent = scored.length.toLocaleString();
    $('botLikely').textContent = bots.toLocaleString();
    $('botSuspicious').textContent = suspicious.toLocaleString();
    // The two above added up: the same set the deep-check button works from, so the number on that
    // button has something on screen to agree with.
    $('botFlagged').textContent = (bots + suspicious).toLocaleString();
    renderFilterCounts();
    renderSignalNotice();
    updateDeepButton();

    if (!rows.length) {
      // An empty likely-bots table is good news, not an error, and it says so — but only when the
      // scan really found nothing anywhere. An empty group with hits elsewhere is just a filter.
      const flagged = scored.some((e) => e.verdict !== V.CLEAN);
      showMessage(!flagged
        ? (msg('botNoFlagged') || 'Nothing flagged — your follower list looks clean.')
        : (msg('botNoRowsForFilter') || 'Nothing in this group.'));
      return;
    }

    // The free plan caps the table, not the scan. `rows` above is the true set and the counters
    // are drawn from it; only what reaches the page is trimmed, and the notice below says so.
    const capped = isPremium ? rows : rows.slice(0, FREE_ROW_LIMIT);
    const withheld = rows.length - capped.length;

    const totalPages = Math.max(1, Math.ceil(capped.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;

    $('botList').innerHTML = capped.slice(start, start + PAGE_SIZE).map((entry, i) => {
      const u = entry.user;
      const level = entry.verdict === V.BOT ? 'high' : entry.verdict === V.SUSPICIOUS ? 'mid' : 'low';
      // Positive reasons only in the chip row: a negative weight is what cleared an account, and
      // showing "Verified account" beside a low score reads as an accusation of being verified.
      const positive = entry.reasons.filter((r) => r.weight > 0);
      const cleared = entry.reasons.filter((r) => r.weight < 0).map(reasonLabel).join(', ');

      // Two chips is what the column fits. Beyond that the row grows taller than the avatar and the
      // table turns into a wall of text, so the rest goes behind a button.
      const shown = positive.slice(0, MAX_CHIPS);
      const hidden = positive.length - shown.length;
      const chips = shown.map((r) => `<i>${escapeHtml(reasonLabel(r))}</i>`).join('') +
        (hidden > 0
          ? `<button type="button" class="bot-more" data-index="${start + i}">+${hidden}</button>`
          : '');

      return `
        <tr>
          <td class="row-number">${start + i + 1}</td>
          <td><div class="profile-cell">
            <img src="${avatarUrl(u.profile_pic_url)}" data-orig="${avatarUrl(u.profile_pic_url)}" referrerpolicy="no-referrer" alt="" class="profile-image" onerror="this.onerror=null;this.src='img/48.png'"></div></td>
          <td>
            <a href="https://instagram.com/${encodeURIComponent(u.username)}" target="_blank" rel="noopener"
               class="username-cell">@${escapeHtml(u.username)}</a>
            ${u.full_name ? `<div class="bot-fullname">${escapeHtml(u.full_name)}</div>` : ''}
          </td>
          <td><span class="bot-score bot-score-${level}"
                    title="${msg('botScoreRaw') || 'Raw score'}: ${entry.score}">${asPercent(entry.score)}</span></td>
          <td>${verdictChip(entry.verdict)}${entry.deep ? `<span class="bot-deep" title="${msg('botDeepChecked') || 'Profile checked'}">•</span>` : ''}</td>
          <td>${statsCell(statsById[entry.id], unresolvedIds.has(entry.id))}</td>
          <td>
            <div class="bot-reasons">${chips || `<i class="bot-reason-none">${msg('botNoSignals') || 'Nothing unusual'}</i>`}</div>
            ${cleared ? `<div class="bot-cleared">${msg('botCleared') || 'In its favour'}: ${escapeHtml(cleared)}</div>` : ''}
          </td>
        </tr>`;
    }).join('');

    // Extension pages block inline handlers, so everything interactive is bound here.
    const list = $('botList');
    list.querySelectorAll('.profile-image').forEach((img) => {
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    });
    if (window.loadAvatar) {
      list.querySelectorAll('img.profile-image').forEach((img) => {
        loadAvatar(img, img.dataset.orig || img.src);
      });
    }
    list.querySelectorAll('.bot-more').forEach((b) => {
      b.addEventListener('click', () => openReasonModal(capped[parseInt(b.dataset.index, 10)]));
    });

    renderFreeNotice(capped.length, withheld);
    renderPagination(capped.length, totalPages);
  }

  /**
   * Says how many rows are being held back, and how many were found in total.
   *
   * Stated as a count rather than left to be noticed: a table that simply stops at twenty while the
   * counter above says a hundred and fifty-five is the kind of gap a user reads as a bug.
   */
  function renderFreeNotice(shown, withheld) {
    const el = $('botFreeNotice');
    if (!el) return;

    if (!withheld) { el.style.display = 'none'; return; }
    el.style.display = 'flex';

    // The withheld count leads, at the size of the numbers in the cards above. A line of small grey
    // text under a table is read as a footnote; this is the moment the page has something to say.
    el.innerHTML = `
      <div class="bot-free-lock">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4" y="10" width="16" height="10" rx="2.5"></rect>
          <path d="M8 10V7a4 4 0 0 1 8 0v3"></path>
        </svg>
      </div>
      <div class="bot-free-text">
        <div class="bot-free-headline">
          <span class="bot-free-count">${withheld.toLocaleString()}</span>
          <span>${msg('botFreeHeadline') || 'more flagged accounts are locked'}</span>
        </div>
        <span class="bot-free-sub">${msg('showingFirstAccounts', [String(shown)])
          || `Showing first ${shown} accounts.`}</span>
      </div>
      <button type="button" id="botUpgrade" class="btn btn-primary bot-free-cta">
        <span class="button-text">${msg('upgradeToPremium') || 'Upgrade to Premium'}</span>
      </button>`;

    $('botUpgrade').addEventListener('click', openUpgrade);
  }

  /**
   * Opens the same premium modal the analyzer uses rather than throwing the user into a new tab.
   *
   * The pricing and the plan choice live in that modal; sending someone straight to a payment URL
   * skips the part where they see what they are buying.
   */
  function openUpgrade() {
    // premium.js owns the modal for both pages, so the prices and plans shown here are the same
    // ones the analyzer shows, from one implementation.
    if (typeof openPremiumModal === 'function') { openPremiumModal(); return; }
    chrome.tabs.create({ url: chrome.runtime.getURL('analyzer.html') });
  }

  /** Close paths for the shared modal: the ✕, the backdrop and Escape. */
  function wirePremiumModal() {
    const modal = $('premiumModal');
    if (!modal) return;

    modal.querySelector('.premium-modal-close')?.addEventListener('click', closePremiumModal);
    modal.querySelector('.premium-modal-overlay')?.addEventListener('click', closePremiumModal);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) closePremiumModal();
    });
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('premium-card-subscribe-button')) {
        handlePremiumSubscribe(e.target.getAttribute('data-plan') || 'monthly');
      }
    });
  }

  function avatarUrl(url) {
    return url ? url : '';
  }

  /**
   * The score is a sum of weights, not a probability — heavy cases run past 100. Displaying it as a
   * percentage is what was asked for, so it is capped at 99: claiming "%145 bot" would be nonsense,
   * and claiming "%100" would say the module is certain, which it never is. The raw number stays in
   * the tooltip and the sort order still uses it, so nothing is lost.
   */
  function asPercent(score) {
    return '%' + Math.max(0, Math.min(99, Math.round(score)));
  }

  /** 4200 -> 4.2K. Full lists run to millions and the column has to stay one line wide. */
  function compact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  /**
   * The counts the deep check went and fetched.
   *
   * They are the evidence behind the deep half of the score — "follows 4.2K, followed by 3, no
   * posts" is the finding itself, and a number the user can weigh beats a label they have to trust.
   * A row with no counts has simply not been deep-checked, and says so rather than showing zeros,
   * which would read as a real and very damning result.
   */
  function statsCell(stats, unresolved) {
    // Distinct from "not checked": we did ask, and Instagram had no account to answer with. Saying
    // "not checked" here would suggest work still to do on something that can never be read.
    if (!stats && unresolved) {
      return `<span class="bot-stats-gone" title="${msg('botStatsGoneHint') || ''}">${
        msg('botStatsGone') || 'Account gone'}</span>`;
    }
    if (!stats) {
      return `<span class="bot-stats-missing">${msg('botStatsNotChecked') || 'Not checked'}</span>`;
    }
    const cell = (value, label) =>
      `<div class="bot-stat"><span class="bot-stat-value${value === 0 ? ' is-zero' : ''}">` +
      `${compact(value)}</span><span class="bot-stat-label">${label}</span></div>`;

    return '<div class="bot-stats">'
      + cell(stats.followerCount ?? 0, msg('botStatFollowers') || 'Followers')
      + cell(stats.followingCount ?? 0, msg('botStatFollowing') || 'Following')
      + cell(stats.postCount ?? 0, msg('botStatPosts') || 'Posts')
      + '</div>';
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ---------------------------------------------------------------- reason modal
  /** Every reason for one account, with the weight that produced the score. */
  function openReasonModal(entry) {
    if (!entry) return;
    const u = entry.user;

    const line = (r) => `
      <li class="bot-reason-row ${r.weight > 0 ? 'against' : 'for'}">
        <span class="bot-reason-label">${escapeHtml(reasonLabel(r))}</span>
        <span class="bot-reason-weight">${r.weight > 0 ? '+' : ''}${r.weight}</span>
      </li>`;

    const against = entry.reasons.filter((r) => r.weight > 0);
    const forThem = entry.reasons.filter((r) => r.weight < 0);

    // Signals the reserve endpoint could not supply are named rather than passed over — an account
    // scored on half the evidence should not look the same as one scored on all of it.
    const missing = (entry.unavailable || []).length
      ? `<p class="bot-modal-missing">${msg('botSignalsUnavailable')
          || 'Some checks could not be run for this account.'}</p>`
      : '';

    $('botModalTitle').textContent = '@' + (u.username || '');
    $('botModalScore').textContent = asPercent(entry.score);
    $('botModalBody').innerHTML = `
      <ul class="bot-reason-list">${against.map(line).join('')}</ul>
      ${forThem.length ? `<h4 class="bot-modal-sub">${msg('botCleared') || 'In its favour'}</h4>
        <ul class="bot-reason-list">${forThem.map(line).join('')}</ul>` : ''}
      ${missing}`;
    $('botModal').style.display = 'flex';
  }

  function closeReasonModal() {
    $('botModal').style.display = 'none';
  }

  function renderPagination(total, totalPages) {
    const el = $('botPagination');
    if (totalPages <= 1) { el.style.display = 'none'; return; }
    el.style.display = 'flex';

    let pages = '';
    const maxVisible = 5;
    let from = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    const to = Math.min(totalPages, from + maxVisible - 1);
    if (to - from < maxVisible - 1) from = Math.max(1, to - maxVisible + 1);
    for (let p = from; p <= to; p++) {
      pages += `<button class="page-btn${p === currentPage ? ' active' : ''}" data-page="${p}">${p}</button>`;
    }

    el.innerHTML = `<div class="page-numbers">${pages}</div>`;
    el.querySelectorAll('.page-btn').forEach((b) => {
      b.addEventListener('click', () => { currentPage = parseInt(b.dataset.page, 10); render(); });
    });
  }

  /**
   * Draw the last scan, if there is one, so opening the page costs nothing.
   *
   * Failures here are silent on purpose: the page is perfectly usable without a cache, and an error
   * banner about storage would be noise in front of a working Start button.
   */
  async function loadFromCache() {
    let viewer;
    try {
      viewer = await window.UnfollowBridge.getViewer();
    } catch (error) {
      return;
    }
    if (!viewer) return;
    viewerId = viewer.id;
    $('userName').textContent = viewer.username || '';

    const cache = await getBotScanCache(viewer.id);
    // Reading the viewer takes a moment; if the user hit Start in the meantime, a fresh scan is
    // already underway and the stored table must not be painted over the top of it.
    if (!cache || running) return;

    statsById = cache.stats || {};
    unresolvedIds = new Set(cache.unresolved || []);
    allUsers = cache.users;
    scored = window.BotDetector.scoreAll(allUsers, statsById);
    followersComplete = true;                      // only complete reads are ever stored
    render();
    showCacheAge(cache.timestamp);
  }

  // ---------------------------------------------------------------- wiring
  document.addEventListener('DOMContentLoaded', async () => {
    applyI18n();
    // Read before anything is drawn: rendering first would flash the full table at a free account.
    await loadMembership();
    $('startBotScan').addEventListener('click', runScan);
    $('runDeepChecks').addEventListener('click', runDeepScan);
    $('stopBotScan').addEventListener('click', () => { stopRequested = true; setStatus(msg('stopping') || 'Stopping…'); });

    document.querySelectorAll('.bot-filter-btn').forEach((b) => {
      b.addEventListener('click', () => {
        filter = b.dataset.filter;
        filterChosenByUser = true;
        currentPage = 1;
        document.querySelectorAll('.bot-filter-btn').forEach((x) => x.classList.toggle('active', x === b));
        if (scored.length) render();
      });
    });


    $('botModalClose').addEventListener('click', closeReasonModal);
    $('botModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeReasonModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeReasonModal();
    });

    // The upsell goes last, and inside a catch. It reaches the network for prices, and an
    // exception here used to abort the rest of this handler — leaving the page with no listeners
    // at all. A scanner must not be taken down by the modal that tries to sell an upgrade.
    try {
      wirePremiumModal();
      if (typeof initializePremiumModal === 'function') initializePremiumModal();
    } catch (error) {
      console.warn('[bot-scan] premium modal hazirlanamadi', error);
    }

    loadFromCache();
  });
})();
