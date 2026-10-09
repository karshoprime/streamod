// H.265/HEVC support for looped codec-copy streaming.
//
//  - Resolves which ffmpeg/ffprobe binary the app uses and what it can do.
//    HEVC over RTMP/FLV needs "Enhanced RTMP", which FFmpeg only gained in 6.1.
//  - Probes uploaded videos (codec + keyframe interval) and stores the result.
//  - Runs "Optimize for loop": a one-off background re-encode to H.265 with a
//    fixed 2 second closed GOP, so the file can be looped in codec-copy mode
//    without glitches at the loop seam.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

const QUALITY_PRESETS = {
  high: { crf: 20, label: 'High quality' },
  balanced: { crf: 23, label: 'Balanced' },
  small: { crf: 26, label: 'Smallest file' }
};
const KEYFRAME_SECONDS = 2;
const KEYFRAME_SCAN_SECONDS = 60;
// YouTube asks for a keyframe every 2s and rejects anything above 4s.
const MAX_GOP_SECONDS = 4;
const FINISHED_JOB_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Binaries
// ---------------------------------------------------------------------------

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

let cachedFfmpegPath = null;
// FFMPEG_PATH (.env) wins, then a manually installed build in /usr/local/bin
// (see scripts/install-ffmpeg-static.sh), then the distro package, then the
// bundled npm binary.
function getFfmpegPath() {
  if (cachedFfmpegPath) return cachedFfmpegPath;
  let bundled = null;
  try { bundled = require('@ffmpeg-installer/ffmpeg').path; } catch (e) {}
  cachedFfmpegPath = firstExisting([
    process.env.FFMPEG_PATH,
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    bundled
  ]) || 'ffmpeg';
  return cachedFfmpegPath;
}

let cachedFfprobePath = null;
function getFfprobePath() {
  if (cachedFfprobePath) return cachedFfprobePath;
  let bundled = null;
  try { bundled = require('@ffprobe-installer/ffprobe').path; } catch (e) {}
  const ffmpegPath = getFfmpegPath();
  const sibling = path.isAbsolute(ffmpegPath)
    ? path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : null;
  cachedFfprobePath = firstExisting([
    process.env.FFPROBE_PATH,
    sibling,
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
    bundled
  ]) || 'ffprobe';
  return cachedFfprobePath;
}

