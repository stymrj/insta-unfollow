/**
 * Scores followers on how likely they are to be bot or throwaway accounts.
 *
 * Weights are calibrated against how common each trait actually is, not against how bot-ish it
 * sounds. A trait most real followers share is worthless as evidence: on a sample of real follower
 * lists, most accounts are private and most have no active story, so neither is scored at all. An
 * anonymous profile picture turned up on about 5% and an empty display name on about 6% — that
 * rarity is what makes them worth something.
 *
 * Nothing here is proof. The score orders a list for a person to look at. It must never be wired
 * to anything that removes followers on its own.
 *
 * Exposed as window.BotDetector; the pages here are classic scripts, not modules.
 */
(function () {
  'use strict';


  /**
   * Instagram serves one shared asset to every account that has not set a photo, so its filename
   * identifies them. Only consulted when the authoritative flag is missing.
   *
   * If Instagram ever changes the asset the match simply stops firing, which lands back on the
   * behaviour this replaced — a missed signal, never a false accusation.
   */
  /**
   * Asset ids Instagram has served the default avatar under. Newest first.
   *
   * These go stale: the first entry below was the one this file shipped with, and by the time it
   * was measured Instagram had moved on — across 142 real followers it matched none of the seven
   * accounts that genuinely had no photo. An id list alone cannot be trusted to stay correct.
   */
  const DEFAULT_AVATAR_MARKERS = [
    '573323465_1219825463302212_7278921664109726296_n',  // measured 2026-08-14
    '44884218_345707102882519_2072920906358028800_n',    // the previous one, kept for old records
    'anonymoususer',
    'default_profile'
  ];

  /**
   * True when the avatar is Instagram's shared placeholder rather than something the user uploaded.
   *
   * Two rules, because one of them decays. The id list is exact but goes out of date whenever
   * Instagram swaps the asset. The extension is structural: uploaded avatars come back as .jpg and
   * the placeholder is served as .png, so the file type separates them without naming anything.
   * Measured over 142 followers: the extension rule caught all seven photo-less accounts with no
   * false positives, while the id list in place at the time caught none.
   *
   * Both are kept. If Instagram ever serves a real avatar as .png the id list still holds, and if
   * it swaps the asset again the extension rule still holds. This only runs when the authoritative
   * `has_anonymous_profile_picture` is absent, which is the case on the graphql path.
   */
  function isDefaultAvatar(url) {
    if (!url) return false;
    const lower = String(url).toLowerCase();
    if (DEFAULT_AVATAR_MARKERS.some((marker) => lower.includes(marker))) return true;
    // The path only. Instagram's avatar URLs carry a long signed query string, and one that
    // happened to contain ".png" would otherwise make a real .jpg avatar read as the placeholder.
    const path = lower.split('#')[0].split('?')[0];
    return path.endsWith('.png');
  }
  /** Cheap signals: everything comes from the follow-list record, so they cost no extra requests. */
  const BASIC_SIGNALS = [
    {
      id: 'anonymous_picture',
      weight: 40,
      label: 'No profile photo',
      /*
       * Read two ways, because this is the heaviest signal and losing it changes every verdict.
       *
       * `has_anonymous_profile_picture` is authoritative but only the v1 list carries it. A scan
       * that fell back to graphql has no such field, and absent must never be read as "has a
       * photo" — so the whole signal used to go unmeasured, every score came out 40 low, and
       * nothing could reach the bot threshold at all.
       *
       * The avatar URL is in both responses, and an account with no photo is served Instagram's
       * one shared default asset. Matching it recovers the signal on the fallback path. The
       * boolean still wins wherever it exists; the URL is only consulted when it does not.
       */
      requires: (u) => u.has_anonymous_profile_picture !== undefined || !!u.profile_pic_url,
      test: (u) => (u.has_anonymous_profile_picture !== undefined
        ? !!u.has_anonymous_profile_picture
        : isDefaultAvatar(u.profile_pic_url))
    },
    {
      id: 'empty_name',
      weight: 20,
      label: 'No display name',
      test: (u) => !String(u.full_name || '').trim()
    },
    {
      id: 'digit_heavy',
      weight: 15,
      label: 'Many digits in username',
      test: (u) => (String(u.username || '').match(/\d/g) || []).length >= 4
    },
    {
      id: 'trailing_digits',
      weight: 15,
      label: 'Username ends in a number run',
      test: (u) => /\d{3,}$/.test(String(u.username || ''))
    },
    {
      id: 'underscore_run',
      weight: 10,
      label: 'Unusual underscore pattern',
      test: (u) => (String(u.username || '').match(/_/g) || []).length >= 3
    },
    {
      id: 'very_long_username',
      weight: 5,
      label: 'Unusually long username',
      test: (u) => String(u.username || '').length >= 20
    },
    {
      id: 'verified',
      weight: -100,
      label: 'Verified account',
      test: (u) => !!u.is_verified
    },
    {
      id: 'has_badge',
      weight: -20,
      label: 'Has an account badge',
      requires: (u) => u.account_badges !== undefined,
      test: (u) => Array.isArray(u.account_badges) && u.account_badges.length > 0
    }
  ];

  /**
   * Signals that need the account's own profile, which costs one request each — so they only run
   * on accounts the cheap pass already found suspicious.
   */
  const DEEP_SIGNALS = [
    {
      id: 'no_posts',
      weight: 25,
      label: 'Has never posted',
      test: (u, s) => s.postCount === 0
    },
    {
      id: 'follows_far_more',
      weight: 20,
      label: 'Follows far more people than follow back',
      test: (u, s) => s.followerCount >= 0 && s.followingCount / Math.max(s.followerCount, 1) >= 5
    },
    {
      id: 'mass_following',
      weight: 15,
      label: 'Follows a very large number of accounts',
      test: (u, s) => s.followingCount >= 1500
    },
    {
      id: 'no_followers',
      weight: 10,
      label: 'Has no followers',
      test: (u, s) => s.followerCount === 0
    },
    // Evidence has to be able to point the other way too, or the deep pass can only ever convict.
    // Someone flagged for having no profile photo but who posts regularly to a balanced audience
    // is a person, and should drop off the list.
    {
      id: 'posts_regularly',
      weight: -25,
      label: 'Posts regularly',
      test: (u, s) => s.postCount >= 12
    },
    {
      id: 'balanced_audience',
      weight: -20,
      label: 'Balanced follower ratio',
      test: (u, s) => s.followerCount >= 100 && s.followingCount <= s.followerCount * 2
    }
  ];

  const VERDICT = { BOT: 'likely_bot', SUSPICIOUS: 'suspicious', CLEAN: 'looks_real' };

  const BOT_THRESHOLD = 55;
  const SUSPICIOUS_THRESHOLD = 30;

  function verdictFor(score) {
    if (score >= BOT_THRESHOLD) return VERDICT.BOT;
    if (score >= SUSPICIOUS_THRESHOLD) return VERDICT.SUSPICIOUS;
    return VERDICT.CLEAN;
  }

  /**
   * @param {object} user A follow-list record's node.
   * @param {object|null} stats Profile counts, when a deep pass has fetched them.
   * @returns {{score:number, verdict:string, reasons:Array, unavailable:Array, deep:boolean}}
   *   `reasons` exists so the table can show why an account was flagged. A score with no
   *   explanation is not something anyone should act on.
   */
  function scoreFollower(user, stats = null) {
    const reasons = [];
    /** Signals this record could not be tested against, because the field never arrived. */
    const unavailable = [];
    let score = 0;

    for (const signal of BASIC_SIGNALS) {
      // A field the source never sent is not evidence of innocence. Treating it as a failed test
      // would let a scan that fell back to graphql — which omits the heaviest signal of the set —
      // quietly report every bot as clean.
      if (signal.requires && !signal.requires(user)) { unavailable.push(signal.id); continue; }
      if (!signal.test(user)) continue;
      score += signal.weight;
      reasons.push({ id: signal.id, label: signal.label, weight: signal.weight });
    }

    if (stats) {
      for (const signal of DEEP_SIGNALS) {
        if (!signal.test(user, stats)) continue;
        score += signal.weight;
        reasons.push({ id: signal.id, label: signal.label, weight: signal.weight });
      }
    }

    // Not clamped to 100. Several strong signals routinely add past it, and clamping made every
    // deep-checked bot show the same number — which also collapsed the sort order, since the list
    // is ordered by this value. A raw 150 next to a 110 is the useful distinction.
    score = Math.max(0, score);
    return { score, verdict: verdictFor(score), reasons, unavailable, deep: !!stats };
  }

  /** Score everything, most suspicious first. */
  function scoreAll(users, statsById = {}) {
    return users
      .map((edge) => {
        const node = edge.node || edge;
        const id = String(node.id || '');
        return { user: node, id, ...scoreFollower(node, statsById[id] || null) };
      })
      .sort((a, b) => b.score - a.score);
  }

  /** Which accounts are worth spending a profile request on. */
  function pickDeepScanTargets(scored, limit) {
    return scored.filter((e) => e.score >= SUSPICIOUS_THRESHOLD && !e.deep).slice(0, limit);
  }

  window.BotDetector = {
    BASIC_SIGNALS,
    DEEP_SIGNALS,
    VERDICT,
    BOT_THRESHOLD,
    SUSPICIOUS_THRESHOLD,
    verdictFor,
    scoreFollower,
    scoreAll,
    pickDeepScanTargets
  };
})();
