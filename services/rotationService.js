const Rotation = require('../models/Rotation');
const Stream = require('../models/Stream');
const User = require('../models/User');
const streamingService = require('./streamingService');
const { google } = require('googleapis');
const { decrypt } = require('../utils/encryption');
const path = require('path');
const fs = require('fs');
const { buildLocalizedMetadata } = require('./translationService');
const { syncBroadcastMonetization } = require('./youtubeService');
// 🔥 Toggle auto localization from rotation (GLOBAL SWITCH)
const ENABLE_ROTATION_LOCALIZATION = false;

function isInvalidGrantError(error) {
  return (
    error?.response?.data?.error === 'invalid_grant' ||
    error?.message?.includes('invalid_grant') ||
    error?.response?.data?.error_description?.includes('expired or revoked')
  );
}

function getRedirectUri(user) {
  if (user && user.youtube_redirect_uri) {
    return user.youtube_redirect_uri;
  }
  const port = process.env.PORT || 7575;
  return `http://localhost:${port}/auth/youtube/callback`;
}

let checkIntervalId = null;
const activeRotationStreams = new Map();
const loggedAlreadyRunning = new Set();
const loggedScheduleInfo = new Set();

function formatLocalDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}`;
}

function parseLocalDateTime(dateStr) {
  if (!dateStr) return null;
  const str = dateStr.replace('Z', '').split('.')[0];
  const [datePart, timePart] = str.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hours, minutes, seconds] = (timePart || '00:00:00').split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, seconds || 0);
}

function getNextSchedule(rotation, baseDate = null) {
  const originalStart = parseLocalDateTime(rotation.start_time);
  const originalEnd = parseLocalDateTime(rotation.end_time);
  
  const startHours = originalStart.getHours();
  const startMinutes = originalStart.getMinutes();
  const endHours = originalEnd.getHours();
  const endMinutes = originalEnd.getMinutes();
  
  const now = new Date();
  
  let nextStart = new Date(originalStart);
  let nextEnd = new Date(originalEnd);
  
  let daysToAdd = 1;
  switch (rotation.repeat_mode) {
    case 'daily':
      daysToAdd = 1;
      break;
    case 'weekly':
      daysToAdd = 7;
      break;
    case 'monthly':
      nextStart.setMonth(nextStart.getMonth() + 1);
      nextEnd.setMonth(nextEnd.getMonth() + 1);
      while (nextStart <= now) {
        nextStart.setMonth(nextStart.getMonth() + 1);
        nextEnd.setMonth(nextEnd.getMonth() + 1);
      }
      return { start: nextStart, end: nextEnd };
    default:
      daysToAdd = 1;
  }
  
  nextStart.setDate(nextStart.getDate() + daysToAdd);
  nextEnd.setDate(nextEnd.getDate() + daysToAdd);
  
  while (nextStart <= now) {
    nextStart.setDate(nextStart.getDate() + daysToAdd);
    nextEnd.setDate(nextEnd.getDate() + daysToAdd);
  }
  
  return { start: nextStart, end: nextEnd };
}

function init() {
  console.log('[RotationService] Initializing rotation service...');
  checkIntervalId = setInterval(checkRotations, 60 * 1000);
  checkRotations();
}

async function checkRotations() {
  try {
    const activeRotations = await Rotation.findActiveRotations();
    const now = new Date();

    for (const rotation of activeRotations) {
      if (!rotation.start_time || !rotation.end_time) continue;

      const items = await Rotation.getItemsByRotationId(rotation.id);
      if (items.length === 0) continue;

      const currentIndex = rotation.current_index || 0;
      
      if (currentIndex >= items.length) {
        console.log(`[RotationService] All items completed for rotation ${rotation.name}`);
        
        for (const item of items) {
          const streamKey = `${rotation.id}_${item.id}`;
          if (activeRotationStreams.has(streamKey)) {
            await stopRotationStream(rotation, item);
            activeRotationStreams.delete(streamKey);
            loggedAlreadyRunning.delete(streamKey);
          }
        }

        if (rotation.repeat_mode && rotation.repeat_mode !== 'none') {
          const nextSchedule = getNextSchedule(rotation);
          
          await Rotation.update(rotation.id, { 
            current_index: 0,
            start_time: formatLocalDateTime(nextSchedule.start),
            end_time: formatLocalDateTime(nextSchedule.end)
          });
          console.log(`[RotationService] Rotation ${rotation.name} rescheduled for ${formatLocalDateTime(nextSchedule.start)}`);
        } else {
          await Rotation.update(rotation.id, { status: 'completed' });
          console.log(`[RotationService] Rotation ${rotation.name} completed`);
        }
        continue;
      }

      const scheduledStart = parseLocalDateTime(rotation.start_time);
      const scheduledEnd = parseLocalDateTime(rotation.end_time);

      if (now < scheduledStart) {
        if (!loggedScheduleInfo.has(`notstarted_${rotation.id}`)) {
          console.log(`[RotationService] Rotation ${rotation.name} not yet started (starts at ${scheduledStart.toLocaleString()})`);
          loggedScheduleInfo.add(`notstarted_${rotation.id}`);
        }
        continue;
      }

      loggedScheduleInfo.delete(`notstarted_${rotation.id}`);

      if (now >= scheduledEnd) {
        console.log(`[RotationService] Rotation ${rotation.name} time window has ended`);
        
        const currentItem = items[currentIndex];
        if (currentItem) {
          const streamKey = `${rotation.id}_${currentItem.id}`;
          if (activeRotationStreams.has(streamKey)) {
            await stopRotationStream(rotation, currentItem);
            activeRotationStreams.delete(streamKey);
            loggedAlreadyRunning.delete(streamKey);
          }
        }

        const nextIndex = currentIndex + 1;
        
        if (nextIndex >= items.length) {
          if (rotation.repeat_mode && rotation.repeat_mode !== 'none') {
            const nextSchedule = getNextSchedule(rotation);
            
            await Rotation.update(rotation.id, { 
              current_index: 0,
              start_time: formatLocalDateTime(nextSchedule.start),
              end_time: formatLocalDateTime(nextSchedule.end)
            });
            console.log(`[RotationService] All items completed. Rotation ${rotation.name} rescheduled for ${formatLocalDateTime(nextSchedule.start)}`);
          } else {
            await Rotation.update(rotation.id, { status: 'completed' });
            console.log(`[RotationService] All items completed. Rotation ${rotation.name} marked as completed`);
          }
        } else {
          const nextSchedule = getNextSchedule(rotation);
          
          await Rotation.update(rotation.id, { 
            current_index: nextIndex,
            start_time: formatLocalDateTime(nextSchedule.start),
            end_time: formatLocalDateTime(nextSchedule.end)
          });
          console.log(`[RotationService] Moving to next item (${nextIndex + 1}/${items.length}). Rotation ${rotation.name} rescheduled for ${formatLocalDateTime(nextSchedule.start)}`);
        }
        continue;
      }

      const currentItem = items[currentIndex];
      if (!currentItem) continue;

      const streamKey = `${rotation.id}_${currentItem.id}`;

      if (!activeRotationStreams.has(streamKey)) {
        const expiredLogKey = `expired_${rotation.id}`;

        const result = await startRotationStream(rotation, currentItem);

        if (result.success) {
          console.log(`[RotationService] Starting rotation item ${currentIndex + 1}/${items.length}: ${currentItem.title}`);

          activeRotationStreams.set(streamKey, {
            rotationId: rotation.id,
            itemId: currentItem.id,
            streamId: result.streamId
          });

          loggedAlreadyRunning.delete(streamKey);
          loggedScheduleInfo.delete(expiredLogKey);

        } else if (result.error === 'YouTube channel token expired. Please reconnect this channel.') {
          if (!loggedScheduleInfo.has(expiredLogKey)) {
            console.log(`[RotationService] Rotation ${rotation.name} skipped because selected channel token is expired`);
            loggedScheduleInfo.add(expiredLogKey);
          }
        } else {
          // error lain tetap boleh muncul sekali-sekali
          console.error(`[RotationService] Failed to start rotation item ${currentIndex + 1}/${items.length}: ${currentItem.title} → ${result.error}`);
        }

      } else {
        if (!loggedAlreadyRunning.has(streamKey)) {
          console.log(`[RotationService] Rotation item ${currentIndex + 1}/${items.length} already running: ${currentItem.title}`);
          loggedAlreadyRunning.add(streamKey);
        }
      }
    }
  } catch (error) {
    console.error('[RotationService] Error checking rotations:', error);
  }
}

async function startRotationStream(rotation, item) {
    let selectedChannel = null;
    let user = null;

  try {
    const user = await User.findById(rotation.user_id);
    if (!user) {
      console.error('[RotationService] User not found');
      return { success: false, error: 'User not found' };
    }

    const YoutubeChannel = require('../models/YoutubeChannel');
    
    if (rotation.youtube_channel_id) {
      selectedChannel = await YoutubeChannel.findById(rotation.youtube_channel_id);
    }
    
    if (!selectedChannel) {
      selectedChannel = await YoutubeChannel.findDefault(rotation.user_id);
    }
    
    if (!selectedChannel) {
      const channels = await YoutubeChannel.findAll(rotation.user_id);
      selectedChannel = channels[0];
    }

    if (!selectedChannel || !selectedChannel.access_token) {
      console.error('[RotationService] YouTube not connected');
      return { success: false, error: 'YouTube not connected' };
    }

if (selectedChannel.auth_status === 'expired') {
  console.error(`[RotationService] Channel ${selectedChannel.channel_name} token expired. Reconnect required.`);
  return { success: false, error: 'YouTube channel token expired. Please reconnect this channel.' };
}

    const oauth2Client = new google.auth.OAuth2(
      user.youtube_client_id,
      decrypt(user.youtube_client_secret),
      getRedirectUri(user)
    );

    oauth2Client.setCredentials({
      access_token: decrypt(selectedChannel.access_token),
      refresh_token: decrypt(selectedChannel.refresh_token)
    });

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

      const existingStreams = await Stream.findAll(rotation.user_id);

      const matchedStreams = existingStreams.filter(s =>
        s.youtube_stream_id === rotation.youtube_stream_id &&
        s.title === item.title
      );

      const existingRotationStream =
        matchedStreams.length > 0 ? matchedStreams[matchedStreams.length - 1] : null;

      if (existingRotationStream) {
        console.log(
          `[RotationService] Rotation ${rotation.name} already has stream: ${existingRotationStream.id}`
        );

        try {
          const isAlreadyRunning = streamingService.isStreamActive(existingRotationStream.id);

          if (!isAlreadyRunning) {
            console.log(
              `[RotationService] Restarting existing stream for rotation ${rotation.name}: ${existingRotationStream.id}`
            );

            await streamingService.startStream(existingRotationStream.id);
          } else {
            console.log(
              `[RotationService] Existing stream already running for rotation ${rotation.name}: ${existingRotationStream.id}`
            );
          }
        } catch (restartError) {
          console.error(
            `[RotationService] Failed to restart existing stream ${existingRotationStream.id}:`,
            restartError.message
          );

 try {
            if (isInvalidGrantError(restartError) && selectedChannel?.id) {
              const YoutubeChannel = require('../models/YoutubeChannel');

              await YoutubeChannel.update(selectedChannel.id, {
                auth_status: 'expired',
                auth_error: 'Token expired or revoked'
              });

              console.error(`[YouTube] Channel ${selectedChannel.channel_name} marked as expired`);
            }
          } catch (markErr) {
            console.error('[YouTube] Failed to mark channel expired:', markErr.message);
          }

          return {
            success: false,
            error: restartError.message
          };
        }

        return {
          success: true,
          streamId: existingRotationStream.id,
          broadcastId: existingRotationStream.youtube_broadcast_id
        };
      }

const scheduledStartTime = new Date().toISOString();

const broadcastResponse = await youtube.liveBroadcasts.insert({
  part: ['snippet', 'status', 'contentDetails'],
  requestBody: {
    snippet: {
      title: item.title,
      description: item.description || '',
      scheduledStartTime: scheduledStartTime
    },
    status: {
      privacyStatus: item.privacy || 'unlisted',
      selfDeclaredMadeForKids: false
    },
    contentDetails: {
      enableAutoStart: true,
      enableAutoStop: true,
      latencyPreference: 'normal'
    }
  }
});

const broadcast = broadcastResponse.data;

try {
  const YoutubeChannel = require('../models/YoutubeChannel');
  await YoutubeChannel.update(selectedChannel.id, {
    auth_status: 'connected',
    auth_error: null
  });
} catch (markOkErr) {
  console.error('[YouTube] Failed to mark channel connected:', markOkErr.message);
}

let localizations = {};
let sourceLanguage = selectedChannel.source_language || 'en';

if (ENABLE_ROTATION_LOCALIZATION) {
  try {
    const targetLanguages = selectedChannel.localizations
      ? JSON.parse(selectedChannel.localizations)
      : [];
    const maxTitleLength = selectedChannel.max_title_length || 100;

    console.log('[AI] Source language:', sourceLanguage);
    console.log('[AI] Targets:', targetLanguages);
    console.log('[AI] Max title length:', maxTitleLength);

    for (const lang of targetLanguages) {
      try {
        console.log(`[AI] Translating to ${lang}...`);

        await new Promise(resolve => setTimeout(resolve, 3000));

        const result = await buildLocalizedMetadata({
          title: item.title,
          description: item.description || '',
          sourceLanguage,
          targetLanguages: [lang],
          maxTitleLength,
          user
        });

        if (result && result[lang]) {
          localizations[lang] = result[lang];
          console.log(`[AI] Success: ${lang}`);
        } else {
          console.log(`[AI] Empty result for ${lang}`);
        }
      } catch (langError) {
        console.error(`[AI] Failed for ${lang}:`, langError.message);
      }
    }

    if (!Object.keys(localizations).length) {
      console.log('[AI] Skip localization (empty result)');
    } else {
      console.log('[AI] Localization count:', Object.keys(localizations).length);
    }

  } catch (locError) {
    console.error('[AI] Error building localizations:', locError.message);
  }
} else {
  console.log('[Rotation] Auto localization disabled');
}

    let monetizationEnabled = item.youtube_monetization === true || item.youtube_monetization === 1;
    if (monetizationEnabled) {
      try {
        await syncBroadcastMonetization(youtube, broadcast.id, true);
      } catch (monetizationError) {
        monetizationEnabled = false;
        console.warn(`[RotationService] Failed to enable monetization for broadcast ${broadcast.id}. Continuing without monetization. Error: ${monetizationError.message}`);
      }
    }

    let liveStream;
    let rtmpUrl;
    let streamKey;

    if (rotation.youtube_stream_id) {
      try {
        const existingStreamResponse = await youtube.liveStreams.list({
          part: ['id', 'snippet', 'cdn', 'status'],
          id: [rotation.youtube_stream_id]
        });

        if (existingStreamResponse.data.items && existingStreamResponse.data.items.length > 0) {
          liveStream = existingStreamResponse.data.items[0];
          rtmpUrl = liveStream.cdn.ingestionInfo.ingestionAddress;
          streamKey = liveStream.cdn.ingestionInfo.streamName;
          console.log(`[RotationService] Reusing existing YouTube stream for rotation ${rotation.name}: ${liveStream.id}`);
        }
      } catch (err) {
        console.warn(`[RotationService] Failed to load existing YouTube stream ${rotation.youtube_stream_id}: ${err.message}`);
      }
    }

    if (!liveStream) {
      const streamResponse = await youtube.liveStreams.insert({
        part: ['snippet', 'cdn'],
        requestBody: {
          snippet: {
            title: rotation.name
          },
          cdn: {
            frameRate: '30fps',
            ingestionType: 'rtmp',
            resolution: '1080p'
          }
        }
      });

      liveStream = streamResponse.data;
      rtmpUrl = liveStream.cdn.ingestionInfo.ingestionAddress;
      streamKey = liveStream.cdn.ingestionInfo.streamName;

      await Rotation.update(rotation.id, {
        youtube_stream_id: liveStream.id,
        youtube_stream_key: streamKey,
        youtube_rtmp_url: rtmpUrl
      });

      console.log(`[RotationService] Created new YouTube stream for rotation ${rotation.name}: ${liveStream.id}`);
    }

    await youtube.liveBroadcasts.bind({
      part: ['id', 'contentDetails'],
      id: broadcast.id,
      streamId: liveStream.id
    });

// ✅ APPLY LOCALIZATIONS (POSISI PALING BENAR)
if (ENABLE_ROTATION_LOCALIZATION && Object.keys(localizations).length > 0) {
  try {
    await youtube.videos.update({
      part: ['localizations'],
      requestBody: {
        id: broadcast.id,
        localizations: localizations
      }
    });

    console.log(`[RotationService] Applied localizations to broadcast ${broadcast.id}`);
  } catch (err) {
    console.error('[RotationService] Error applying localizations:', err.message);
  }
} else if (ENABLE_ROTATION_LOCALIZATION) {
  console.log('[AI] No localizations to apply');
}

    const thumbnailToUpload = item.original_thumbnail_path || item.thumbnail_path;
    if (thumbnailToUpload) {
      try {
        const thumbnailPath = path.join(__dirname, '..', 'public', 'uploads', 'thumbnails', thumbnailToUpload);
        if (fs.existsSync(thumbnailPath)) {
          await youtube.thumbnails.set({
            videoId: broadcast.id,
            media: {
              mimeType: 'image/jpeg',
              body: fs.createReadStream(thumbnailPath)
            }
          });
        }
      } catch (thumbError) {
        console.error('[RotationService] Error setting thumbnail:', thumbError.message);
      }
    }

    const tags = item.tags ? item.tags.split(',').map(t => t.trim()).filter(t => t) : [];

      try {
        await youtube.videos.update({
          part: ['snippet'],
          requestBody: {
            id: broadcast.id,
            snippet: {
              title: item.title,
              description: item.description || '',
              categoryId: item.category || '22',
              tags: tags,
              defaultLanguage: sourceLanguage
            }
          }
        });
      } catch (updateError) {
        console.error('[RotationService] Error updating video metadata:', updateError.message);
      }

      if (Object.keys(localizations).length > 0) {
        try {
          await youtube.videos.update({
            part: ['localizations'],
            requestBody: {
              id: broadcast.id,
              localizations: localizations
            }
          });

          console.log(`[RotationService] Applied localizations to broadcast ${broadcast.id}`);
        } catch (locUpdateError) {
          console.error('[RotationService] Error applying localizations:', locUpdateError.message);
        }
      }

    let actualVideoId = item.video_id;
    if (item.video_id && item.video_id.startsWith('playlist:')) {
      actualVideoId = item.video_id.substring(9);
    }

    const stream = await Stream.create({
      title: item.title,
      video_id: actualVideoId,
      rtmp_url: rtmpUrl,
      stream_key: streamKey,
      platform: 'YouTube',
      platform_icon: 'brand-youtube',
      loop_video: true,
      use_advanced_settings: false,
      status: 'scheduled',
      user_id: rotation.user_id,
      youtube_broadcast_id: broadcast.id,
      youtube_stream_id: liveStream.id,
      youtube_description: item.description,
      youtube_privacy: item.privacy,
      youtube_category: item.category,
      youtube_tags: item.tags,
      youtube_monetization: monetizationEnabled,
      youtube_channel_id: selectedChannel.id,
      is_youtube_api: true,
      schedule_time: rotation.start_time,
      end_time: rotation.end_time
    });

    await streamingService.startStream(stream.id);

    return { success: true, streamId: stream.id, broadcastId: broadcast.id };
  } catch (error) {
    console.error('[RotationService] Error starting rotation stream:', error);


try {
    if (isInvalidGrantError(error) && selectedChannel?.id) {
      const YoutubeChannel = require('../models/YoutubeChannel');

      await YoutubeChannel.update(selectedChannel.id, {
        auth_status: 'expired',
        auth_error: 'Token expired or revoked'
      });

      console.error(`[YouTube] Channel ${selectedChannel.channel_name} marked as expired`);
    }
  } catch (markErr) {
    console.error('[YouTube] Failed to mark channel expired:', markErr.message);
  }

    return { success: false, error: error.message };
  }
}

async function stopRotationStream(rotation, item) {
  try {
    const user = await User.findById(rotation.user_id);
    if (!user) return { success: false, error: 'User not found' };

    let actualVideoId = item.video_id;
    if (item.video_id && item.video_id.startsWith('playlist:')) {
      actualVideoId = item.video_id.substring(9);
    }

const streams = await Stream.findAll(rotation.user_id);

let rotationStream = null;

// 1. paling akurat: cari berdasarkan broadcast rotation
if (rotation.youtube_broadcast_id) {
  rotationStream = streams.find(s =>
    s.youtube_broadcast_id === rotation.youtube_broadcast_id
  );
}

// 2. fallback: cari berdasarkan persistent youtube stream milik rotation
if (!rotationStream && rotation.youtube_stream_id) {
  const matchedStreams = streams.filter(s =>
    s.youtube_stream_id === rotation.youtube_stream_id
  );

  if (matchedStreams.length > 0) {
    rotationStream = matchedStreams[matchedStreams.length - 1];
  }
}

// 3. fallback terakhir: video + title
if (!rotationStream) {
  const matchedStreams = streams.filter(s =>
    s.video_id === actualVideoId &&
    s.title === item.title
  );

  if (matchedStreams.length > 0) {
    rotationStream = matchedStreams[matchedStreams.length - 1];
  }
}

    if (rotationStream) {
      await streamingService.stopStream(rotationStream.id);
      // hapus record stream hasil rotation
      await Stream.delete(rotationStream.id, rotation.user_id);
      if (rotationStream.youtube_broadcast_id) {
        try {
          const YoutubeChannel = require('../models/YoutubeChannel');
          let selectedChannel = null;
          
          if (rotationStream.youtube_channel_id) {
            selectedChannel = await YoutubeChannel.findById(rotationStream.youtube_channel_id);
          }
          
          if (!selectedChannel) {
            selectedChannel = await YoutubeChannel.findDefault(user.id);
          }
          
          if (!selectedChannel) {
            const channels = await YoutubeChannel.findAll(user.id);
            selectedChannel = channels[0];
          }

          if (selectedChannel && selectedChannel.access_token) {
            const oauth2Client = new google.auth.OAuth2(
              user.youtube_client_id,
              decrypt(user.youtube_client_secret),
              getRedirectUri(user)
            );

            oauth2Client.setCredentials({
              access_token: decrypt(selectedChannel.access_token),
              refresh_token: decrypt(selectedChannel.refresh_token)
            });

            const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

            await youtube.liveBroadcasts.transition({
              part: ['status'],
              id: rotationStream.youtube_broadcast_id,
              broadcastStatus: 'complete'
            });
          }
        } catch (ytError) {
          console.error('[RotationService] Error completing YouTube broadcast:', ytError.message);
        }
      }
    }

    await applyPendingRotationChanges(rotation.id);

    return { success: true };
  } catch (error) {
    console.error('[RotationService] Error stopping rotation stream:', error);
    return { success: false, error: error.message };
  }
}

async function applyPendingRotationChanges(rotationId) {
  try {
    const pendingPath = path.join(__dirname, '..', 'pending_rotations', `${rotationId}.json`);

    if (!fs.existsSync(pendingPath)) {
      return;
    }

    const raw = fs.readFileSync(pendingPath, 'utf8');
    const pendingData = JSON.parse(raw);

    if (!pendingData || !Array.isArray(pendingData.items)) {
      console.warn(`[RotationService] Pending file invalid for rotation ${rotationId}`);
      return;
    }

    console.log(`[RotationService] Applying pending changes for rotation ${rotationId}`);

    const existingItems = await Rotation.getItemsByRotationId(rotationId);
    for (const item of existingItems) {
      await Rotation.deleteItem(item.id);
    }

    for (const item of pendingData.items) {
      await Rotation.addItem({
        rotation_id: rotationId,
        order_index: item.order_index,
        video_id: item.video_id,
        title: item.title,
        description: item.description || '',
        tags: item.tags || '',
        thumbnail_path: item.thumbnail_path || null,
        original_thumbnail_path: item.original_thumbnail_path || null,
        privacy: item.privacy || 'unlisted',
        category: item.category || '22',
        youtube_monetization: item.youtube_monetization === true || item.youtube_monetization === 'true'
      });
    }

    fs.unlinkSync(pendingPath);
    console.log(`[RotationService] Pending changes applied for rotation ${rotationId}`);
  } catch (error) {
    console.error(`[RotationService] Error applying pending changes for rotation ${rotationId}:`, error.message);
  }
}

async function activateRotation(rotationId) {
  try {
    const rotation = await Rotation.findById(rotationId);
    if (!rotation) {
      return { success: false, error: 'Rotation not found' };
    }

    const now = new Date();
    const originalStart = parseLocalDateTime(rotation.start_time);
    const originalEnd = parseLocalDateTime(rotation.end_time);
    
    let nextStart = new Date(now);
    let nextEnd = new Date(now);
    
    nextStart.setHours(originalStart.getHours(), originalStart.getMinutes(), 0, 0);
    nextEnd.setHours(originalEnd.getHours(), originalEnd.getMinutes(), 0, 0);
    
    if (nextEnd <= nextStart) {
      nextEnd.setDate(nextEnd.getDate() + 1);
    }
    
    if (now >= nextStart) {
      nextStart.setDate(nextStart.getDate() + 1);
      nextEnd.setDate(nextEnd.getDate() + 1);
    }
    
    const updateData = {
      status: 'active',
      current_index: 0,
      start_time: formatLocalDateTime(nextStart),
      end_time: formatLocalDateTime(nextEnd)
    };
    
    console.log(`[RotationService] Activating rotation ${rotationId} for ${formatLocalDateTime(nextStart)} - ${formatLocalDateTime(nextEnd)}`);

    await Rotation.update(rotationId, updateData);
    return { success: true };
  } catch (error) {
    console.error('[RotationService] Error activating rotation:', error);
    return { success: false, error: error.message };
  }
}

async function pauseRotation(rotationId) {
  try {
    const rotation = await Rotation.findByIdWithItems(rotationId);
    if (!rotation) return { success: false, error: 'Rotation not found' };

    for (const item of rotation.items) {
      const streamKey = `${rotationId}_${item.id}`;
      if (activeRotationStreams.has(streamKey)) {
        await stopRotationStream(rotation, item);
        activeRotationStreams.delete(streamKey);
        loggedAlreadyRunning.delete(streamKey);
      }
    }

    await Rotation.update(rotationId, { status: 'paused' });
    return { success: true };
  } catch (error) {
    console.error('[RotationService] Error pausing rotation:', error);
    return { success: false, error: error.message };
  }
}

async function stopRotation(rotationId) {
  try {
    const rotation = await Rotation.findByIdWithItems(rotationId);
    if (!rotation) return { success: false, error: 'Rotation not found' };

    for (const item of rotation.items) {
      const streamKey = `${rotationId}_${item.id}`;
      if (activeRotationStreams.has(streamKey)) {
        await stopRotationStream(rotation, item);
        activeRotationStreams.delete(streamKey);
        loggedAlreadyRunning.delete(streamKey);
      }
    }

    await Rotation.update(rotationId, { status: 'inactive', current_index: 0 });
    return { success: true };
  } catch (error) {
    console.error('[RotationService] Error stopping rotation:', error);
    return { success: false, error: error.message };
  }
}

function shutdown() {
  console.log('[RotationService] Shutting down rotation service...');
  if (checkIntervalId) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
  }
  
  for (const [streamKey, streamInfo] of activeRotationStreams) {
    console.log(`[RotationService] Stopping active rotation stream: ${streamKey}`);
    stopRotationStream({ id: streamInfo.rotationId }, { id: streamInfo.itemId }).catch(err => {
      console.error(`[RotationService] Error stopping stream ${streamKey} during shutdown:`, err);
    });
  }
  activeRotationStreams.clear();
}

module.exports = {
  init,
  shutdown,
  checkRotations,
  startRotationStream,
  stopRotationStream,
  activateRotation,
  pauseRotation,
  stopRotation
};
