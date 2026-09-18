/**
 * Notification service – pushes operational alerts to Telegram and/or a generic webhook.
 *
 * Settings live in app_settings:
 *   notify_enabled          '1' | '0'
 *   notify_telegram_token   bot token from @BotFather
 *   notify_telegram_chat_id chat / group / channel id
 *   notify_webhook_url      any HTTPS endpoint (receives JSON POST) – e.g. n8n, Discord, WhatsApp gateway
 *   notify_events           JSON array of enabled event keys (see EVENTS)
 *   notify_disk_threshold   percent (default 90)
 *
 * Usage from anywhere:  notificationService.notify('stream_stopped', { title, message, streamId })
 * Never throws – failures are logged only.
 */
const axios = require('axios');
const AppSettings = require('../models/AppSettings');

const EVENTS = {
  stream_stopped:        { label: 'Stream stopped unexpectedly (retries exhausted)', severity: 'critical', default: true },
  stream_retry:          { label: 'FFmpeg crashed and is being restarted',           severity: 'warning',  default: true },
  stream_stale:          { label: 'Stream stale (no output) – auto restart',         severity: 'warning',  default: true },
  stream_start_failed:   { label: 'Stream failed to start (YouTube/API error)',      severity: 'critical', default: true },
  stream_started:        { label: 'Stream went live',                                 severity: 'info',     default: false },
  stream_ended:          { label: 'Stream ended (schedule / manual stop)',            severity: 'info',     default: false },
  channel_expired:       { label: 'YouTube channel token expired – reconnect needed', severity: 'critical', default: true },
  monetization_rejected: { label: 'YouTube rejected monetization settings',           severity: 'warning',  default: true },
  translation_failed:    { label: 'Translation / localization failed',               severity: 'warning',  default: false },
  rotation_failed:       { label: 'Rotation item failed to start',                    severity: 'critical', default: true },
  disk_warning:          { label: 'Disk almost full',                                 severity: 'warning',  default: true },
  app_started:           { label: 'App (re)started',                                  severity: 'info',     default: true }
};

const SEVERITY_ICON = { critical: '🔴', warning: '🟠', info: '🟢' };

// Suppress identical alerts inside this window (event + key)
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const recentAlerts = new Map();

let settingsCache = null;
let settingsCacheAt = 0;
const SETTINGS_TTL = 30 * 1000;

let diskTimer = null;
let lastDiskWarningAt = 0;

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getSettings(force = false) {
  if (!force && settingsCache && Date.now() - settingsCacheAt < SETTINGS_TTL) return settingsCache;

  const [enabled, token, chatId, webhook, events, diskThreshold] = await Promise.all([
    AppSettings.get('notify_enabled'),
    AppSettings.get('notify_telegram_token'),
    AppSettings.get('notify_telegram_chat_id'),
    AppSettings.get('notify_webhook_url'),
    AppSettings.get('notify_events'),
    AppSettings.get('notify_disk_threshold')
  ]);

  let enabledEvents = null;
  try { enabledEvents = events ? JSON.parse(events) : null; } catch (e) { enabledEvents = null; }
  if (!Array.isArray(enabledEvents)) {
    enabledEvents = Object.keys(EVENTS).filter(k => EVENTS[k].default);
  }

  settingsCache = {
    enabled: enabled === '1' || enabled === 'true',
    telegramToken: token || '',
    telegramChatId: chatId || '',
    webhookUrl: webhook || '',
    events: enabledEvents,
    diskThreshold: parseInt(diskThreshold, 10) || 90
  };
  settingsCacheAt = Date.now();
  return settingsCache;
}

async function saveSettings(data) {
  const ops = [];
  if (data.enabled !== undefined) ops.push(AppSettings.set('notify_enabled', data.enabled ? '1' : '0'));
  if (data.telegramToken !== undefined) ops.push(AppSettings.set('notify_telegram_token', String(data.telegramToken || '').trim()));
  if (data.telegramChatId !== undefined) ops.push(AppSettings.set('notify_telegram_chat_id', String(data.telegramChatId || '').trim()));
  if (data.webhookUrl !== undefined) ops.push(AppSettings.set('notify_webhook_url', String(data.webhookUrl || '').trim()));
  if (data.events !== undefined) {
    const valid = (Array.isArray(data.events) ? data.events : []).filter(k => EVENTS[k]);
    ops.push(AppSettings.set('notify_events', JSON.stringify(valid)));
  }
  if (data.diskThreshold !== undefined) {
    const t = Math.min(99, Math.max(50, parseInt(data.diskThreshold, 10) || 90));
    ops.push(AppSettings.set('notify_disk_threshold', String(t)));
  }
  await Promise.all(ops);
  settingsCache = null;
  return getSettings(true);
}

function formatTelegram(event, payload) {
  const meta = EVENTS[event] || { severity: 'info', label: event };
  const icon = SEVERITY_ICON[meta.severity] || 'ℹ️';
  const lines = [`${icon} <b>${escapeHtml(payload.title || meta.label)}</b>`];
  if (payload.message) lines.push(escapeHtml(payload.message));
  if (payload.streamTitle) lines.push(`Stream: <code>${escapeHtml(payload.streamTitle)}</code>`);
  if (payload.channelName) lines.push(`Channel: <code>${escapeHtml(payload.channelName)}</code>`);
  if (payload.error) lines.push(`Error: <i>${escapeHtml(String(payload.error).slice(0, 300))}</i>`);
  lines.push(`<i>${new Date().toLocaleString('en-GB', { hour12: false })} · streamod</i>`);
  return lines.join('\n');
}

