const Stream = require('../models/Stream');

const scheduledTerminations = new Map();
const SCHEDULE_CHECK_INTERVAL = 15000;
const DURATION_CHECK_INTERVAL = 30000;
const RECURRING_CHECK_INTERVAL = 60000;
let recurringIntervalId = null;

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

  checkScheduledStreams();
  checkStreamDurations();
  setTimeout(checkRecurringStreams, 5000);
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

      const currentStream = await Stream.findById(stream.id);
      if (!currentStream || currentStream.status !== 'scheduled') {
        continue;
      }

      const baseUrl = process.env.BASE_URL || 'http://localhost:7575';
      const result = await streamingService.startStream(stream.id, false, baseUrl);

      if (!result.success) {
        console.error(`[Scheduler] Failed to start stream ${stream.id}: ${result.error}`);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking scheduled streams:', error);
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

        try {
          await streamingService.stopStream(stream.id);
        } catch (e) {
          await Stream.updateStatus(stream.id, 'offline', stream.user_id);
        }
      } else if (timeUntilEnd <= 60000 && !scheduledTerminations.has(stream.id)) {
        scheduleStreamTermination(stream.id, timeUntilEnd / 60000, stream.user_id);
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

  for (const [streamId, scheduled] of scheduledTerminations) {
    if (scheduled.timeoutId) {
      clearTimeout(scheduled.timeoutId);
    }
  }
  scheduledTerminations.clear();
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
  getNextOccurrence,
  shutdown
};
