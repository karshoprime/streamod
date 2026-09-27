const { google } = require('googleapis');
const { encrypt, decrypt } = require('../utils/encryption');
const User = require('../models/User');
const Stream = require('../models/Stream');
const YoutubeChannel = require('../models/YoutubeChannel');
const StreamKey = require('../models/StreamKey');
const fs = require('fs');
const path = require('path');
const {
  normalizeAdSettings,
  buildMonetizationDetails,
  settingsFromMonetizationDetails,
  describeAdSettings,
  AD_BREAK_DURATIONS
} = require('./adSettings');
const { translateMetadata } = require('./translationService');
const { sanitizeLanguageList } = require('../config/youtubeLanguages');
const notificationService = require('./notificationService');

function isInvalidGrantError(error) {
  return (
    error?.response?.data?.error === 'invalid_grant' ||
    error?.message?.includes('invalid_grant') ||
    error?.response?.data?.error_description?.includes('expired or revoked')
  );
}

/**
 * Call from any catch block that talked to YouTube with a channel's tokens.
 * Marks the channel expired (so the UI shows "Reconnect") and alerts once.
 */
async function handleYouTubeAuthError(channel, error) {
  if (!channel || !isInvalidGrantError(error)) return false;
  try {
    if (channel.auth_status !== 'expired') {
      await YoutubeChannel.update(channel.id, { auth_status: 'expired', auth_error: 'Token expired or revoked' });
    }
    notificationService.notify('channel_expired', {
      title: 'YouTube channel needs reconnect',
      message: 'The OAuth token was revoked or expired. Streams on this channel cannot start until you reconnect it in Settings → Integration.',
      channelName: channel.channel_name,
      key: channel.id
    });
  } catch (err) {
    console.error('[YouTubeService] Failed marking channel expired:', err.message);
  }
  return true;
}

const loggedAlreadyHasBroadcast = new Set();

// How long before End Time we let YouTube's own "auto stop" take over. Kept off
// for the bulk of a scheduled/nonstop stream so a brief hiccup (server restart,
// FFmpeg reconnect) doesn't make YouTube end the broadcast on its own — only
// turned on close to the real end, as a safety net so the broadcast still wraps
// up cleanly if our own termination logic doesn't fire for some reason.
const AUTO_STOP_LEAD_MS = 30 * 60 * 1000;

/**
 * Whether the broadcast's contentDetails.enableAutoStop should be on right now:
 * - Live Nonstop streams: always off (there is no "end" to auto-stop at).
 * - Scheduled streams (have end_time): off until AUTO_STOP_LEAD_MS before end_time,
 *   then on, so YouTube itself can close things out if our own stop logic misses.
 * - No schedule at all (ad-hoc "Go Live Now"): unchanged, YouTube default (on).
 */
function computeAutoStopEnabled(stream, now = new Date()) {
  if (stream.nonstop) return false;
  if (stream.end_time) {
    const endTime = new Date(stream.end_time);
    const autoStopFrom = new Date(endTime.getTime() - AUTO_STOP_LEAD_MS);
    return now >= autoStopFrom;
  }
  return true;
}

function getYouTubeOAuth2Client(clientId, clientSecret, redirectUri) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function omitUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}

/**
 * Builds an authenticated YouTube client for a channel row. Tokens refreshed by
 * google-auth-library are persisted back to the channel.
 */
function getYouTubeClientForChannel(user, channel, redirectUri) {
  const clientSecret = decrypt(user.youtube_client_secret);
  const accessToken = decrypt(channel.access_token);
  const refreshToken = channel.refresh_token ? decrypt(channel.refresh_token) : null;

  if (!clientSecret || !accessToken) {
    throw new Error('Failed to decrypt YouTube credentials');
  }

  const oauth2Client = getYouTubeOAuth2Client(
    user.youtube_client_id,
    clientSecret,
    redirectUri || user.youtube_redirect_uri || `http://localhost:${process.env.PORT || 7575}/auth/youtube/callback`
  );

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken || undefined
  });

  oauth2Client.on('tokens', async (tokens) => {
    try {
      const update = {};
      if (tokens.access_token) update.access_token = encrypt(tokens.access_token);
      if (tokens.refresh_token) update.refresh_token = encrypt(tokens.refresh_token);
      if (Object.keys(update).length > 0) {
        await YoutubeChannel.update(channel.id, update);
      }
    } catch (err) {
      console.error('[YouTubeService] Failed persisting refreshed tokens:', err.message);
    }
  });

  return google.youtube({ version: 'v3', auth: oauth2Client });
}

