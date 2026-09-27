const Stream = require('../models/Stream');

const scheduledTerminations = new Map();
// Dedupe so we only push the "enable YouTube auto-stop" update once per stream,
// not on every 30s poll while inside the last-stretch-before-End-Time window.
const autoStopFlipped = new Set();
// Cooldown after a failed (re)start attempt, shared by checkScheduledStreams and
// checkStalledScheduledStreams, so a persistently broken stream (bad channel token,
// etc.) fails once per cooldown window instead of hammering the YouTube API and the
// logs every 15s forever.
const recentStartFailures = new Map(); // streamId -> timestamp of last failure
const START_FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
const SCHEDULE_CHECK_INTERVAL = 15000;
const DURATION_CHECK_INTERVAL = 30000;
const RECURRING_CHECK_INTERVAL = 60000;
const STALLED_CHECK_INTERVAL = 20000;
let recurringIntervalId = null;
let stalledIntervalId = null;

let streamingService = null;
let initialized = false;
let scheduleIntervalId = null;
let durationIntervalId = null;

function init(streamingServiceInstance) {
  if (initialized) {
    return;
  }

  streamingService = streamingServiceInstance;
  streamingService.setSchedulerService(module.exports);
  initialized = true;

  scheduleIntervalId = setInterval(checkScheduledStreams, SCHEDULE_CHECK_INTERVAL);
  durationIntervalId = setInterval(checkStreamDurations, DURATION_CHECK_INTERVAL);
  recurringIntervalId = setInterval(checkRecurringStreams, RECURRING_CHECK_INTERVAL);
  stalledIntervalId = setInterval(checkStalledScheduledStreams, STALLED_CHECK_INTERVAL);

  checkScheduledStreams();
  checkStreamDurations();
  checkStalledScheduledStreams();
  setTimeout(checkRecurringStreams, 5000);
}

function canAttemptStart(streamId) {
  const lastFailure = recentStartFailures.get(streamId);
  return !lastFailure || (Date.now() - lastFailure) >= START_FAILURE_COOLDOWN_MS;
}

/**
 * Next occurrence of an anchored window (start/end) strictly after `now`.
 * daily → +1 day steps, weekly → +7 day steps; the window length is preserved.
 */
