/**
 * Helpers for YouTube Studio-style live monetization ("ad") settings.
 *
 * The settings object mirrors what YouTube Studio's Live Control Room exposes:
 *
 *   enabled          Ads on/off for the broadcast (adsMonetizationStatus)
 *   autoAds          Let YouTube insert mid-roll ad breaks automatically
 *   frequency        LOW | MEDIUM | HIGH  (YouTube-optimized frequency)
 *                    CUSTOM               (fixed interval chosen by the creator)
 *   intervalMinutes  6..30 in steps of 6 – used when frequency === 'CUSTOM'
 *   strategy         CONCURRENT     – every viewer sees the ad break at the same time
 *                    NON_CONCURRENT – ad breaks are staggered per viewer
 *   delayMinutes     Delay ads after the stream starts ("pause ads until")
 *   adBreakDuration  Default length (seconds) of a manual "Run ad break"
 *
 * It is stored as JSON in `streams.youtube_ad_settings`,
 * `rotation_items.youtube_ad_settings` and `stream_rotations.youtube_ad_settings`.
 */

const FREQUENCIES = ['LOW', 'MEDIUM', 'HIGH', 'CUSTOM'];
const STRATEGIES = ['CONCURRENT', 'NON_CONCURRENT'];
const INTERVAL_OPTIONS = [6, 12, 18, 24, 30];
const AD_BREAK_DURATIONS = [30, 60, 90, 120, 150, 180];

const DEFAULT_AD_SETTINGS = Object.freeze({
  enabled: false,
  autoAds: true,
  frequency: 'MEDIUM',
  intervalMinutes: 12,
  strategy: 'CONCURRENT',
  delayMinutes: 0,
  adBreakDuration: 60
});

function toBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Accepts: undefined/null, a boolean (legacy "monetization on/off"),
 * a JSON string, or an object. Always returns a fully populated settings object.
 */
function normalizeAdSettings(input, legacyEnabled) {
  let raw = input;

  if (typeof raw === 'string') {
    try {
      raw = raw.trim() ? JSON.parse(raw) : null;
    } catch (err) {
      raw = null;
    }
  }

  if (typeof raw === 'boolean') {
    raw = { enabled: raw };
  }

  if (!raw || typeof raw !== 'object') {
    raw = {};
    if (legacyEnabled !== undefined) {
      raw.enabled = toBool(legacyEnabled);
    }
  }

  const frequency = FREQUENCIES.includes(String(raw.frequency || '').toUpperCase())
    ? String(raw.frequency).toUpperCase()
    : DEFAULT_AD_SETTINGS.frequency;

  const strategy = STRATEGIES.includes(String(raw.strategy || '').toUpperCase())
    ? String(raw.strategy).toUpperCase()
    : DEFAULT_AD_SETTINGS.strategy;

  let intervalMinutes = clampInt(raw.intervalMinutes, 6, 30, DEFAULT_AD_SETTINGS.intervalMinutes);
  // YouTube rounds down to a multiple of 6 minutes – do the same so the UI matches reality.
  intervalMinutes = Math.max(6, Math.floor(intervalMinutes / 6) * 6);

  const adBreakDuration = AD_BREAK_DURATIONS.includes(parseInt(raw.adBreakDuration, 10))
    ? parseInt(raw.adBreakDuration, 10)
    : DEFAULT_AD_SETTINGS.adBreakDuration;

  return {
    enabled: raw.enabled === undefined ? DEFAULT_AD_SETTINGS.enabled : toBool(raw.enabled),
    autoAds: raw.autoAds === undefined ? DEFAULT_AD_SETTINGS.autoAds : toBool(raw.autoAds),
    frequency,
    intervalMinutes,
    strategy,
    delayMinutes: clampInt(raw.delayMinutes, 0, 24 * 60, DEFAULT_AD_SETTINGS.delayMinutes),
    adBreakDuration
  };
}

/**
 * Builds the `monetizationDetails` payload for liveBroadcasts.update.
 * `startTime` is the moment the broadcast (actually) starts – used for the delay.
 */
function buildMonetizationDetails(settings, startTime = new Date()) {
  const s = normalizeAdSettings(settings);

  if (!s.enabled) {
    return {
      adsMonetizationStatus: 'OFF',
      cuepointSchedule: { enabled: false }
    };
  }

  const cuepointSchedule = { enabled: !!s.autoAds };

  if (s.autoAds) {
    if (s.frequency === 'CUSTOM') {
      cuepointSchedule.creatorCuepointConfig = {
        scheduleStrategy: s.strategy,
        repeatIntervalSecs: s.intervalMinutes * 60
      };
    } else {
      cuepointSchedule.ytOptimizedCuepointConfig = s.frequency;
    }

    if (s.delayMinutes > 0) {
      const base = startTime instanceof Date ? startTime : new Date(startTime || Date.now());
      const pauseUntil = new Date(base.getTime() + s.delayMinutes * 60 * 1000);
      cuepointSchedule.pauseAdsUntil = pauseUntil.toISOString();
    } else {
      // A timestamp in the past un-pauses ads immediately (per API docs).
      cuepointSchedule.pauseAdsUntil = new Date(Date.now() - 60 * 1000).toISOString();
    }
  }

  return {
    adsMonetizationStatus: 'ON',
    cuepointSchedule
  };
}

/**
 * Converts what YouTube returns in `monetizationDetails` back to our settings shape
 * so the UI can show the real state of a broadcast.
 */
function settingsFromMonetizationDetails(details, fallback) {
  const base = normalizeAdSettings(fallback);
  if (!details || typeof details !== 'object') return base;

  const schedule = details.cuepointSchedule || {};
  const result = { ...base };

  if (details.adsMonetizationStatus) {
    result.enabled = String(details.adsMonetizationStatus).toUpperCase() === 'ON';
  }

  if (schedule.enabled !== undefined && schedule.enabled !== null) {
    result.autoAds = !!schedule.enabled;
  }

  if (schedule.ytOptimizedCuepointConfig) {
    result.frequency = String(schedule.ytOptimizedCuepointConfig).toUpperCase();
  } else if (schedule.creatorCuepointConfig || schedule.repeatIntervalSecs) {
    const cfg = schedule.creatorCuepointConfig || schedule;
    result.frequency = 'CUSTOM';
    if (cfg.repeatIntervalSecs) {
      result.intervalMinutes = Math.max(6, Math.floor(parseInt(cfg.repeatIntervalSecs, 10) / 60 / 6) * 6);
    }
    if (cfg.scheduleStrategy) {
      result.strategy = String(cfg.scheduleStrategy).toUpperCase();
    }
  }

  return normalizeAdSettings(result);
}

function describeAdSettings(settings) {
  const s = normalizeAdSettings(settings);
  if (!s.enabled) return 'Ads off';
  if (!s.autoAds) return 'Ads on · manual ad breaks only';
  const freq = s.frequency === 'CUSTOM'
    ? `every ${s.intervalMinutes} min`
    : `${s.frequency.charAt(0)}${s.frequency.slice(1).toLowerCase()} frequency`;
  const delay = s.delayMinutes > 0 ? ` · delayed ${s.delayMinutes} min` : '';
  return `Ads on · auto ${freq}${delay}`;
}

module.exports = {
  FREQUENCIES,
  STRATEGIES,
  INTERVAL_OPTIONS,
  AD_BREAK_DURATIONS,
  DEFAULT_AD_SETTINGS,
  normalizeAdSettings,
  buildMonetizationDetails,
  settingsFromMonetizationDetails,
  describeAdSettings
};