function run(bin, args, { timeout = 30000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// Git master builds are versioned by commit count ("N-118345-g..."), not by
// release number. FFmpeg 6.1 branched off a little above N-112000; the npm
// bundled binary, for comparison, is N-47683 (2018).
const GIT_BUILD_MIN_FOR_HEVC_RTMP = 112500;

// "6.1.1-3ubuntu5", "7.0.2-static", "n8.1.3-14-gabc", "4.4.2-0ubuntu0.22.04.1",
// or "N-118345-gdeadbeef" for git master builds.
function parseFfmpegVersion(versionOutput) {
  const match = /ffmpeg version (\S+)/.exec(versionOutput || '');
  const raw = match ? match[1] : '';
  const numbers = /^n?(\d+)\.(\d+)/.exec(raw);
  if (numbers) {
    return { raw, major: parseInt(numbers[1], 10), minor: parseInt(numbers[2], 10), gitBuild: null };
  }
  const git = /^N-(\d+)/.exec(raw);
  return { raw, major: null, minor: null, gitBuild: git ? parseInt(git[1], 10) : null };
}

function versionSupportsHevcRtmp(version) {
  if (!version) return false;
  if (version.gitBuild !== null) return version.gitBuild >= GIT_BUILD_MIN_FOR_HEVC_RTMP;
  if (version.major === null) return false;
  return version.major > 6 || (version.major === 6 && version.minor >= 1);
}

let ffmpegInfoPromise = null;
function getFfmpegInfo() {
  if (!ffmpegInfoPromise) {
    ffmpegInfoPromise = (async () => {
      const ffmpegPath = getFfmpegPath();
      const info = {
        path: ffmpegPath,
        version: null,
        hevcRtmp: false,
        hasLibx265: false,
        error: null
      };
      try {
        const version = parseFfmpegVersion(await run(ffmpegPath, ['-hide_banner', '-version']));
        info.version = version.raw || null;
        info.hevcRtmp = versionSupportsHevcRtmp(version);
        const encoders = await run(ffmpegPath, ['-hide_banner', '-encoders']);
        info.hasLibx265 = /\blibx265\b/.test(encoders);
      } catch (err) {
        info.error = err.message;
      }
      return info;
    })();
  }
  return ffmpegInfoPromise;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

function parseRational(value) {
  if (!value || typeof value !== 'string') return null;
  const [num, den] = value.split('/').map(Number);
  if (!Number.isFinite(num)) return null;
  if (den === undefined) return num;
  if (!Number.isFinite(den) || den === 0) return null;
  return num / den;
}

function isAudioOnlyPath(filepath) {
  const lower = String(filepath || '').toLowerCase();
  return lower.includes('/audio/') || /\.(m4a|aac|mp3|wav|flac|ogg)$/.test(lower);
}

function resolveMediaPath(relativePath) {
  const rel = String(relativePath || '').replace(/^\/+/, '');
  return path.join(PUBLIC_DIR, rel);
}

// Largest gap between two consecutive keyframes in the first minute. Reads
// packet flags only, so nothing is decoded and it stays fast on big files.
async function probeGopSeconds(filePath, duration) {
  const out = await run(getFfprobePath(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags',
    '-of', 'csv=p=0',
    '-read_intervals', `%+${KEYFRAME_SCAN_SECONDS}`,
    filePath
  ], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 });

  const keyframes = [];
  let lastPts = 0;
  for (const line of out.split('\n')) {
    const [ptsText, flags] = line.trim().split(',');
    const pts = parseFloat(ptsText);
    if (!Number.isFinite(pts)) continue;
    if (pts > lastPts) lastPts = pts;
    if (flags && flags.includes('K')) keyframes.push(pts);
  }
  if (keyframes.length === 0) return null;
  keyframes.sort((a, b) => a - b);

  let maxGap = 0;
  for (let i = 1; i < keyframes.length; i++) {
    maxGap = Math.max(maxGap, keyframes[i] - keyframes[i - 1]);
  }
  // Also count the run after the last keyframe we saw (covers files with a
  // single keyframe, or one that stops emitting them).
  const scannedEnd = Math.min(Number(duration) || lastPts, lastPts);
  maxGap = Math.max(maxGap, scannedEnd - keyframes[keyframes.length - 1]);
  return Math.round(maxGap * 100) / 100;
}

async function probeVideo(filePath, { withGop = true } = {}) {
  const out = await run(getFfprobePath(), [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ]);
  const data = JSON.parse(out);
  const streams = data.streams || [];
  const video = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.find(s => s.codec_type === 'audio');
  const duration = parseFloat((data.format || {}).duration) || 0;

  const result = {
    videoCodec: video ? video.codec_name : null,
    audioCodec: audio ? audio.codec_name : null,
    profile: video ? video.profile || null : null,
    pixFmt: video ? video.pix_fmt || null : null,
    hasBFrames: video ? Number(video.has_b_frames || 0) : 0,
    width: video ? video.width : null,
    height: video ? video.height : null,
    frameRate: video ? (video.avg_frame_rate && video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : video.r_frame_rate) : null,
    fps: null,
    duration,
    bitrate: (data.format || {}).bit_rate ? Math.round(parseInt(data.format.bit_rate, 10) / 1000) : null,
    format: (data.format || {}).format_name || '',
    gopSeconds: null
  };
  result.fps = parseRational(result.frameRate);

  if (withGop && video) {
    try {
      result.gopSeconds = await probeGopSeconds(filePath, duration);
    } catch (e) {
      // Keyframe scan is best-effort; codec info is still useful without it.
    }
  }
  return result;
}

// Codec lookups at stream start, cached per file version.
const codecCache = new Map();
async function getVideoCodec(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (e) { return null; }
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  if (codecCache.has(key)) return codecCache.get(key);
  let codec = null;
  try {
    codec = (await probeVideo(filePath, { withGop: false })).videoCodec;
  } catch (e) {
    return null; // don't cache failures
  }
  if (codecCache.size > 500) codecCache.clear();
  codecCache.set(key, codec);
  return codec;
}

const analyzing = new Set();
async function analyzeAndStore(videoId) {
  if (!videoId || analyzing.has(videoId)) return null;
  analyzing.add(videoId);
  try {
    const Video = require('../models/Video');
    const video = await Video.findById(videoId);
    if (!video || isAudioOnlyPath(video.filepath)) return null;
    const fullPath = resolveMediaPath(video.filepath);
    if (!fs.existsSync(fullPath)) return null;

    let info;
    try {
      info = await probeVideo(fullPath);
    } catch (err) {
      // Mark as analyzed so a broken file isn't re-probed on every page load.
      await Video.update(videoId, { video_codec: 'unknown' });
      return null;
    }
    await Video.update(videoId, {
      video_codec: info.videoCodec || 'unknown',
      gop_seconds: info.gopSeconds
    });
    return info;
  } catch (err) {
    console.error('[Codec] Failed to analyze video', videoId, err.message);
    return null;
  } finally {
    analyzing.delete(videoId);
  }
}

// Fill in codec info for videos uploaded before this feature existed. Runs one
// at a time in the background so the gallery never waits on ffprobe.
const backfillQueue = [];
let backfillRunning = false;
function backfillMissing(videos) {
  for (const video of videos || []) {
    if (!video || video.video_codec || isAudioOnlyPath(video.filepath)) continue;
    if (backfillQueue.includes(video.id) || analyzing.has(video.id)) continue;
    backfillQueue.push(video.id);
  }
  if (backfillRunning) return;
  backfillRunning = true;
  (async () => {
    while (backfillQueue.length > 0) {
      await analyzeAndStore(backfillQueue.shift());
    }
    backfillRunning = false;
  })();
}

// ---------------------------------------------------------------------------
// Stream-start check (codec-copy mode)
// ---------------------------------------------------------------------------

// Throws with an actionable message when the installed FFmpeg can't push this
// source in codec-copy mode. Without this, FFmpeg exits immediately and the
// stream just burns through its retries.
async function assertCopyModeSupported(filePaths) {
  const codecs = [];
  for (const filePath of filePaths) {
    codecs.push(await getVideoCodec(filePath));
  }
  const known = codecs.filter(Boolean);
  const hasHevc = known.includes('hevc');
  const distinct = [...new Set(known)];

  if (distinct.length > 1) {
    throw new Error(
      `Playlist mixes video codecs (${distinct.join(', ')}). Codec-copy mode needs every video in the same codec - ` +
      'convert them with "Optimize for loop" in the Gallery, or enable Advanced Settings to re-encode.'
    );
  }

  if (hasHevc) {
    const info = await getFfmpegInfo();
    if (!info.hevcRtmp) {
      throw new Error(
        `This video is H.265/HEVC, which needs FFmpeg 6.1 or newer to stream over RTMP ` +
        `(installed: ${info.version || 'unknown'} at ${info.path}). Upgrade FFmpeg ` +
        '(scripts/install-ffmpeg-static.sh) or enable Advanced Settings to re-encode to H.264.'
      );
    }
  }
  return { hasHevc, codec: distinct[0] || null };
}

// ---------------------------------------------------------------------------
// "Optimize for loop" jobs
// ---------------------------------------------------------------------------

const jobs = new Map(); // videoId -> job
const jobQueue = [];
let activeJob = null;

function publicJob(job) {
  return {
    id: job.id,
    videoId: job.videoId,
    title: job.title,
    quality: job.quality,
    status: job.status,
    percent: job.percent,
    error: job.error,
    outputVideoId: job.outputVideoId,
    createdAt: job.createdAt
  };
}

function getJobsForUser(userId) {
  const now = Date.now();
  for (const [videoId, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > FINISHED_JOB_TTL_MS) {
      jobs.delete(videoId);
    }
  }
  return [...jobs.values()].filter(job => job.userId === userId).map(publicJob);
}

function buildOptimizeArgs(inputPath, outputPath, info, quality) {
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.balanced;
  const fps = info.fps && info.fps > 0 ? info.fps : 30;
  const keyint = Math.max(1, Math.round(fps * KEYFRAME_SECONDS));
  const frameRate = info.frameRate && parseRational(info.frameRate) ? info.frameRate : String(fps);
  const audioArgs = !info.audioCodec
    ? ['-an']
    : info.audioCodec === 'aac'
      ? ['-c:a', 'copy']
      : ['-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2'];

  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-map_metadata', '-1',
    '-c:v', 'libx265',
    '-preset', 'medium',
    '-crf', String(preset.crf),
    // Fixed-length closed GOP with no B-frames: every loop iteration starts on
    // a clean keyframe and timestamps stay monotonic across the seam.
    '-x265-params', `keyint=${keyint}:min-keyint=${keyint}:scenecut=0:open-gop=0:bframes=0:log-level=error`,
    '-pix_fmt', 'yuv420p',
    '-r', frameRate,
    '-tag:v', 'hvc1',
    ...audioArgs,
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    '-f', 'mp4',
    outputPath
  ];
}

function spawnEncoder(args) {
  const ffmpegPath = getFfmpegPath();
  // Live streams share this machine: keep the encode at low CPU priority.
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/nice')) {
    return spawn('/usr/bin/nice', ['-n', '15', ffmpegPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function removeQuietly(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {}
}

async function runJob(job) {
  const Video = require('../models/Video');
  const video = await Video.findById(job.videoId);
  if (!video) throw new Error('Video no longer exists');

  const inputPath = resolveMediaPath(video.filepath);
  if (!fs.existsSync(inputPath)) throw new Error('Video file not found on disk');

  const info = await probeVideo(inputPath, { withGop: false });
  if (!info.videoCodec) throw new Error('No video track found in this file');

  const videosDir = path.join(PUBLIC_DIR, 'uploads', 'videos');
  const baseName = `${path.parse(video.filepath).name}-h265loop-${job.id.slice(0, 8)}`;
  const finalPath = path.join(videosDir, `${baseName}.mp4`);
  const tempPath = path.join(videosDir, `${baseName}.encoding.tmp`);
  job.tempPath = tempPath;

  await new Promise((resolve, reject) => {
    const proc = spawnEncoder(buildOptimizeArgs(inputPath, tempPath, info, job.quality));
    job.process = proc;
    let stderrTail = '';
    let stdoutBuffer = '';

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop();
      for (const line of lines) {
        const match = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
        if (match && info.duration > 0) {
          const seconds = parseInt(match[1], 10) / 1e6;
          job.percent = Math.max(job.percent, Math.min(99, Math.floor((seconds / info.duration) * 100)));
        }
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    proc.on('error', reject);
    proc.on('exit', (code, signal) => {
      job.process = null;
      if (job.cancelled) return reject(new Error('Cancelled'));
      if (code === 0) return resolve();
      const detail = stderrTail.trim().split('\n').pop() || `exit code ${code}${signal ? `, signal ${signal}` : ''}`;
      reject(new Error(`FFmpeg failed: ${detail}`));
    });
  });

  fs.renameSync(tempPath, finalPath);
  job.tempPath = null;

  // The new video gets its own thumbnail file so deleting either video doesn't
  // take the other one's thumbnail with it.
  let thumbnailPath = video.thumbnail_path;
  if (video.thumbnail_path && video.thumbnail_path.startsWith('/uploads/')) {
    const sourceThumb = resolveMediaPath(video.thumbnail_path);
    if (fs.existsSync(sourceThumb)) {
      const thumbRel = `/uploads/thumbnails/thumb-${baseName}${path.extname(sourceThumb) || '.jpg'}`;
      try {
        fs.copyFileSync(sourceThumb, resolveMediaPath(thumbRel));
        thumbnailPath = thumbRel;
      } catch (e) {}
    }
  }

  const outputInfo = await probeVideo(finalPath);
  const created = await Video.create({
    title: `${video.title} (H.265 loop)`,
    filepath: `/uploads/videos/${baseName}.mp4`,
    thumbnail_path: thumbnailPath,
    file_size: fs.statSync(finalPath).size,
    duration: outputInfo.duration || video.duration,
    format: outputInfo.format,
    resolution: outputInfo.width && outputInfo.height ? `${outputInfo.width}x${outputInfo.height}` : video.resolution,
    bitrate: outputInfo.bitrate,
    fps: outputInfo.fps ? Math.round(outputInfo.fps * 100) / 100 : video.fps,
    user_id: video.user_id,
    folder_id: video.folder_id || null
  });
  await Video.update(created.id, {
    video_codec: outputInfo.videoCodec || 'hevc',
    gop_seconds: outputInfo.gopSeconds,
    loop_optimized: 1
  });
  return created.id;
}

async function processQueue() {
  if (activeJob) return;
  const job = jobQueue.shift();
  if (!job) return;
  if (job.cancelled) return processQueue();

  activeJob = job;
  job.status = 'running';
  try {
    job.outputVideoId = await runJob(job);
    job.status = 'done';
    job.percent = 100;
  } catch (err) {
    removeQuietly(job.tempPath);
    job.status = job.cancelled ? 'cancelled' : 'error';
    job.error = job.cancelled ? null : err.message;
    if (!job.cancelled) console.error(`[Codec] Optimize failed for video ${job.videoId}:`, err.message);
  } finally {
    job.finishedAt = Date.now();
    activeJob = null;
    processQueue();
  }
}

async function startOptimize(video, { quality = 'balanced' } = {}) {
  if (!video) throw new Error('Video not found');
  if (isAudioOnlyPath(video.filepath)) throw new Error('Only video files can be optimized');
  if (!QUALITY_PRESETS[quality]) throw new Error('Unknown quality preset');

  const existing = jobs.get(video.id);
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    throw new Error('This video is already being optimized');
  }

  const info = await getFfmpegInfo();
  if (!info.hasLibx265) {
    throw new Error(`The installed FFmpeg (${info.version || 'unknown'}) has no libx265 encoder. Install a build that includes it (scripts/install-ffmpeg-static.sh).`);
  }
  if (!fs.existsSync(resolveMediaPath(video.filepath))) {
    throw new Error('Video file not found on disk');
  }

  const job = {
    id: uuidv4(),
    videoId: video.id,
    userId: video.user_id,
    title: video.title,
    quality,
    status: 'queued',
    percent: 0,
    error: null,
    outputVideoId: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    cancelled: false,
    process: null,
    tempPath: null
  };
  jobs.set(video.id, job);
  jobQueue.push(job);
  processQueue();
  return publicJob(job);
}

function cancelOptimize(videoId, userId) {
  const job = jobs.get(videoId);
  if (!job || job.userId !== userId) return false;
  if (job.status !== 'queued' && job.status !== 'running') return false;
  job.cancelled = true;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.finishedAt = Date.now();
  } else if (job.process) {
    try { job.process.kill('SIGTERM'); } catch (e) {}
  }
  return true;
}

function isOptimizing(videoId) {
  const job = jobs.get(videoId);
  return !!job && (job.status === 'queued' || job.status === 'running');
}

// Don't leave an encoder running (or a half-written file) behind on shutdown.
process.on('exit', () => {
  if (activeJob) {
    if (activeJob.process) {
      try { activeJob.process.kill('SIGKILL'); } catch (e) {}
    }
    removeQuietly(activeJob.tempPath);
  }
});

// A crash or kill -9 skips the hook above; sweep leftovers on boot.
function cleanupStaleTempFiles() {
  const videosDir = path.join(PUBLIC_DIR, 'uploads', 'videos');
  try {
    for (const name of fs.readdirSync(videosDir)) {
      if (name.endsWith('.encoding.tmp')) removeQuietly(path.join(videosDir, name));
    }
  } catch (e) {}
}

module.exports = {
  QUALITY_PRESETS,
  MAX_GOP_SECONDS,
  getFfmpegPath,
  getFfprobePath,
  getFfmpegInfo,
  parseFfmpegVersion,
  versionSupportsHevcRtmp,
  probeVideo,
  getVideoCodec,
  analyzeAndStore,
  backfillMissing,
  assertCopyModeSupported,
  buildOptimizeArgs,
  startOptimize,
  cancelOptimize,
  isOptimizing,
  getJobsForUser,
  cleanupStaleTempFiles
};