/**
 * Resolves user + channel for a stream and returns an authenticated client.
 */
async function getYouTubeClientForStream(stream, redirectUri) {
  const user = await User.findById(stream.user_id);
  if (!user || !user.youtube_client_id || !user.youtube_client_secret) {
    throw new Error('YouTube API credentials not configured');
  }

  let channel = stream.youtube_channel_id ? await YoutubeChannel.findById(stream.youtube_channel_id) : null;
  if (!channel) channel = await YoutubeChannel.findDefault(stream.user_id);
  if (!channel) {
    const channels = await YoutubeChannel.findAll(stream.user_id);
    channel = channels[0];
  }
  if (!channel || !channel.access_token) {
    throw new Error('YouTube channel not found or not connected');
  }

  return { user, channel, youtube: getYouTubeClientForChannel(user, channel, redirectUri) };
}

/**
 * Reads the current monetization state of a broadcast from YouTube.
 */
async function getBroadcastMonetization(youtube, broadcastId) {
  const response = await youtube.liveBroadcasts.list({
    part: 'id,snippet,status,monetizationDetails',
    id: broadcastId
  });

  const broadcast = response.data.items?.[0];
  if (!broadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }

  const details = broadcast.monetizationDetails || {};
  return {
    broadcastId: broadcast.id,
    lifeCycleStatus: broadcast.status?.lifeCycleStatus || null,
    actualStartTime: broadcast.snippet?.actualStartTime || null,
    scheduledStartTime: broadcast.snippet?.scheduledStartTime || null,
    eligibleForAdsMonetization: details.eligibleForAdsMonetization,
    adsMonetizationStatus: details.adsMonetizationStatus || null,
    cuepointSchedule: details.cuepointSchedule || null,
    settings: settingsFromMonetizationDetails(details)
  };
}

/**
 * Applies YouTube Studio-style ad settings to a broadcast.
 * `settings` may be a boolean (legacy on/off), a JSON string or a settings object.
 * Returns the normalized settings that were applied.
 */
async function syncBroadcastMonetization(youtube, broadcastId, settings) {
  const adSettings = normalizeAdSettings(settings);

  const broadcastResponse = await youtube.liveBroadcasts.list({
    part: 'id,snippet,contentDetails,status,monetizationDetails',
    id: broadcastId
  });

  const currentBroadcast = broadcastResponse.data.items?.[0];
  if (!currentBroadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }

  const currentSnippet = currentBroadcast.snippet || {};
  const currentContentDetails = currentBroadcast.contentDetails || {};
  const currentStatus = currentBroadcast.status || {};
  const currentMonitorStream = currentContentDetails.monitorStream || {};
  const monitorStream = omitUndefined({
    enableMonitorStream: currentMonitorStream.enableMonitorStream,
    broadcastStreamDelayMs:
      currentMonitorStream.enableMonitorStream !== undefined
        ? currentMonitorStream.broadcastStreamDelayMs ?? 0
        : undefined
  });

  // "Delay ads at start" is measured from the actual start when live, otherwise from now.
  const startTime = currentSnippet.actualStartTime ? new Date(currentSnippet.actualStartTime) : new Date();
  const monetizationDetails = buildMonetizationDetails(adSettings, startTime);

  const requestBody = {
    id: broadcastId,
    snippet: omitUndefined({
      title: currentSnippet.title,
      description: currentSnippet.description || '',
      scheduledStartTime: currentSnippet.scheduledStartTime,
      scheduledEndTime: currentSnippet.scheduledEndTime
    }),
    contentDetails: omitUndefined({
      boundStreamId: currentContentDetails.boundStreamId,
      enableAutoStart: currentContentDetails.enableAutoStart,
      enableAutoStop: currentContentDetails.enableAutoStop,
      enableClosedCaptions: currentContentDetails.enableClosedCaptions,
      enableContentEncryption: currentContentDetails.enableContentEncryption,
      enableDvr: currentContentDetails.enableDvr,
      enableEmbed: currentContentDetails.enableEmbed,
      latencyPreference: currentContentDetails.latencyPreference,
      projection: currentContentDetails.projection,
      recordFromStart: currentContentDetails.recordFromStart,
      startWithSlate: currentContentDetails.startWithSlate,
      monitorStream: Object.keys(monitorStream).length > 0 ? monitorStream : undefined
    }),
    status: omitUndefined({
      privacyStatus: currentStatus.privacyStatus,
      selfDeclaredMadeForKids: currentStatus.selfDeclaredMadeForKids
    }),
    monetizationDetails
  };

  await youtube.liveBroadcasts.update({
    part: 'id,snippet,contentDetails,status,monetizationDetails',
    requestBody
  });

  console.log(`[YouTubeService] Monetization synced for broadcast ${broadcastId}: ${describeAdSettings(adSettings)}`);
  return adSettings;
}