async function sendTelegram(settings, text) {
  if (!settings.telegramToken || !settings.telegramChatId) return false;
  const url = `https://api.telegram.org/bot${settings.telegramToken}/sendMessage`;
  await axios.post(url, {
    chat_id: settings.telegramChatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }, { timeout: 15000 });
  return true;
}

async function sendWebhook(settings, event, payload) {
  if (!settings.webhookUrl) return false;
  const meta = EVENTS[event] || { severity: 'info', label: event };
  await axios.post(settings.webhookUrl, {
    source: 'streamod',
    event,
    severity: meta.severity,
    title: payload.title || meta.label,
    message: payload.message || '',
    text: formatTelegram(event, payload).replace(/<[^>]+>/g, ''),
    data: payload,
    timestamp: new Date().toISOString()
  }, { timeout: 15000 });
  return true;
}

/**
 * Sends an alert. `payload`: { title, message, streamId, streamTitle, channelName, error, key }
 * `key` (optional) is used for de-duplication; defaults to streamId or title.
 */
async function notify(event, payload = {}) {
  try {
    const settings = await getSettings();
    if (!settings.enabled) return { sent: false, reason: 'disabled' };
    if (!settings.events.includes(event)) return { sent: false, reason: 'event-off' };
    if (!settings.telegramToken && !settings.webhookUrl) return { sent: false, reason: 'no-target' };

    const dedupeKey = `${event}:${payload.key || payload.streamId || payload.title || ''}`;
    const last = recentAlerts.get(dedupeKey);
    if (last && Date.now() - last < DEDUPE_WINDOW_MS) return { sent: false, reason: 'deduped' };
    recentAlerts.set(dedupeKey, Date.now());
    if (recentAlerts.size > 500) {
      const cutoff = Date.now() - DEDUPE_WINDOW_MS;
      for (const [k, t] of recentAlerts) if (t < cutoff) recentAlerts.delete(k);
    }

    const text = formatTelegram(event, payload);
    const results = await Promise.allSettled([
      sendTelegram(settings, text),
      sendWebhook(settings, event, payload)
    ]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const target = i === 0 ? 'Telegram' : 'Webhook';
        console.error(`[Notify] ${target} failed for ${event}: ${r.reason?.response?.data?.description || r.reason?.message}`);
      }
    });
    return { sent: results.some(r => r.status === 'fulfilled' && r.value) };
  } catch (err) {
    console.error('[Notify] Unexpected error:', err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Sends a test message regardless of enabled events (used by Settings → Test).
 */
async function sendTest(overrides = {}) {
  const settings = { ...(await getSettings(true)), ...overrides };
  if (!settings.telegramToken && !settings.webhookUrl) {
    throw new Error('Configure a Telegram bot token + chat id or a webhook URL first');
  }
  const payload = { title: 'Test notification', message: 'If you can read this, streamod alerts are working. 🎉' };
  const results = await Promise.allSettled([
    sendTelegram(settings, formatTelegram('app_started', payload)),
    sendWebhook(settings, 'app_started', payload)
  ]);
  const errors = results.filter(r => r.status === 'rejected')
    .map((r, i) => `${r.reason?.response?.data?.description || r.reason?.message}`);
  const ok = results.some(r => r.status === 'fulfilled' && r.value);
  if (!ok) throw new Error(errors.join('; ') || 'No target delivered the message');
  return { ok, errors };
}

async function checkDisk() {
  try {
    const settings = await getSettings();
    if (!settings.enabled || !settings.events.includes('disk_warning')) return;
    const { getSystemStats } = require('./systemMonitor');
    const stats = await getSystemStats();
    const pct = parseFloat(stats?.disk?.usagePercent) || 0;
    if (pct >= settings.diskThreshold && Date.now() - lastDiskWarningAt > 6 * 60 * 60 * 1000) {
      lastDiskWarningAt = Date.now();
      await notify('disk_warning', {
        title: `Disk ${pct}% full`,
        message: `${stats.disk.used} of ${stats.disk.total} used on ${stats.disk.drive}. Free: ${stats.disk.free}. Old recordings/uploads may need cleanup.`,
        key: 'disk'
      });
    }
  } catch (err) {
    console.error('[Notify] Disk check failed:', err.message);
  }
}

function init() {
  if (diskTimer) clearInterval(diskTimer);
  diskTimer = setInterval(checkDisk, 10 * 60 * 1000);
  setTimeout(checkDisk, 60 * 1000);
  setTimeout(() => notify('app_started', {
    title: 'streamod started',
    message: `Process ${process.pid} is up. Active streams will resume according to their status.`,
    key: 'boot'
  }), 15 * 1000);
}

function shutdown() {
  if (diskTimer) clearInterval(diskTimer);
  diskTimer = null;
}

module.exports = {
  EVENTS,
  notify,
  sendTest,
  getSettings,
  saveSettings,
  checkDisk,
  init,
  shutdown
};
