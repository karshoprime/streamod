// Gallery add-on for H.265 loop streaming: codec badges, the "Optimize for loop"
// action and its progress. Loaded by views/gallery.ejs, which calls
// HevcLoop.decorate(videos) every time the gallery is (re)rendered.
(function () {
  const POLL_INTERVAL_MS = 3000;
  const CODEC_LABELS = { hevc: 'H.265', h264: 'H.264', av1: 'AV1', vp9: 'VP9', mpeg4: 'MPEG-4' };

  let ffmpegInfo = null;
  let ffmpegInfoPromise = null;
  let videos = [];
  let jobsByVideoId = {};
  let pollTimer = null;
  let knownActiveJobs = new Set();

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(type, message) {
    if (typeof window.showToast === 'function') window.showToast(type, message);
  }

  function loadFfmpegInfo() {
    if (!ffmpegInfoPromise) {
      ffmpegInfoPromise = fetch('/api/system/ffmpeg-info')
        .then(res => res.json())
        .then(data => { ffmpegInfo = data && data.success ? data : null; return ffmpegInfo; })
        .catch(() => null);
    }
    return ffmpegInfoPromise;
  }

  function isAudio(video) {
    const filepath = (video.filepath || '').toLowerCase();
    return filepath.includes('/audio/') || /\.(m4a|aac|mp3|wav|flac|ogg)$/.test(filepath);
  }

  function isActive(job) {
    return !!job && (job.status === 'queued' || job.status === 'running');
  }

  // --- Badges ---------------------------------------------------------------

  function badgeMarkup(video) {
    const codec = video.video_codec;
    if (!codec || codec === 'unknown') return '';
    const label = CODEC_LABELS[codec] || codec.toUpperCase();
    const parts = [];
    const isHevc = codec === 'hevc';
    const unsupported = isHevc && ffmpegInfo && !ffmpegInfo.hevcRtmp;

    if (unsupported) {
      parts.push(`<span class="bg-yellow-500/90 text-black text-[10px] font-semibold px-1.5 py-0.5 rounded" title="H.265 can't be streamed in copy mode with FFmpeg ${escapeHtml(ffmpegInfo.version || '')}. FFmpeg 6.1+ is required.">${label} <i class="ti ti-alert-triangle"></i></span>`);
    } else {
      parts.push(`<span class="${isHevc ? 'bg-primary/90 text-white' : 'bg-black/70 text-gray-200'} text-[10px] font-semibold px-1.5 py-0.5 rounded" title="Video codec">${label}</span>`);
    }

    if (Number(video.loop_optimized) === 1) {
      parts.push('<span class="bg-green-500/90 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded" title="Optimized for looping: 2 second closed GOP"><i class="ti ti-repeat"></i> Loop</span>');
    } else {
      const maxGop = (ffmpegInfo && ffmpegInfo.maxGopSeconds) || 4;
      const gop = Number(video.gop_seconds);
      if (Number.isFinite(gop) && gop > maxGop) {
        parts.push(`<span class="bg-yellow-500/90 text-black text-[10px] font-semibold px-1.5 py-0.5 rounded" title="Keyframe every ${gop}s. YouTube expects 2s (max ${maxGop}s), and long gaps can glitch when looping in copy mode. Use Optimize for loop to fix."><i class="ti ti-alert-triangle"></i> ${gop}s keyframes</span>`);
      }
    }
    return parts.join('');
  }

  function progressMarkup(job) {
    const label = job.status === 'queued' ? 'Queued' : `Optimizing ${job.percent || 0}%`;
    return `
      <div class="flex flex-col items-center gap-2 px-3 w-full">
        <span class="text-white text-xs font-medium">${label}</span>
        <div class="w-full h-1.5 bg-white/20 rounded overflow-hidden">
          <div class="h-full bg-primary" style="width:${job.status === 'queued' ? 0 : (job.percent || 0)}%"></div>
        </div>
        <button type="button" class="hevc-cancel-btn text-[11px] text-gray-200 hover:text-white underline" data-video-id="${escapeHtml(job.videoId)}">Cancel</button>
      </div>`;
  }

  // --- DOM decoration -------------------------------------------------------

  function decorateGridItem(item, video) {
    const thumb = item.querySelector('.aspect-video');
    if (thumb) {
      thumb.querySelectorAll('.hevc-badges, .hevc-progress').forEach(el => el.remove());
      const badges = badgeMarkup(video);
      if (badges) {
        const wrap = document.createElement('div');
        wrap.className = 'hevc-badges absolute top-2 right-2 flex flex-col items-end gap-1 pointer-events-auto';
        wrap.innerHTML = badges;
        thumb.appendChild(wrap);
      }
      const job = jobsByVideoId[video.id];
      if (isActive(job)) {
        const overlay = document.createElement('div');
        overlay.className = 'hevc-progress absolute inset-0 bg-black/75 flex items-center justify-center';
        overlay.innerHTML = progressMarkup(job);
        overlay.addEventListener('click', (event) => event.stopPropagation());
        thumb.appendChild(overlay);
      }
    }
    const actions = item.querySelector('.p-3 .flex.items-center.gap-1');
    addActionButton(actions, video, 'text-gray-400 hover:text-primary p-1');
  }

  function decorateListItem(row, video) {
    const titleWrap = row.querySelector('td .flex.items-center.gap-2');
    if (titleWrap) {
      titleWrap.querySelectorAll('.hevc-badges').forEach(el => el.remove());
      const job = jobsByVideoId[video.id];
      const badges = badgeMarkup(video);
      const progress = isActive(job)
        ? `<span class="bg-primary/20 text-primary text-[10px] font-semibold px-1.5 py-0.5 rounded">${job.status === 'queued' ? 'Queued' : `Optimizing ${job.percent || 0}%`}</span>`
        : '';
      if (badges || progress) {
        const wrap = document.createElement('span');
        wrap.className = 'hevc-badges inline-flex items-center gap-1 flex-shrink-0';
        wrap.innerHTML = badges + progress;
        titleWrap.appendChild(wrap);
      }
    }
    const actions = row.querySelector('td:last-child .flex');
    addActionButton(actions, video, 'p-1.5 hover:bg-dark-600 rounded text-gray-400 hover:text-primary transition-colors');
  }

  function addActionButton(container, video, className) {
    if (!container) return;
    container.querySelectorAll('.hevc-optimize-btn').forEach(el => el.remove());
    if (Number(video.loop_optimized) === 1) return;

    const job = jobsByVideoId[video.id];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `hevc-optimize-btn ${className}`;
    button.dataset.videoId = video.id;
    if (isActive(job)) {
      button.title = 'Cancel optimization';
      button.innerHTML = '<i class="ti ti-player-stop text-sm"></i>';
      button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); cancel(video.id); };
    } else {
      button.title = 'Optimize for loop (H.265)';
      button.innerHTML = '<i class="ti ti-repeat text-sm"></i>';
      button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); openDialog(video); };
    }
    container.insertBefore(button, container.firstChild);
  }

  function renderWarningBanner() {
    const content = document.getElementById('galleryContent');
    if (!content) return;
    let banner = document.getElementById('hevcFfmpegWarning');
    const needsWarning = ffmpegInfo && !ffmpegInfo.hevcRtmp && videos.some(v => v.video_codec === 'hevc');
    if (!needsWarning) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'hevcFfmpegWarning';
      banner.className = 'mx-4 mt-4 flex items-start gap-3 bg-yellow-500/10 border border-yellow-500/40 text-yellow-200 text-sm rounded-lg px-4 py-3';
      content.parentNode.insertBefore(banner, content);
    }
    banner.innerHTML = `
      <i class="ti ti-alert-triangle text-lg mt-0.5"></i>
      <div>
        <strong>H.265 videos can't be streamed in copy mode yet.</strong>
        This server runs FFmpeg ${escapeHtml(ffmpegInfo.version || 'unknown')}; sending H.265 over RTMP needs FFmpeg 6.1 or newer.
        Run <code class="bg-black/40 px-1 rounded">sudo bash scripts/install-ffmpeg-static.sh</code> on the server, then restart the app.
      </div>`;
  }

  function decorate(videoList) {
    if (Array.isArray(videoList)) videos = videoList;
    const byId = {};
    videos.forEach(video => { byId[video.id] = video; });

    document.querySelectorAll('.file-item[data-id]').forEach(item => {
      const video = byId[item.dataset.id];
      if (video && !isAudio(video)) decorateGridItem(item, video);
    });
    document.querySelectorAll('.file-item-row[data-id]').forEach(row => {
      const video = byId[row.dataset.id];
      if (video && !isAudio(video)) decorateListItem(row, video);
    });
    document.querySelectorAll('.hevc-cancel-btn').forEach(button => {
      button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); cancel(button.dataset.videoId); };
    });
    renderWarningBanner();
  }

  // --- Actions --------------------------------------------------------------

  async function openDialog(video) {
    const info = await loadFfmpegInfo();
    if (!info) {
      toast('error', 'Could not read FFmpeg info from the server');
      return;
    }
    if (!info.hasLibx265) {
      toast('error', `FFmpeg ${info.version || ''} on this server has no H.265 encoder (libx265)`);
      return;
    }
    if (typeof window.createModalDialog !== 'function') return;

    const options = (info.qualities || []).map(q =>
      `<option value="${escapeHtml(q.id)}" ${q.id === 'balanced' ? 'selected' : ''}>${escapeHtml(q.label)} (CRF ${q.crf})</option>`
    ).join('');
    const versionNote = info.hevcRtmp ? '' : `
      <span class="block mt-3 text-yellow-300">Note: this server runs FFmpeg ${escapeHtml(info.version || 'unknown')}. You can create the file now, but streaming H.265 needs FFmpeg 6.1+.</span>`;

    let quality = 'balanced';
    const pending = window.createModalDialog({
      type: 'info',
      icon: 'ti-repeat',
      title: 'Optimize for loop (H.265)',
      message: `Creates an H.265 copy of "${escapeHtml(video.title)}" with a keyframe every 2 seconds, so it loops cleanly in copy mode at roughly half the bitrate. The original stays untouched. Encoding runs in the background and can take a while.
        <span class="block mt-3 text-gray-300">Quality</span>
        <select id="hevc-quality-select" class="mt-1 w-full bg-dark-700 border border-gray-600 text-white px-3 py-2 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary">${options}</select>${versionNote}`,
      confirmText: 'Start'
    });
    const select = document.getElementById('hevc-quality-select');
    if (select) select.addEventListener('change', () => { quality = select.value; });

    const result = await pending;
    if (!result.confirmed) return;

    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(video.id)}/optimize-loop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quality })
      });
      const data = await response.json();
      if (!data.success) {
        toast('error', data.error || 'Failed to start optimization');
        return;
      }
      toast('success', 'Optimization started');
      jobsByVideoId[video.id] = data.job;
      knownActiveJobs.add(video.id);
      decorate();
      startPolling();
    } catch (error) {
      toast('error', 'An error occurred while starting the optimization');
    }
  }

  async function cancel(videoId) {
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}/optimize-loop`, { method: 'DELETE' });
      const data = await response.json();
      if (data.success) {
        toast('warning', 'Optimization cancelled');
        knownActiveJobs.delete(videoId);
      } else {
        toast('error', data.error || 'Failed to cancel');
      }
    } catch (error) {
      toast('error', 'An error occurred while cancelling');
    }
    pollJobs();
  }

  // --- Polling --------------------------------------------------------------

  async function pollJobs() {
    let jobs = [];
    try {
      const response = await fetch('/api/videos/optimize-loop/jobs');
      const data = await response.json();
      jobs = (data && data.jobs) || [];
    } catch (error) {
      return;
    }

    jobsByVideoId = {};
    let anyActive = false;
    let needsRefresh = false;
    jobs.forEach(job => {
      jobsByVideoId[job.videoId] = job;
      if (isActive(job)) {
        anyActive = true;
        knownActiveJobs.add(job.videoId);
      } else if (knownActiveJobs.has(job.videoId)) {
        // A job we were watching just finished.
        knownActiveJobs.delete(job.videoId);
        if (job.status === 'done') {
          toast('success', `"${job.title}" is ready as an H.265 loop video`);
          needsRefresh = true;
        } else if (job.status === 'error') {
          toast('error', job.error || 'Optimization failed');
        }
      }
    });

    if (needsRefresh && typeof window.refreshGalleryData === 'function') {
      await window.refreshGalleryData(); // re-renders and calls decorate()
    } else {
      decorate();
    }

    if (!anyActive) stopPolling();
    else startPolling();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollJobs, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Codec info for freshly uploaded videos is filled in a moment after the
  // upload finishes. Pull just those fields and update the badges in place, so
  // the gallery isn't re-rendered (and the current page isn't reset).
  const MAX_INFO_REFRESHES = 5;
  let infoRefreshAttempts = 0;
  let infoRefreshTimer = null;
  function hasMissingCodecInfo() {
    return videos.some(v => !isAudio(v) && !v.video_codec);
  }
  function scheduleCodecInfoRefresh() {
    if (!hasMissingCodecInfo()) {
      infoRefreshAttempts = 0;
      return;
    }
    if (infoRefreshTimer || infoRefreshAttempts >= MAX_INFO_REFRESHES) return;
    infoRefreshAttempts += 1;
    infoRefreshTimer = setTimeout(async () => {
      infoRefreshTimer = null;
      try {
        const folder = new URLSearchParams(window.location.search).get('folder');
        const response = await fetch(`/api/gallery/data${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`);
        const data = await response.json();
        const fresh = {};
        ((data && data.videos) || []).forEach(v => { fresh[v.id] = v; });
        videos.forEach(video => {
          const update = fresh[video.id];
          if (update) {
            video.video_codec = update.video_codec;
            video.gop_seconds = update.gop_seconds;
            video.loop_optimized = update.loop_optimized;
          }
        });
      } catch (error) {}
      decorate();
      scheduleCodecInfoRefresh();
    }, 4000);
  }

  window.HevcLoop = {
    decorate(videoList) {
      decorate(videoList);
      scheduleCodecInfoRefresh();
    },
    init(videoList) {
      videos = Array.isArray(videoList) ? videoList : [];
      loadFfmpegInfo().then(() => {
        decorate();
        scheduleCodecInfoRefresh();
      });
      pollJobs();
    }
  };
})();