/**
 * Inserts a manual ad break ("Run ad break" in YouTube Studio) into a live broadcast.
 */
async function insertAdBreak(youtube, broadcastId, durationSecs = 60) {
  const duration = AD_BREAK_DURATIONS.includes(parseInt(durationSecs, 10))
    ? parseInt(durationSecs, 10)
    : 60;

  const response = await youtube.liveBroadcasts.insertCuepoint({
    id: broadcastId,
    requestBody: {
      cueType: 'cueTypeAd',
      durationSecs: duration
    }
  });

  console.log(`[YouTubeService] Inserted ${duration}s ad break into broadcast ${broadcastId}`);
  return response.data;
}

/**
 * Translates title/description and writes them as YouTube localizations.
 * Returns the localizations object that was applied (may be empty).
 */
async function applyBroadcastLocalizations(youtube, videoId, { user, title, description, sourceLanguage, targetLanguages, maxTitleLength }) {
  const languages = sanitizeLanguageList(targetLanguages).filter(code => code !== sourceLanguage);
  if (!languages.length) return {};

  const localizations = await translateMetadata({
    title,
    description: description || '',
    sourceLanguage: sourceLanguage || 'en',
    targetLanguages: languages,
    maxTitleLength: maxTitleLength || 100,
    user
  });

  if (!Object.keys(localizations).length) {
    console.warn(`[YouTubeService] No localizations generated for ${videoId}`);
    return {};
  }

  // defaultLanguage must be set before localizations are accepted by YouTube.
  const videoResponse = await youtube.videos.list({ part: 'snippet', id: videoId });
  const snippet = videoResponse.data.items?.[0]?.snippet;
  if (snippet && snippet.defaultLanguage !== (sourceLanguage || 'en')) {
    await youtube.videos.update({
      part: 'snippet',
      requestBody: {
        id: videoId,
        snippet: {
          title: snippet.title,
          description: snippet.description || '',
          categoryId: snippet.categoryId || '22',
          tags: snippet.tags,
          defaultLanguage: sourceLanguage || 'en',
          defaultAudioLanguage: snippet.defaultAudioLanguage
        }
      }
    });
  }

  await youtube.videos.update({
    part: 'localizations',
    requestBody: { id: videoId, localizations }
  });

  console.log(`[YouTubeService] Applied ${Object.keys(localizations).length} localization(s) to ${videoId}`);
  return localizations;
}

/**
 * Resolves the YouTube liveStream (RTMP ingestion resource) to bind a broadcast to.
 * Mirrors what rotations already do (reuse the same ingestion key across runs), but
 * keyed by a user-chosen "Stream Name" instead of the rotation's own name: if a key
 * stream with that name exists it is reused as-is (same RTMP url/key); otherwise a
 * new one is created and remembered under that name for next time.
 */
