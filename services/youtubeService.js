const { google } = require('googleapis');
const { encrypt, decrypt } = require('../utils/encryption');
const User = require('../models/User');
const Stream = require('../models/Stream');
const YoutubeChannel = require('../models/YoutubeChannel');
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

const loggedAlreadyHasBroadcast = new Set();

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

async function createYouTubeBroadcast(streamId, baseUrl) {
  const stream = await Stream.findById(streamId);
  if (!stream) {
    throw new Error('Stream not found');
  }

  if (!stream.is_youtube_api) {
    return { success: true, message: 'Not a YouTube API stream' };
  }

  if (stream.youtube_broadcast_id && stream.rtmp_url && stream.stream_key) {
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
      enableAutoStop: true,
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

  const streamResponse = await youtube.liveStreams.insert({
    part: 'snippet,cdn,contentDetails,status',
    requestBody: {
      snippet: {
        title: `${stream.title} - Stream`
      },
      cdn: {
        frameRate: '30fps',
        ingestionType: 'rtmp',
        resolution: '1080p'
      },
      contentDetails: {
        isReusable: false
      }
    }
  });

  const liveStream = streamResponse.data;
  console.log(`[YouTubeService] Created live stream: ${liveStream.id}`);

  await youtube.liveBroadcasts.bind({
    part: 'id,contentDetails',
    id: broadcast.id,
    streamId: liveStream.id
  });

  const rtmpUrl = liveStream.cdn.ingestionInfo.ingestionAddress;
  const streamKey = liveStream.cdn.ingestionInfo.streamName;

  await Stream.update(streamId, {
    youtube_broadcast_id: broadcast.id,
    youtube_stream_id: liveStream.id,
    rtmp_url: rtmpUrl,
    stream_key: streamKey
  });

  console.log(`[YouTubeService] YouTube broadcast created successfully for stream ${streamId}`);

  return {
    success: true,
    broadcastId: broadcast.id,
    streamId: liveStream.id,
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

module.exports = {
  createYouTubeBroadcast,
  deleteYouTubeBroadcast,
  getYouTubeOAuth2Client,
  getYouTubeClientForChannel,
  getYouTubeClientForStream,
  getBroadcastMonetization,
  syncBroadcastMonetization,
  insertAdBreak,
  applyBroadcastLocalizations
};