function getNextOccurrence(anchorStart, anchorEnd, repeatMode, now = new Date()) {
  const start = new Date(anchorStart);
  const end = new Date(anchorEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;

  const stepDays = repeatMode === 'weekly' ? 7 : 1;
  const nextStart = new Date(start);
  const nextEnd = new Date(end);

  // Roll forward until the window's START is in the future: a stream that was
  // stopped inside today's window waits for the next occurrence instead of
  // restarting immediately. Hard cap for safety.
  let guard = 0;
  while (nextStart <= now && guard < 4000) {
    nextStart.setDate(nextStart.getDate() + stepDays);
    nextEnd.setDate(nextEnd.getDate() + stepDays);
    guard++;
  }
  return { start: nextStart, end: nextEnd };
}

/**
 * Recurring streams (Repeat: daily / weekly): once a run has ended and the stream
 * is offline, roll the schedule forward and put it back into 'scheduled'.
 */
async function checkRecurringStreams() {
  try {
    if (!streamingService) return;
    const streams = await Stream.findRecurringOffline();
    const now = new Date();

    for (const stream of streams) {
      if (streamingService.isStreamActive(stream.id) || streamingService.isStreamStarting(stream.id)) continue;

      // Give a manual stop a short grace period so an operator can edit/delete first.
      const stoppedAt = stream.status_updated_at ? new Date(stream.status_updated_at) : null;
      if (stoppedAt && now - stoppedAt < 2 * 60 * 1000) continue;

      const next = getNextOccurrence(stream.repeat_anchor_start, stream.repeat_anchor_end, stream.repeat_mode, now);
      if (!next) continue;

      const durationMinutes = Math.round((next.end - next.start) / 60000);
      await Stream.update(stream.id, {
        schedule_time: next.start.toISOString(),
        end_time: next.end.toISOString(),
        duration: durationMinutes > 0 ? durationMinutes : null,
        status: 'scheduled',
        // fresh broadcast next time
        youtube_broadcast_id: null,
        youtube_stream_id: null,
        rtmp_url: stream.is_youtube_api ? '' : stream.rtmp_url,
        stream_key: stream.is_youtube_api ? '' : stream.stream_key
      });

      console.log(`[Scheduler] Recurring stream "${stream.title}" rescheduled (${stream.repeat_mode}) for ${next.start.toISOString()}`);
    }
  } catch (error) {
    console.error('[Scheduler] Error checking recurring streams:', error);
  }
}

async function checkScheduledStreams() {
  try {
    if (!streamingService) {
      return;
    }

    const now = new Date();
    const streams = await Stream.findScheduledInRange(null, now);

    for (const stream of streams) {
      if (streamingService.isStreamActive(stream.id) || streamingService.isStreamStarting(stream.id)) {
        continue;
      }

      if (!canAttemptStart(stream.id)) {
        continue;
      }

      const currentStream = await Stream.findById(stream.id);
      if (!currentStream || currentStream.status !== 'scheduled') {
        continue;
      }

      const baseUrl = process.env.BASE_URL || 'http://localhost:7575';
      const result = await streamingService.startStream(stream.id, false, baseUrl);

      if (!result.success) {
        console.error(`[Scheduler] Failed to start stream ${stream.id}: ${result.error}`);
        recentStartFailures.set(stream.id, Date.now());
      } else {
        recentStartFailures.delete(stream.id);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking scheduled streams:', error);
  }
}

/**
 * Self-healing watchdog for scheduled (non-nonstop) streams. Rotation already gets
 * this behavior for free - checkRotations() recomputes what should be running from
 * the rotation's own schedule every 60s, so a process restart never permanently
 * loses one. Plain Stream resume, by contrast, only happened once at boot (see
 * app.js), so if that one-shot check missed a stream - a race at startup, FFmpeg
 * dying moments after boot before the retry logic re-armed, several restarts in
 * quick succession, etc. - it was simply abandoned offline for the rest of its
 * schedule window with nothing to bring it back.
 *
 * This runs continuously (not just at boot) and picks up any stream that is
 * 'offline' while still genuinely inside its own Start/End window. It's safe to
 * run repeatedly because a real manual Stop fully clears schedule_time/end_time/
 * start_time (see streamingService.stopStream's plain updateStatus(id, 'offline')
 * call, no preserveEndTime) - so a deliberately-stopped stream never matches the
 * "still within window" condition below and is left alone. Nonstop streams are
 * intentionally NOT included here: they already resume unconditionally at boot,
 * and reviving one on a schedule-window heuristic risks fighting an intentional
 * manual stop (nonstop has no end_time to signal that a stop was intentional).
 */
async function checkStalledScheduledStreams() {
  try {
    if (!streamingService) return;

    const offlineStreams = await Stream.findAll(null, 'offline');
    const now = new Date();

    for (const stream of offlineStreams) {
      if (stream.nonstop) continue;
      if (!stream.start_time || !stream.end_time) continue;
      if (streamingService.isStreamActive(stream.id) || streamingService.isStreamStarting(stream.id)) continue;
      if (!canAttemptStart(stream.id)) continue;

      const startTime = new Date(stream.start_time);
      const endTime = new Date(stream.end_time);
      if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) continue;
      if (!(startTime <= now && endTime > now)) continue;

      console.log(`[Scheduler] Stream "${stream.title}" (${stream.id}) is offline but still within its Start/End window - resuming`);
      const baseUrl = process.env.BASE_URL || 'http://localhost:7575';
      const result = await streamingService.startStream(stream.id, false, baseUrl);

      if (!result.success) {
        console.error(`[Scheduler] Failed to resume stalled stream ${stream.id}: ${result.error}`);
        recentStartFailures.set(stream.id, Date.now());
      } else {
        recentStartFailures.delete(stream.id);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking stalled scheduled streams:', error);
  }
}

async function checkStreamDurations() {
  try {
    if (!streamingService) {
      return;
    }

    const liveStreams = await Stream.findAll(null, 'live');

    for (const stream of liveStreams) {
      if (!stream.end_time) {
        continue;
      }

      const endTime = new Date(stream.end_time);
      const now = new Date();
      const timeUntilEnd = endTime.getTime() - now.getTime();

      if (timeUntilEnd <= 0) {
        scheduledTerminations.delete(stream.id);
        autoStopFlipped.delete(stream.id);

        try {
          await streamingService.stopStream(stream.id);
        } catch (e) {
          await Stream.updateStatus(stream.id, 'offline', stream.user_id);
        }
        continue;
      }

      if (timeUntilEnd <= 60000 && !scheduledTerminations.has(stream.id)) {
        scheduleStreamTermination(stream.id, timeUntilEnd / 60000, stream.user_id);
      }

      // YouTube's own "auto stop" stays off for most of a scheduled stream (so a
      // brief restart/reconnect blip doesn't make YouTube end the broadcast on us)
      // and only gets turned on once we're inside the last stretch before End Time,
      // as a safety net. See youtubeService.computeAutoStopEnabled for the mirrored
      // logic applied at broadcast-creation time.
      if (stream.is_youtube_api && !stream.nonstop && !autoStopFlipped.has(stream.id)) {
        try {
          const youtubeService = require('./youtubeService');
          if (timeUntilEnd <= youtubeService.AUTO_STOP_LEAD_MS) {
            autoStopFlipped.add(stream.id);
            youtubeService.updateBroadcastAutoStop(stream.id, true).catch(() => {});
          }
        } catch (e) { /* youtubeService not usable (e.g. missing config) — skip silently */ }
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking stream durations:', error);
  }
}

function scheduleStreamTermination(streamId, durationMinutes, userId = null) {
  if (!streamingService) {
    return;
  }

  if (typeof durationMinutes !== 'number' || Number.isNaN(durationMinutes) || durationMinutes < 0) {
    return;
  }

  if (scheduledTerminations.has(streamId)) {
    const existing = scheduledTerminations.get(streamId);
    if (existing.timeoutId) {
      clearTimeout(existing.timeoutId);
    }
  }

  const durationMs = Math.max(0, durationMinutes * 60 * 1000);
  const targetEndTime = Date.now() + durationMs;

  const timeoutId = setTimeout(async () => {
    try {
      const stream = await Stream.findById(streamId);
      if (!stream || stream.status !== 'live') {
        scheduledTerminations.delete(streamId);
        return;
      }

      await streamingService.stopStream(streamId);
      scheduledTerminations.delete(streamId);
    } catch (error) {
      scheduledTerminations.delete(streamId);
    }
  }, durationMs);

  scheduledTerminations.set(streamId, {
    timeoutId,
    targetEndTime,
    userId
  });
}

function cancelStreamTermination(streamId) {
  if (scheduledTerminations.has(streamId)) {
    const scheduled = scheduledTerminations.get(streamId);
    if (scheduled.timeoutId) {
      clearTimeout(scheduled.timeoutId);
    }
    scheduledTerminations.delete(streamId);
    return true;
  }
  return false;
}

function getScheduledTermination(streamId) {
  const scheduled = scheduledTerminations.get(streamId);
  if (!scheduled) return null;

  return {
    streamId,
    targetEndTime: scheduled.targetEndTime,
    remainingMs: scheduled.targetEndTime ? scheduled.targetEndTime - Date.now() : null
  };
}

function handleStreamStopped(streamId) {
  autoStopFlipped.delete(streamId);
  recentStartFailures.delete(streamId);
  return cancelStreamTermination(streamId);
}

function shutdown() {
  if (scheduleIntervalId) {
    clearInterval(scheduleIntervalId);
  }
  if (durationIntervalId) {
    clearInterval(durationIntervalId);
  }
  if (recurringIntervalId) {
    clearInterval(recurringIntervalId);
  }
  if (stalledIntervalId) {
    clearInterval(stalledIntervalId);
  }

  for (const [streamId, scheduled] of scheduledTerminations) {
    if (scheduled.timeoutId) {
      clearTimeout(scheduled.timeoutId);
    }
  }
  scheduledTerminations.clear();
  autoStopFlipped.clear();
  recentStartFailures.clear();
}

module.exports = {
  init,
  scheduleStreamTermination,
  cancelStreamTermination,
  getScheduledTermination,
  handleStreamStopped,
  checkScheduledStreams,
  checkStreamDurations,
  checkRecurringStreams,
  checkStalledScheduledStreams,
  getNextOccurrence,
  shutdown
};