async function resolveKeyStream(youtube, { userId, channelId, name, fallbackTitle }) {
  const trimmedName = (name || '').trim();

  if (trimmedName) {
    const existing = await StreamKey.findByName(userId, channelId, trimmedName);
    if (existing && existing.youtube_stream_id) {
      try {
        const response = await youtube.liveStreams.list({
          part: 'id,snippet,cdn,status',
          id: existing.youtube_stream_id
        });
        const liveStream = response.data.items?.[0];
        if (liveStream && liveStream.cdn?.ingestionInfo) {
          console.log(`[YouTubeService] Reusing key stream "${trimmedName}" (${liveStream.id})`);
          return {
            streamId: liveStream.id,
            streamKey: liveStream.cdn.ingestionInfo.streamName,
            rtmpUrl: liveStream.cdn.ingestionInfo.ingestionAddress,
            reused: true
          };
        }
      } catch (err) {
        console.warn(`[YouTubeService] Saved key stream "${trimmedName}" is no longer valid, creating a new one: ${err.message}`);
      }
    }
  }

  const streamResponse = await youtube.liveStreams.insert({
    part: 'snippet,cdn,contentDetails,status',
    requestBody: {
      snippet: {
        title: trimmedName || `${fallbackTitle} - Stream`
      },
      cdn: {
        frameRate: '30fps',
        ingestionType: 'rtmp',
        resolution: '1080p'
      },
      contentDetails: {
        // This is exactly what "Stream Name (key stream)" is for: rebind the SAME
        // ingestion key across multiple broadcasts. isReusable: false tells YouTube
        // the opposite - single-use only, and (per the API) not surfaced as a
        // manageable key in YouTube Studio at all, which is why it was showing up
        // there as an anonymous "auto-created" key instead of "Live_02". Rotations
        // never set this flag (so it defaults to reusable) and don't have this
        // problem - matching that here.
        isReusable: true
      }
    }
  });

  const liveStream = streamResponse.data;
  console.log(`[YouTubeService] Created live stream: ${liveStream.id}`);

  const result = {
    streamId: liveStream.id,
    streamKey: liveStream.cdn.ingestionInfo.streamName,
    rtmpUrl: liveStream.cdn.ingestionInfo.ingestionAddress,
    reused: false
  };

  if (trimmedName) {
    try {
      const existing = await StreamKey.findByName(userId, channelId, trimmedName);
      if (existing) {
        await StreamKey.update(existing.id, {
          youtubeStreamId: result.streamId,
          youtubeStreamKey: result.streamKey,
          youtubeRtmpUrl: result.rtmpUrl
        });
      } else {
        await StreamKey.create({
          userId,
          channelId,
          name: trimmedName,
          youtubeStreamId: result.streamId,
          youtubeStreamKey: result.streamKey,
          youtubeRtmpUrl: result.rtmpUrl
        });
      }
    } catch (err) {
      console.warn(`[YouTubeService] Could not save key stream "${trimmedName}": ${err.message}`);
    }
  }

  return result;
}

async function createYouTubeBroadcast(streamId, baseUrl) {
  try {
    return await createYouTubeBroadcastInner(streamId, baseUrl);
  } catch (error) {
    try {
      const stream = await Stream.findById(streamId);
      const channel = stream?.youtube_channel_id ? await YoutubeChannel.findById(stream.youtube_channel_id) : null;
      await handleYouTubeAuthError(channel, error);
    } catch (e) { /* ignore */ }
    throw error;
  }
}

async function createYouTubeBroadcastInner(streamId, baseUrl) {
  const stream = await Stream.findById(streamId);
  if (!stream) {
    throw new Error('Stream not found');
  }

  if (!stream.is_youtube_api) {
    return { success: true, message: 'Not a YouTube API stream' };
  }

  const user = await User.findById(stream.user_id);
  if (!user || !user.youtube_client_id || !user.youtube_client_secret) {
    throw new Error('YouTube API credentials not configured');
  }

  const selectedChannel = await YoutubeChannel.findById(stream.youtube_channel_id);
  if (!selectedChannel || !selectedChannel.access_token || !selectedChannel.refresh_token) {
    throw new Error('YouTube channel not found or not connected');
  }

  const clientSecret = decrypt(user.youtube_client_secret);
  const accessToken = decrypt(selectedChannel.access_token);
  const refreshToken = decrypt(selectedChannel.refresh_token);

  if (!clientSecret || !accessToken) {
    throw new Error('Failed to decrypt YouTube credentials');
  }

  const redirectUri = `${baseUrl}/auth/youtube/callback`;
  const oauth2Client = getYouTubeOAuth2Client(user.youtube_client_id, clientSecret, redirectUri);
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken
  });

  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await YoutubeChannel.update(selectedChannel.id, {
        access_token: encrypt(tokens.access_token)
      });
    }
    if (tokens.refresh_token) {
      await YoutubeChannel.update(selectedChannel.id, {
        refresh_token: encrypt(tokens.refresh_token)
      });
    }
  });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  if (stream.youtube_broadcast_id && stream.rtmp_url && stream.stream_key) {
    // Reusing a broadcast we already created blindly assumed it was still usable.
    // If it was already ended on YouTube's side (manually stopped in Studio, or
    // YouTube's own auto-stop kicked in) the old ingestion is dead — pushing FFmpeg
    // into it does nothing, so verify it's still alive before reusing it.
    const ENDED_LIFECYCLE_STATUSES = ['complete', 'revoked'];
    let reuseOk = true;
    try {
      const existingResp = await youtube.liveBroadcasts.list({
        part: 'status',
        id: stream.youtube_broadcast_id
      });
      const existingBroadcast = existingResp.data.items?.[0];
      const lifeCycleStatus = existingBroadcast?.status?.lifeCycleStatus || null;
      if (!existingBroadcast || ENDED_LIFECYCLE_STATUSES.includes(lifeCycleStatus)) {
        reuseOk = false;
        console.log(`[YouTubeService] Stream ${streamId}'s saved broadcast ${stream.youtube_broadcast_id} is ${lifeCycleStatus || 'gone'} on YouTube — creating a new broadcast instead of reusing it`);
      }
    } catch (checkError) {
      // Can't verify right now (transient API hiccup) — don't block a resume over it,
      // reuse optimistically like before.
      console.warn(`[YouTubeService] Could not verify broadcast status for stream ${streamId}, reusing anyway: ${checkError.message}`);
    }

    if (reuseOk) {
      if (!loggedAlreadyHasBroadcast.has(streamId)) {
        console.log(`[YouTubeService] Stream ${streamId} already has YouTube broadcast, skipping creation`);
        loggedAlreadyHasBroadcast.add(streamId);
      }
      return {
        success: true,
        rtmpUrl: stream.rtmp_url,
        streamKey: stream.stream_key,
        broadcastId: stream.youtube_broadcast_id,
        streamId: stream.youtube_stream_id
      };
    }
  }

  const tagsArray = stream.youtube_tags ? stream.youtube_tags.split(',').map(t => t.trim()).filter(t => t) : [];

  const broadcastSnippet = {
    title: stream.title,
    description: stream.youtube_description || '',
    scheduledStartTime: new Date().toISOString()
  };

  console.log(`[YouTubeService] Creating YouTube broadcast for stream ${streamId}`);

  let broadcastResponse;
  const broadcastData = {
    snippet: broadcastSnippet,
    contentDetails: {
      enableAutoStart: true,
      enableAutoStop: computeAutoStopEnabled(stream),
      monitorStream: {
        enableMonitorStream: false
      }
    },
    status: {
      privacyStatus: stream.youtube_privacy || 'unlisted',
      selfDeclaredMadeForKids: false
    }
  };

  broadcastResponse = await youtube.liveBroadcasts.insert({
    part: 'snippet,contentDetails,status',
    requestBody: broadcastData
  });

  const broadcast = broadcastResponse.data;
  console.log(`[YouTubeService] Created broadcast: ${broadcast.id}`);

  const adSettings = normalizeAdSettings(stream.youtube_ad_settings, stream.youtube_monetization);
  if (adSettings.enabled) {
    try {
      await syncBroadcastMonetization(youtube, broadcast.id, adSettings);
    } catch (monetizationError) {
      console.warn(`[YouTubeService] Failed to enable monetization for broadcast ${broadcast.id}. Continuing without monetization. Error: ${monetizationError.message}`);
      notificationService.notify('monetization_rejected', {
        title: 'YouTube rejected monetization settings',
        message: 'The stream continues WITHOUT ads. Check that the channel is in the Partner Program and eligible for live ads.',
        streamId, streamTitle: stream.title, channelName: selectedChannel.channel_name,
        error: monetizationError.response?.data?.error?.message || monetizationError.message
      });
      await Stream.update(streamId, {
        youtube_monetization: false,
        youtube_ad_settings: JSON.stringify({ ...adSettings, enabled: false })
      });
    }
  }

  if (tagsArray.length > 0 || stream.youtube_category) {
    try {
      const videoResponse = await youtube.videos.list({
        part: 'snippet',
        id: broadcast.id
      });

      if (videoResponse.data.items && videoResponse.data.items.length > 0) {
        const currentSnippet = videoResponse.data.items[0].snippet;
        await youtube.videos.update({
          part: 'snippet',
          requestBody: {
            id: broadcast.id,
            snippet: {
              title: stream.title,
              description: stream.youtube_description || '',
              categoryId: stream.youtube_category || '22',
              tags: tagsArray.length > 0 ? tagsArray : currentSnippet.tags,
              defaultLanguage: currentSnippet.defaultLanguage,
              defaultAudioLanguage: currentSnippet.defaultAudioLanguage
            }
          }
        });
      }
    } catch (updateError) {
      console.log('[YouTubeService] Note: Could not update video metadata:', updateError.message);
    }
  }

  // Optional: translate title/description into the selected languages.
  let targetLanguages = [];
  try {
    targetLanguages = stream.youtube_localizations ? JSON.parse(stream.youtube_localizations) : [];
  } catch (err) {
    targetLanguages = [];
  }
  if (Array.isArray(targetLanguages) && targetLanguages.length > 0) {
    try {
      await applyBroadcastLocalizations(youtube, broadcast.id, {
        user,
        title: stream.title,
        description: stream.youtube_description || '',
        sourceLanguage: stream.youtube_source_language || selectedChannel.source_language || 'en',
        targetLanguages,
        maxTitleLength: selectedChannel.max_title_length || 100
      });
    } catch (locError) {
      console.warn(`[YouTubeService] Could not apply localizations for broadcast ${broadcast.id}: ${locError.message}`);
      notificationService.notify('translation_failed', {
        title: 'Translation failed',
        streamId, streamTitle: stream.title, error: locError.response?.data?.error?.message || locError.message
      });
    }
  }

  if (stream.youtube_thumbnail) {
    try {
      const projectRoot = path.resolve(__dirname, '..');
      const thumbnailPath = path.join(projectRoot, 'public', stream.youtube_thumbnail);
      if (fs.existsSync(thumbnailPath)) {
        const thumbnailStream = fs.createReadStream(thumbnailPath);
        await youtube.thumbnails.set({
          videoId: broadcast.id,
          media: {
            mimeType: 'image/jpeg',
            body: thumbnailStream
          }
        });
        console.log(`[YouTubeService] Uploaded thumbnail for broadcast ${broadcast.id}`);
      }
    } catch (thumbError) {
      console.log('[YouTubeService] Note: Could not upload thumbnail:', thumbError.message);
    }
  }

  const keyStream = await resolveKeyStream(youtube, {
    userId: stream.user_id,
    channelId: stream.youtube_channel_id,
    name: stream.key_stream_name,
    fallbackTitle: stream.title
  });

  await youtube.liveBroadcasts.bind({
    part: 'id,contentDetails',
    id: broadcast.id,
    streamId: keyStream.streamId
  });

  const rtmpUrl = keyStream.rtmpUrl;
  const streamKey = keyStream.streamKey;

  await Stream.update(streamId, {
    youtube_broadcast_id: broadcast.id,
    youtube_stream_id: keyStream.streamId,
    rtmp_url: rtmpUrl,
    stream_key: streamKey
  });

  console.log(`[YouTubeService] YouTube broadcast created successfully for stream ${streamId}`);

  return {
    success: true,
    broadcastId: broadcast.id,
    streamId: keyStream.streamId,
    rtmpUrl: rtmpUrl,
    streamKey: streamKey
  };
}

async function deleteYouTubeBroadcast(streamId) {
  try {
    loggedAlreadyHasBroadcast.delete(streamId);

    const stream = await Stream.findById(streamId);
    if (!stream || !stream.is_youtube_api || !stream.youtube_broadcast_id) {
      return { success: true, message: 'No YouTube broadcast to clean up' };
    }

    // Best-effort: tell YouTube the broadcast is actually done instead of just
    // abandoning it. A broadcast that never received real RTMP data (e.g. this
    // stream got killed within seconds of starting) never auto-transitions out
    // of "ready"/"testing" on its own, and a key stream that keeps getting bound
    // to broadcasts that are never cleanly closed out is exactly the kind of
    // thing that leaves its ingestion state looking stale in YouTube Studio.
    try {
      const { youtube } = await getYouTubeClientForStream(stream);
      const currentResp = await youtube.liveBroadcasts.list({
        part: 'id,status',
        id: stream.youtube_broadcast_id
      });
      const current = currentResp.data.items?.[0];
      const lifeCycleStatus = current?.status?.lifeCycleStatus || null;
      if (current && !['complete', 'revoked'].includes(lifeCycleStatus)) {
        await youtube.liveBroadcasts.transition({
          broadcastStatus: 'complete',
          id: stream.youtube_broadcast_id,
          part: 'id,status'
        });
        console.log(`[YouTubeService] Transitioned broadcast ${stream.youtube_broadcast_id} to complete`);
      }
    } catch (transitionError) {
      console.log(`Note: Could not transition broadcast ${stream.youtube_broadcast_id} to complete: ${transitionError.message}`);
    }

    await Stream.update(streamId, {
      rtmp_url: '',
      stream_key: ''
    });

    console.log(`[YouTubeService] Cleared RTMP credentials for stream ${streamId} (broadcast ID kept for YouTube Studio access)`);

    return { success: true };
  } catch (error) {
    console.error('[YouTubeService] Error clearing YouTube broadcast data:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Flips contentDetails.enableAutoStop on a live broadcast without touching anything
 * else on it (title, monetization, binding, ...). Used by the scheduler to turn
 * YouTube's own auto-stop back on once a scheduled stream is within
 * AUTO_STOP_LEAD_MS of its End Time. Best-effort: failures are logged and returned,
 * never thrown, since this runs from a background poll with no one to catch it.
 */
async function updateBroadcastAutoStop(streamId, enableAutoStop, baseUrl) {
  try {
    const stream = await Stream.findById(streamId);
    if (!stream || !stream.is_youtube_api || !stream.youtube_broadcast_id) {
      return { success: true, message: 'No YouTube broadcast to update' };
    }

    const { youtube } = await getYouTubeClientForStream(stream, baseUrl ? `${baseUrl}/auth/youtube/callback` : undefined);

    const currentResp = await youtube.liveBroadcasts.list({
      part: 'id,contentDetails,status',
      id: stream.youtube_broadcast_id
    });
    const currentBroadcast = currentResp.data.items?.[0];
    if (!currentBroadcast) {
      return { success: true, message: 'Broadcast no longer exists' };
    }

    const lifeCycleStatus = currentBroadcast.status?.lifeCycleStatus || null;
    if (['complete', 'revoked'].includes(lifeCycleStatus)) {
      return { success: true, message: `Broadcast already ${lifeCycleStatus}, nothing to update` };
    }

    const currentContentDetails = currentBroadcast.contentDetails || {};
    if (!!currentContentDetails.enableAutoStop === !!enableAutoStop) {
      return { success: true, message: 'Already set', changed: false };
    }

    await youtube.liveBroadcasts.update({
      part: 'id,contentDetails',
      requestBody: {
        id: stream.youtube_broadcast_id,
        contentDetails: {
          ...currentContentDetails,
          enableAutoStop: !!enableAutoStop
        }
      }
    });

    console.log(`[YouTubeService] Broadcast ${stream.youtube_broadcast_id} (stream ${streamId}) auto-stop set to ${!!enableAutoStop}`);
    return { success: true, changed: true };
  } catch (error) {
    try {
      const stream = await Stream.findById(streamId);
      const channel = stream?.youtube_channel_id ? await YoutubeChannel.findById(stream.youtube_channel_id) : null;
      await handleYouTubeAuthError(channel, error);
    } catch (e) { /* ignore */ }
    console.warn(`[YouTubeService] Could not update auto-stop for stream ${streamId}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

module.exports = {
  createYouTubeBroadcast,
  deleteYouTubeBroadcast,
  updateBroadcastAutoStop,
  computeAutoStopEnabled,
  AUTO_STOP_LEAD_MS,
  getYouTubeOAuth2Client,
  getYouTubeClientForChannel,
  getYouTubeClientForStream,
  getBroadcastMonetization,
  syncBroadcastMonetization,
  handleYouTubeAuthError,
  isInvalidGrantError,
  insertAdBreak,
  applyBroadcastLocalizations,
  resolveKeyStream
};
