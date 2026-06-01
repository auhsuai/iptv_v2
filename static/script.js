/**
 * IPTV v2 — Frontend Controller
 * Complete features with zero hardcoded text, client-side i18n, EPG, scanner, seek timeline, and settings.
 */

// ═══════════════════════════════════════════════════════════════════
// DOM Elements
// ═══════════════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
    video:              $('#video'),
    youtubePlayer:      $('#youtube-player'),
    playerContainer:    $('#player-container'),
    playerWelcome:      $('#player-welcome'),
    playerLoader:       $('#player-loader'),
    playerError:        $('#player-error'),
    errorMsg:           $('#error-msg'),
    btnRetry:           $('#btn-retry'),

    channelList:        $('#channel-list'),
    emptyState:         $('#empty-state'),
    searchInput:        $('#search-input'),

    playlistBar:        $('#playlist-bar'),
    playlistSelect:     $('#playlist-select'),
    btnDeletePlaylist:  $('#btn-delete-playlist'),
    btnScan:            $('#btn-scan'),
    btnEpg:             $('#btn-epg'),
    btnRename:          $('#btn-rename'),
    btnSync:            $('#btn-sync'),
    btnPlaylistMenu:    $('#btn-playlist-menu'),
    playlistMenu:       $('#playlist-menu'),

    groupBar:           $('#group-bar'),
    groupChips:         $('#group-chips'),

    sidebarFooter:      $('#sidebar-footer'),
    channelCount:       $('#channel-count'),

    btnAdd:             $('#btn-add'),
    modalOverlay:       $('#modal-overlay'),
    modalTitle:         $('#modal-title'),
    modalInput:         $('#modal-input'),
    modalFileContainer: $('#modal-file-container'),
    modalFileInput:     $('#modal-file-input'),
    fileUploadText:     $('#file-upload-text'),
    modalError:         $('#modal-error'),
    modalCancel:        $('#modal-cancel'),
    modalOk:            $('#modal-ok'),

    btnPlay:            $('#btn-play'),
    iconPlay:           $('.icon-play'),
    iconPause:          $('.icon-pause'),
    btnMute:            $('#btn-mute'),
    iconVol:            $('.icon-vol'),
    iconMuted:          $('.icon-muted'),
    volumeSlider:       $('#volume-slider'),
    btnFullscreen:      $('#btn-fullscreen'),
    btnPip:             $('#btn-pip'),
    btnSettings:        $('#btn-settings'),
    settingsPanel:      $('#settings-panel'),
    toggleTranscode:    $('#toggle-transcode'),
    qualityList:        $('#quality-list'),
    audioList:          $('#audio-list'),
    nowPlaying:         $('#now-playing'),
    controlsBar:        $('#controls-bar'),

    timelineContainer:  $('#timeline-container'),
    timelineSlider:     $('#timeline-slider'),
    timeDisplay:        $('#time-display'),
    btnDownload:        $('#btn-download'),
    downloadCount:      $('#download-count'),

    epgScheduleStrip:   $('#epg-schedule-strip'),
    toast:              $('#toast'),
};

// ═══════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════

let state = {
    playlists: [],
    activePlaylistId: '',
    channels: [],
    filteredChannels: [],
    activeGroup: '',
    currentChannel: null,
    hls: null,
    langKeys: {},
    currentLang: 'vi', // Default language
    modalMode: '', // 'import', 'epg', 'rename'
    recordedSegments: [],
    isDirect: false,
    directUrl: '',
    retryCount: 0,
    favorites: JSON.parse(localStorage.getItem('iptv_favorites') || '[]'),
    activeRecordings: []
};

// Poll backend recording status
setInterval(async () => {
    try {
        const res = await fetch('/api/record/status');
        const data = await res.json();
        state.activeRecordings = data.active_urls || [];
        updateRecordButtonUI();
    } catch(e) {}
}, 2000);

function updateRecordButtonUI() {
    if (!state.currentChannel) return;
    const isRec = state.activeRecordings.includes(state.currentChannel.url);
    if (isRec) {
        dom.btnDownload.style.color = 'var(--danger)';
        dom.downloadCount.textContent = 'REC';
        dom.downloadCount.style.display = 'block';
    } else {
        dom.btnDownload.style.color = 'var(--text-primary)';
        dom.downloadCount.style.display = 'none';
    }
}

window.toggleFavorite = (e, url, name) => {
    e.stopPropagation();
    const idx = state.favorites.findIndex(f => f.url === url && f.name === name);
    if (idx !== -1) {
        state.favorites.splice(idx, 1);
    } else {
        state.favorites.push({ url, name });
    }
    localStorage.setItem('iptv_favorites', JSON.stringify(state.favorites));
    if (state.activeGroup === 'Favorites' && state.favorites.length === 0) {
        state.activeGroup = '';
    }
    filterAndRender();
};

// ═══════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
    const initialLang = 'en';
    await loadLanguage(initialLang);
    
    await loadPlaylists();
    setupEventListeners();
    
    syncVolumeUI();
    
    enableWheelScroll(dom.groupChips);
    enableWheelScroll(dom.epgScheduleStrip);
});

// ═══════════════════════════════════════════════════════════════════
// Internationalization (i18n)
// ═══════════════════════════════════════════════════════════════════

async function loadLanguage(lang) {
    state.currentLang = lang;
    try {
        const res = await fetch(`/api/languages/${lang}`);
        state.langKeys = await res.json();
        translateDOM();
    } catch (e) {
        console.error('Failed to load language:', e);
    }
}

function translateDOM() {
    // Text contents
    $$('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (state.langKeys[key]) {
            if (key === 'logo_title') {
                const versionSpan = el.parentElement.querySelector('.version');
                el.textContent = state.langKeys[key];
                if (versionSpan) {
                    el.parentElement.appendChild(versionSpan);
                }
            } else {
                el.textContent = state.langKeys[key];
            }
        }
    });

    // Placeholders
    $$('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (state.langKeys[key]) {
            el.setAttribute('placeholder', state.langKeys[key]);
        }
    });

    // Titles
    $$('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (state.langKeys[key]) {
            el.setAttribute('title', state.langKeys[key]);
        }
    });
}

function getText(key, params = {}) {
    let text = state.langKeys[key] || key;
    for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, v);
    }
    return text;
}

// ═══════════════════════════════════════════════════════════════════
// API Calls
// ═══════════════════════════════════════════════════════════════════

async function loadPlaylists() {
    try {
        const res = await fetch('/api/playlists');
        state.playlists = await res.json();
    } catch (e) {
        state.playlists = [];
        toast(getText('toast_error_load_playlists'), 'error');
    }

    renderPlaylistSelector();

    if (state.playlists.length > 0) {
        const storedPlaylistId = localStorage.getItem('iptv_active_playlist_id');
        if (storedPlaylistId && state.playlists.find(p => p.id === storedPlaylistId)) {
            state.activePlaylistId = storedPlaylistId;
        }
        if (!state.activePlaylistId || !state.playlists.find(p => p.id === state.activePlaylistId)) {
            state.activePlaylistId = state.playlists[0].id;
        }
        localStorage.setItem('iptv_active_playlist_id', state.activePlaylistId);
        dom.playlistSelect.value = state.activePlaylistId;
        await loadChannels(state.activePlaylistId);
    } else {
        state.activePlaylistId = '';
        state.channels = [];
        state.filteredChannels = [];
        renderChannels();
    }
    updatePlaylistActionsUI();
    if (state.activePlaylistId) {
        autoSyncPlaylist(state.activePlaylistId);
    }
}

function updatePlaylistActionsUI() {
    if (!state.activePlaylistId) {
        dom.btnSync.style.display = 'none';
        return;
    }
    const activePlaylist = state.playlists.find(p => p.id === state.activePlaylistId);
    if (activePlaylist && activePlaylist.url !== 'local_file') {
        dom.btnSync.style.display = 'flex';
    } else {
        dom.btnSync.style.display = 'none';
    }
}

async function autoSyncPlaylist(playlistId) {
    const playlist = state.playlists.find(p => p.id === playlistId);
    if (!playlist || playlist.url === 'local_file' || !playlist.url) return;

    try {
        const res = await fetch(`/api/playlists/${playlistId}/sync?lang=${state.currentLang}`, { method: 'POST' });
        if (res.ok) {
            await loadChannels(playlistId);
        }
    } catch (e) {
        console.warn('Auto-sync failed:', e);
    }
}

async function loadChannels(playlistId) {
    try {
        const res = await fetch(`/api/channels/${playlistId}`);
        state.channels = await res.json();
    } catch (e) {
        state.channels = [];
        toast(getText('toast_error_load_channels'), 'error');
    }

    state.activeGroup = '';
    filterAndRender();
}

// ═══════════════════════════════════════════════════════════════════
// Render Functions
// ═══════════════════════════════════════════════════════════════════

function renderPlaylistSelector() {
    const select = dom.playlistSelect;
    select.innerHTML = '';

    if (state.playlists.length === 0) {
        dom.playlistBar.style.display = 'none';
        return;
    }

    dom.playlistBar.style.display = 'flex';
    state.playlists.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        select.appendChild(opt);
    });
}

function filterAndRender() {
    const search = dom.searchInput.value.toLowerCase().trim();
    const group = state.activeGroup;

    state.filteredChannels = state.channels.filter(ch => {
        const isFav = state.favorites.some(f => f.url === ch.url && f.name === ch.name);
        const matchGroup = group === 'Favorites' ? isFav : (!group || ch.group === group);
        const matchSearch = !search || ch.name.toLowerCase().includes(search);
        return matchGroup && matchSearch;
    });

    renderGroupChips();
    renderChannels();
}

function renderGroupChips() {
    const groups = [...new Set(state.channels.map(ch => ch.group).filter(Boolean))].sort();
    const favCount = state.channels.filter(ch => state.favorites.some(f => f.url === ch.url && f.name === ch.name)).length;

    if (groups.length <= 1 && favCount === 0) {
        dom.groupBar.style.display = 'none';
        return;
    }

    dom.groupBar.style.display = 'block';
    dom.groupChips.innerHTML = '';

    if (favCount > 0) {
        const favChip = document.createElement('button');
        favChip.className = `chip${state.activeGroup === 'Favorites' ? ' active' : ''}`;
        favChip.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="margin-right:4px; margin-bottom:-2px;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>Favorites (${favCount})`;
        favChip.onclick = () => {
            state.activeGroup = 'Favorites';
            filterAndRender();
        };
        dom.groupChips.appendChild(favChip);
    }

    // "All" chip
    const allChip = document.createElement('button');
    allChip.className = `chip${state.activeGroup === '' ? ' active' : ''}`;
    allChip.textContent = `${getText('settings_auto')} (${state.channels.length})`;
    allChip.onclick = () => {
        state.activeGroup = '';
        filterAndRender();
    };
    dom.groupChips.appendChild(allChip);

    groups.forEach(g => {
        const count = state.channels.filter(ch => ch.group === g).length;
        const chip = document.createElement('button');
        chip.className = `chip${state.activeGroup === g ? ' active' : ''}`;
        chip.textContent = `${g} (${count})`;
        chip.onclick = () => {
            state.activeGroup = g;
            filterAndRender();
        };
        dom.groupChips.appendChild(chip);
    });
}

function getCurrentEpgProgram(ch) {
    if (!ch.epg_programs || ch.epg_programs.length === 0) return null;
    const now = Math.floor(Date.now() / 1000);
    return ch.epg_programs.find(p => p.start <= now && now < p.stop) || null;
}

function renderChannels() {
    const list = dom.channelList;
    list.innerHTML = '';

    if (state.filteredChannels.length === 0) {
        if (state.channels.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon-static"></div>
                    <p>${getText('empty_state_title')}</p>
                    <span>${getText('empty_state_subtitle')}</span>
                </div>`;
        } else {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon-static" style="filter: hue-rotate(45deg);"></div>
                    <p>${getText('empty_state_no_results')}</p>
                    <span>${getText('empty_state_try_again')}</span>
                </div>`;
        }
        dom.sidebarFooter.style.display = 'none';
        return;
    }

    dom.sidebarFooter.style.display = 'block';
    dom.channelCount.textContent = `${state.filteredChannels.length} / ${state.channels.length}`;

    const defaultLogo = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="%23334155"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="16" fill="%2394a3b8">TV</text></svg>'
    );

    state.filteredChannels.forEach((ch, idx) => {
        const div = document.createElement('div');
        div.className = 'ch-item';
        if (state.currentChannel && state.currentChannel === ch) {
            div.classList.add('active');
        }

        let displayName = ch.name;
        let blvName = '';
        const match = ch.name.match(/(.*?)\s*[-|(\[]\s*BLV\s+(.*?)[)\]]?$/i);
        if (match) {
            displayName = match[1].trim();
            blvName = match[2].trim();
        }

        let groupText = escapeHTML(ch.group);
        if (blvName) {
            groupText += ` <span style="opacity:0.5; margin:0 4px;">|</span> <span style="color:#94a3b8; font-weight:500;">${escapeHTML(blvName)}</span>`;
        }

        const currentProg = getCurrentEpgProgram(ch);
        const epgText = currentProg 
            ? `<div class="ch-group" style="color: var(--accent); font-weight: 500;">${escapeHTML(currentProg.title)}${blvName ? ` <span style="opacity:0.5; margin:0 4px; color:var(--text-muted);">|</span> <span style="color:#94a3b8;">${escapeHTML(blvName)}</span>` : ''}</div>` 
            : `<div class="ch-group">${groupText}</div>`;

        const isFav = state.favorites.some(f => f.url === ch.url && f.name === ch.name);
        const favIcon = isFav 
            ? `<svg viewBox="0 0 24 24" fill="var(--warning)" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;

        div.innerHTML = `
            <img class="ch-logo" src="${ch.logo || defaultLogo}" onerror="this.src='${defaultLogo}'" loading="lazy" alt="">
            <div class="ch-info">
                <div class="ch-name" title="${escapeHTML(displayName)}">${escapeHTML(displayName)}</div>
                ${epgText}
            </div>
            <div class="ch-actions">
                <button class="btn-fav ${isFav ? 'favorited' : ''}" onclick="window.toggleFavorite(event, '${ch.url.replace(/'/g, "\\'")}', '${ch.name.replace(/'/g, "\\'")}')" title="Toggle Favorite">
                    ${favIcon}
                </button>
            </div>
            <div class="ch-status ${ch.status || 'unknown'}" title="${getText('status_' + (ch.status || 'unknown'))}"></div>
        `;

        div.onclick = () => playChannel(ch);
        list.appendChild(div);
    });
}

// Removed IndexedDB chunking

function playChannel(ch) {
    state.currentChannel = ch;
    state.retryCount = 0;

    // Reset settings panel
    dom.settingsPanel.style.display = 'none';
    dom.btnSettings.style.display = 'inline-flex';

    // Update UI
    dom.playerWelcome.style.display = 'none';
    dom.playerError.style.display = 'none';
    dom.playerLoader.style.display = 'flex';
    dom.playerContainer.classList.add('active-player');
    dom.nowPlaying.textContent = getText('now_playing', { name: ch.name });

    // Highlight active item
    $$('.ch-item').forEach((el, idx) => {
        if (state.filteredChannels[idx] && state.filteredChannels[idx] === ch) {
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
    });

    if (ch.epg_programs) {
        const now = Math.floor(Date.now() / 1000);
        ch.epg_current_index = ch.epg_programs.findIndex(p => p.start <= now && now < p.stop);
    }

    renderEpgStrip(ch);
    destroyHls();
    startPlayback(ch.url, ch);
}

function getYouTubeId(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

function isDirectVideo(url) {
    const cleanUrl = url.split('|')[0].split('?')[0].toLowerCase();
    return cleanUrl.endsWith('.mp4') || cleanUrl.endsWith('.webm') || cleanUrl.endsWith('.ogg') || cleanUrl.endsWith('.mov') || cleanUrl.endsWith('.mp3');
}

function startPlayback(url, ch, isProxy = false, isCatchup = false) {
    state.isLive = !isCatchup;
    setupPlayerSettings();

    dom.video.style.display = 'block';
    dom.youtubePlayer.style.display = 'none';
    dom.youtubePlayer.src = '';

    const rawUrl = url.split('|')[0];
    const youtubeId = getYouTubeId(rawUrl);
    
    if (youtubeId) {
        state.isLive = false; // YouTube videos are VOD
        dom.video.style.display = 'none';
        dom.youtubePlayer.style.display = 'block';
        dom.youtubePlayer.src = `https://www.youtube.com/embed/${youtubeId}?autoplay=1&controls=1`;
        dom.playerLoader.style.display = 'none';
        return;
    }

    if (dom.toggleTranscode && dom.toggleTranscode.checked) {
        state.isLive = true;
        state.isDirect = true;
        state.directUrl = url;
        updateRecordButtonUI();
        const transcodeUrl = `/api/transcode?url=${encodeURIComponent(url)}`;
        dom.video.src = transcodeUrl;
        dom.video.play().catch(() => {});
        dom.playerLoader.style.display = 'none';
        return;
    }

    if (isDirectVideo(rawUrl)) {
        state.isLive = false; // Direct MP4/MKV files are VOD
        state.isDirect = true;
        state.directUrl = url;
        updateRecordButtonUI();
        dom.video.src = url;
        dom.video.play().catch(() => {});
        dom.playerLoader.style.display = 'none';
        return;
    }

    if (!Hls.isSupported()) {
        if (dom.video.canPlayType('application/vnd.apple.mpegurl')) {
            dom.video.src = url;
            dom.video.play().catch(() => {});
            dom.playerLoader.style.display = 'none';
        } else {
            showError('HLS not supported in this browser');
        }
        return;
    }

    const hls = new Hls({
        debug: false,
        enableWorker: false, // Must be false so data.payload ArrayBuffer is not detached before we can save it!
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1000 * 1000,
        startFragPrefetch: true,
    });

    state.hls = hls;
    hls.attachMedia(dom.video);

    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(url);
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
        state.retryCount = 0;
        dom.playerLoader.style.display = 'none';
        dom.video.play().catch(e => console.log('Autoplay blocked:', e));
        setupPlayerSettings();
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
        if (!data.fatal) return;

        console.warn('[HLS Error]', data.type, data.details);

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            console.log('Trying to recover from media error...');
            hls.recoverMediaError();
            return;
        }

        if (!isProxy && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            console.log('Switching to proxy...');
            destroyHls(false);
            const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;
            startPlayback(proxyUrl, ch, true, !state.isLive);
            return;
        }

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR || data.fatal) {
            if (state.retryCount < 3) {
                state.retryCount++;
                console.log(`[HLS] Fatal error, retrying (${state.retryCount}/3)...`);
                toast(`${getText('toast_error_load_channels')} - Auto reconnect (${state.retryCount}/3)...`, 'warning');
                
                setTimeout(() => {
                    destroyHls(false);
                    startPlayback(url, ch, isProxy, !state.isLive);
                }, 1500);
                return;
            }
        }

        showError(`${data.type}: ${data.details}`);
    });
}

function destroyHls() {
    state.isDirect = false;
    state.directUrl = '';
    if (state.hls) {
        state.hls.destroy();
        state.hls = null;
    }
    dom.youtubePlayer.src = '';
    dom.youtubePlayer.style.display = 'none';
    dom.video.style.display = 'block';
}

function showError(msg) {
    dom.playerLoader.style.display = 'none';
    dom.playerError.style.display = 'flex';
    dom.errorMsg.textContent = msg;
}

function getCatchupUrl(ch, prog) {
    if (!ch.catchup && !ch.catchup_source) return null;
    
    let source = ch.catchup_source || "?utc=${start}&lutc=${end}";
    
    const startTs = prog.start;
    const endTs = prog.stop;
    const durationSec = endTs - startTs;
    
    const formatYmdHis = (ts) => {
        const d = new Date(ts * 1000);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const r = String(d.getUTCDate()).padStart(2, '0');
        const h = String(d.getUTCHours()).padStart(2, '0');
        const min = String(d.getUTCMinutes()).padStart(2, '0');
        const s = String(d.getUTCSeconds()).padStart(2, '0');
        return `${y}${m}${r}${h}${min}${s}`;
    };
    
    const startYmdHis = formatYmdHis(startTs);
    const endYmdHis = formatYmdHis(endTs);

    let replaced = source
        .replace(/\${start}/g, startTs)
        .replace(/\${end}/g, endTs)
        .replace(/\${duration}/g, durationSec)
        .replace(/\${utc}/g, startTs)
        .replace(/\${lutc}/g, endTs)
        .replace(/\${offset}/g, Math.floor(startTs / 3600))
        .replace(/\${start-ymd}/g, startYmdHis)
        .replace(/\${end-ymd}/g, endYmdHis);

    if (source.startsWith('?') || source.startsWith('&') || (!source.startsWith('http://') && !source.startsWith('https://'))) {
        const base = ch.url;
        const joiner = base.includes('?') ? '&' : '?';
        const cleanReplaced = replaced.replace(/^[?&]/, '');
        return base + joiner + cleanReplaced;
    }
    
    return replaced;
}

// EPG bottom strip
function renderEpgStrip(ch) {
    const strip = dom.epgScheduleStrip;
    if (!ch.epg_programs || ch.epg_programs.length === 0) {
        strip.style.display = 'none';
        strip.innerHTML = '';
        return;
    }

    strip.style.display = 'flex';
    strip.innerHTML = '';

    const now = Math.floor(Date.now() / 1000);
    let activeItem = null;

    ch.epg_programs.forEach((prog, idx) => {
        const isCurrent = (idx === ch.epg_current_index);
        const isPast = (prog.stop <= now);
        const hasCatchup = !!(ch.catchup || ch.catchup_source);
        const isPlayable = isPast && hasCatchup;

        const item = document.createElement('div');
        item.className = `epg-item${isCurrent ? ' now' : ''}${isPlayable ? ' playable' : ''}`;

        const startStr = formatEpochTime(prog.start);
        const stopStr = formatEpochTime(prog.stop);

        let progressHtml = '';
        if (isCurrent) {
            const duration = prog.stop - prog.start;
            const pct = duration > 0 ? Math.min(Math.max(((now - prog.start) / duration) * 100, 0), 100) : 0;
            progressHtml = `<div class="epg-item-progress"><div class="epg-item-progress-bar" style="width:${pct}%"></div></div>`;
        }

        let badgeHtml = '';
        if (isPlayable) {
            badgeHtml = `<span class="epg-badge-catchup">${getText('epg_badge_catchup')}</span>`;
        }

        item.innerHTML = `
            <span class="epg-item-time">${startStr} - ${stopStr}</span>
            <span class="epg-item-title" title="${escapeHTML(prog.title)}">${escapeHTML(prog.title)}</span>
            ${progressHtml}
            ${badgeHtml}
        `;

        if (isPlayable) {
            item.onclick = () => {
                const catchupUrl = getCatchupUrl(ch, prog);
                if (catchupUrl) {
                    toast(`${getText('now_playing', { name: ch.name })} - [${prog.title}]`, 'info');
                    destroyHls();
                    startPlayback(catchupUrl, ch, false, true);
                }
            };
        }

        strip.appendChild(item);
        if (isCurrent) activeItem = item;
    });

    if (activeItem) {
        setTimeout(() => {
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }, 200);
    }
}

// ═══════════════════════════════════════════════════════════════════
// Settings Menu (Quality / Audio)
// ═══════════════════════════════════════════════════════════════════

function setupPlayerSettings() {
    dom.qualityList.innerHTML = '';
    dom.audioList.innerHTML = '';

    let hasQualities = false;
    let hasAudioTracks = false;

    const ch = state.currentChannel;

    // Quality selection
    if (ch && ch.qualities && Object.keys(ch.qualities).length > 1) {
        hasQualities = true;
        $('#section-quality').style.display = 'block';

        const qualities = Object.keys(ch.qualities);
        qualities.forEach((q) => {
            const opt = document.createElement('div');
            const isActive = ch.url === ch.qualities[q];
            opt.className = `settings-item${isActive ? ' active' : ''}`;
            opt.textContent = q === 'Default' ? getText('settings_auto') : q;
            opt.onclick = () => {
                if (ch.url !== ch.qualities[q]) {
                    ch.url = ch.qualities[q];
                    destroyHls(false);
                    startPlayback(ch.url, ch);
                    dom.settingsPanel.style.display = 'none';
                }
            };
            dom.qualityList.appendChild(opt);
        });
    } else if (state.hls && state.hls.levels && state.hls.levels.length > 1) {
        hasQualities = true;
        $('#section-quality').style.display = 'block';

        // Auto option
        const autoOpt = document.createElement('div');
        autoOpt.className = `settings-item${state.hls.loadLevel === -1 ? ' active' : ''}`;
        autoOpt.textContent = getText('settings_auto');
        autoOpt.onclick = () => {
            state.hls.currentLevel = -1;
            updateSettingsUI();
        };
        dom.qualityList.appendChild(autoOpt);

        // Quality levels
        state.hls.levels.forEach((level, idx) => {
            const opt = document.createElement('div');
            opt.className = `settings-item${state.hls.loadLevel === idx ? ' active' : ''}`;
            const height = level.height || (level.attrs && level.attrs.RESOLUTION ? level.attrs.RESOLUTION.split('x')[1] : null);
            opt.textContent = height ? `${height}p` : `${getText('settings_quality')} ${idx + 1}`;
            opt.onclick = () => {
                state.hls.currentLevel = idx;
                updateSettingsUI();
            };
            dom.qualityList.appendChild(opt);
        });
    } else {
        $('#section-quality').style.display = 'none';
    }

    // Audio tracks
    if (state.hls && state.hls.audioTracks && state.hls.audioTracks.length > 1) {
        hasAudioTracks = true;
        $('#section-audio').style.display = 'block';

        state.hls.audioTracks.forEach((track, idx) => {
            const opt = document.createElement('div');
            opt.className = `settings-item${state.hls.audioTrack === idx ? ' active' : ''}`;
            opt.textContent = track.name || `${getText('settings_audio')} ${idx + 1}`;
            opt.onclick = () => {
                state.hls.audioTrack = idx;
                updateSettingsUI();
            };
            dom.audioList.appendChild(opt);
        });
    } else {
        $('#section-audio').style.display = 'none';
    }

    // Always show settings button because we have the Force Transcode toggle
    dom.btnSettings.style.display = 'inline-flex';
}

function updateSettingsUI() {
    const ch = state.currentChannel;
    
    // Refresh active status
    const qualityItems = dom.qualityList.children;
    if (qualityItems.length > 0) {
        if (ch && ch.qualities && Object.keys(ch.qualities).length > 1) {
            const qualities = Object.keys(ch.qualities);
            for (let i = 0; i < qualityItems.length; i++) {
                const isActive = ch.url === ch.qualities[qualities[i]];
                qualityItems[i].className = `settings-item${isActive ? ' active' : ''}`;
            }
        } else if (state.hls) {
            const activeLevel = state.hls.currentLevel;
            // First child is Auto
            qualityItems[0].className = `settings-item${activeLevel === -1 ? ' active' : ''}`;
            for (let i = 1; i < qualityItems.length; i++) {
                qualityItems[i].className = `settings-item${activeLevel === (i - 1) ? ' active' : ''}`;
            }
        }
    }

    const audioItems = dom.audioList.children;
    if (audioItems.length > 0 && state.hls) {
        const activeTrack = state.hls.audioTrack;
        for (let i = 0; i < audioItems.length; i++) {
            audioItems[i].className = `settings-item${activeTrack === i ? ' active' : ''}`;
        }
    }
    
    dom.settingsPanel.style.display = 'none';
}



// ═══════════════════════════════════════════════════════════════════
// Timeline Seek Logic (VOD Support)
// ═══════════════════════════════════════════════════════════════════

function updateTimelineUI() {
    const duration = dom.video.duration;
    const currentTime = dom.video.currentTime;

    if (duration && duration !== Infinity && !isNaN(duration)) {
        dom.timelineContainer.style.display = 'flex';
        dom.timelineSlider.max = duration;
        dom.timelineSlider.value = currentTime;

        // Draw progress and buffer directly on the slider background
        const progressPct = (currentTime / duration) * 100;
        let bufferPct = 0;
        if (dom.video.buffered.length > 0) {
            let activeBufferEnd = 0;
            for (let i = 0; i < dom.video.buffered.length; i++) {
                if (dom.video.buffered.start(i) <= currentTime && dom.video.buffered.end(i) >= currentTime) {
                    activeBufferEnd = dom.video.buffered.end(i);
                    break;
                }
            }
            bufferPct = (activeBufferEnd / duration) * 100;
        }
        const maxPct = Math.max(progressPct, bufferPct);

        dom.timelineSlider.style.background = `linear-gradient(to right, 
            var(--accent) 0%, 
            var(--accent) ${progressPct}%, 
            rgba(255, 255, 255, 0.25) ${progressPct}%, 
            rgba(255, 255, 255, 0.25) ${maxPct}%, 
            rgba(255, 255, 255, 0.15) ${maxPct}%, 
            rgba(255, 255, 255, 0.15) 100%
        )`;

        dom.timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    } else {
        dom.timelineContainer.style.display = 'none';
    }
}

async function updateDownloadButtonUI() {
    if (state.isDirect && state.directUrl) {
        dom.btnDownload.style.display = 'inline-flex';
        dom.downloadCount.style.display = 'none';
        return;
    }

    try {
        const count = await getSegmentCount();
        if (count > 0) {
            dom.btnDownload.style.display = 'inline-flex';
            // Assume 5s per segment
            const approxMinutes = Math.round((count * 5) / 60);
            if (approxMinutes > 0) {
                dom.downloadCount.style.display = 'block';
                dom.downloadCount.textContent = `${approxMinutes}m`;
            } else {
                dom.downloadCount.style.display = 'block';
                dom.downloadCount.textContent = `${count}`;
            }
        } else {
            dom.btnDownload.style.display = 'none';
        }
    } catch (e) {
        dom.btnDownload.style.display = 'none';
    }
}

// ═══════════════════════════════════════════════════════════════════
// Modal Controllers
// ═══════════════════════════════════════════════════════════════════

function openModal(mode) {
    state.modalMode = mode;
    dom.modalOverlay.style.display = 'flex';
    dom.modalInput.value = '';
    dom.modalError.style.display = 'none';
    dom.modalOk.textContent = getText('btn_ok');
    
    // Reset file input states
    dom.modalFileContainer.style.display = 'none';
    dom.modalFileInput.value = '';
    dom.fileUploadText.textContent = getText('file_upload_select');

    if (mode === 'import') {
        dom.modalTitle.textContent = getText('modal_import_title');
        dom.modalInput.setAttribute('placeholder', getText('modal_import_placeholder'));
        dom.modalFileContainer.style.display = 'block';
    } else if (mode === 'epg') {
        dom.modalTitle.textContent = getText('modal_epg_title');
        dom.modalInput.setAttribute('placeholder', getText('modal_epg_placeholder'));
        // Autofill existing EPG if available
        const activePlaylist = state.playlists.find(p => p.id === state.activePlaylistId);
        if (activePlaylist && activePlaylist.epg_url) {
            dom.modalInput.value = activePlaylist.epg_url;
        }
    } else if (mode === 'rename') {
        dom.modalTitle.textContent = getText('modal_rename_title');
        dom.modalInput.setAttribute('placeholder', getText('modal_rename_placeholder'));
        const activePlaylist = state.playlists.find(p => p.id === state.activePlaylistId);
        if (activePlaylist) {
            dom.modalInput.value = activePlaylist.name;
        }
    }

    setTimeout(() => dom.modalInput.focus(), 150);
}

function closeModal() {
    dom.modalOverlay.style.display = 'none';
    dom.modalError.style.display = 'none';
    dom.modalFileInput.value = '';
    dom.fileUploadText.textContent = getText('file_upload_select');
}

async function handleModalSubmit() {
    let res;
    let data;

    dom.modalOk.disabled = true;
    dom.modalOk.textContent = getText('btn_ok_loading');

    try {
        if (state.modalMode === 'import') {
            const file = dom.modalFileInput.files[0];
            if (file) {
                const formData = new FormData();
                formData.append('file', file);
                res = await fetch(`/api/import/file?lang=${state.currentLang}`, {
                    method: 'POST',
                    body: formData
                });
            } else {
                const value = dom.modalInput.value.trim();
                if (!value) throw new Error(getText('toast_import_error') + ': URL or file is required');
                res = await fetch(`/api/import?m3u_url=${encodeURIComponent(value)}&lang=${state.currentLang}`, { method: 'POST' });
            }
            data = await res.json();
            if (!res.ok) throw new Error(data.detail || getText('toast_import_error'));
            
            toast(data.message, 'success');
            state.activePlaylistId = data.playlist_id;
            await loadPlaylists();
            closeModal();
        } else {
            const value = dom.modalInput.value.trim();
            if (!value) {
                throw new Error('Please enter a valid value');
            }
            
            if (state.modalMode === 'epg') {
                res = await fetch(`/api/playlists/${state.activePlaylistId}/epg?epg_url=${encodeURIComponent(value)}&lang=${state.currentLang}`, { method: 'POST' });
                data = await res.json();
                if (!res.ok) throw new Error(data.detail || 'Failed to update EPG');
                
                toast(data.message, 'success');
                closeModal();
                await loadPlaylists();
                
                setTimeout(async () => {
                    if (state.activePlaylistId) {
                        await loadChannels(state.activePlaylistId);
                    }
                }, 4000);
            } else if (state.modalMode === 'rename') {
                res = await fetch(`/api/playlists/${state.activePlaylistId}/rename?new_name=${encodeURIComponent(value)}&lang=${state.currentLang}`, { method: 'PUT' });
                data = await res.json();
                if (!res.ok) throw new Error(data.detail || 'Failed to rename playlist');
                
                toast(data.message, 'success');
                await loadPlaylists();
                closeModal();
            }
        }
    } catch (e) {
        dom.modalError.textContent = e.message;
        dom.modalError.style.display = 'block';
    } finally {
        dom.modalOk.disabled = false;
        dom.modalOk.textContent = getText('btn_ok');
    }
}

// ═══════════════════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════════════════

function setupEventListeners() {
    // Import modal trigger
    dom.btnAdd.onclick = () => openModal('import');

    // Playlist selector action triggers
    dom.btnRename.onclick = () => {
        if (!state.activePlaylistId) return;
        openModal('rename');
    };

    dom.btnEpg.onclick = () => {
        if (!state.activePlaylistId) return;
        openModal('epg');
    };

    dom.btnDeletePlaylist.onclick = async () => {
        if (!state.activePlaylistId) return;
        if (!confirm(getText('toast_delete_confirm'))) return;

        try {
            const res = await fetch(`/api/playlists/${state.activePlaylistId}?lang=${state.currentLang}`, { method: 'DELETE' });
            const data = await res.json();
            toast(data.message, 'success');
            state.activePlaylistId = '';
            await loadPlaylists();
        } catch (e) {
            toast(e.message, 'error');
        }
    };

    // Channel Scanner
    dom.btnScan.onclick = async () => {
        if (!state.activePlaylistId) return;
        
        toast(getText('toast_scan_start'), 'info');
        dom.btnScan.disabled = true;

        try {
            const res = await fetch(`/api/scan?playlist_id=${state.activePlaylistId}&lang=${state.currentLang}`, { method: 'POST' });
            const data = await res.json();
            toast(data.message, 'success');
            await loadChannels(state.activePlaylistId);
        } catch (e) {
            toast(e.message, 'error');
        } finally {
            dom.btnScan.disabled = false;
        }
    };

    // Playlist Sync
    dom.btnSync.onclick = async () => {
        if (!state.activePlaylistId) return;
        
        toast(getText('btn_ok_loading'), 'info');
        dom.btnSync.disabled = true;
        
        try {
            const res = await fetch(`/api/playlists/${state.activePlaylistId}/sync?lang=${state.currentLang}`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Failed to sync');
            
            toast(data.message, 'success');
            await loadPlaylists();
        } catch (e) {
            toast(e.message, 'error');
        } finally {
            dom.btnSync.disabled = false;
        }
    };

    // Modal events
    dom.modalCancel.onclick = closeModal;
    dom.modalOverlay.onclick = (e) => {
        if (e.target === dom.modalOverlay) closeModal();
    };
    dom.modalInput.onkeydown = (e) => {
        if (e.key === 'Enter') handleModalSubmit();
        if (e.key === 'Escape') closeModal();
    };
    dom.modalInput.oninput = () => {
        if (dom.modalInput.value.trim()) {
            dom.modalFileInput.value = '';
            dom.fileUploadText.textContent = getText('file_upload_select');
        }
    };
    dom.modalFileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            dom.fileUploadText.textContent = file.name;
            dom.modalInput.value = '';
        } else {
            dom.fileUploadText.textContent = getText('file_upload_select');
        }
    };
    dom.modalOk.onclick = handleModalSubmit;

    // Playlist select change
    dom.playlistSelect.onchange = (e) => {
        state.activePlaylistId = e.target.value;
        if (state.activePlaylistId) {
            localStorage.setItem('iptv_active_playlist_id', state.activePlaylistId);
            loadChannels(state.activePlaylistId);
            updatePlaylistActionsUI();
            autoSyncPlaylist(state.activePlaylistId);
        }
    };

    // Playlist Menu Context Dropdown Toggle
    dom.btnPlaylistMenu.onclick = (e) => {
        e.stopPropagation();
        const isShown = dom.playlistMenu.style.display === 'flex';
        dom.playlistMenu.style.display = isShown ? 'none' : 'flex';
    };

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
        if (dom.playlistMenu && dom.playlistMenu.style.display === 'flex') {
            if (!dom.playlistMenu.contains(e.target) && e.target !== dom.btnPlaylistMenu) {
                dom.playlistMenu.style.display = 'none';
            }
        }
    });

    // Close menu when a menu item is clicked
    $$('.playlist-menu .menu-item').forEach(btn => {
        btn.addEventListener('click', () => {
            dom.playlistMenu.style.display = 'none';
        });
    });

    // Search input
    dom.searchInput.oninput = () => filterAndRender();

    // Player controls events
    dom.btnRetry.onclick = () => {
        if (state.currentChannel) playChannel(state.currentChannel);
    };

    dom.btnPlay.onclick = togglePlay;
    dom.video.onclick = togglePlay;

    dom.video.addEventListener('play', () => {
        dom.iconPlay.style.display = 'none';
        dom.iconPause.style.display = 'block';
    });

    dom.video.addEventListener('pause', () => {
        dom.iconPlay.style.display = 'block';
        dom.iconPause.style.display = 'none';
    });

    // Mute/volume
    dom.btnMute.onclick = () => {
        dom.video.muted = !dom.video.muted;
        if (!dom.video.muted && dom.video.volume === 0) {
            dom.video.volume = 1;
            dom.volumeSlider.value = 1;
        }
        syncVolumeUI();
    };

    dom.volumeSlider.oninput = (e) => {
        dom.video.volume = parseFloat(e.target.value);
        dom.video.muted = dom.video.volume === 0;
        syncVolumeUI();
    };

    // Picture-in-Picture
    if ('pictureInPictureEnabled' in document) {
        dom.btnPip.onclick = async () => {
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else if (dom.video.readyState >= 2) {
                    await dom.video.requestPictureInPicture();
                }
            } catch (err) {
                console.error(err);
                toast('Picture-in-Picture failed', 'error');
            }
        };
    } else if (dom.btnPip) {
        dom.btnPip.style.display = 'none';
    }

    // Fullscreen
    dom.btnFullscreen.onclick = () => {
        if (window.pywebview && window.pywebview.api) {
            window.pywebview.api.toggle_fullscreen();
        } else {
            if (!document.fullscreenElement) {
                dom.playerContainer.requestFullscreen?.() ||
                dom.playerContainer.webkitRequestFullscreen?.();
            } else {
                document.exitFullscreen?.();
            }
        }
    };

    // Download segment/video
    dom.btnDownload.onclick = async () => {
        if (!state.currentChannel) return;
        const isRec = state.activeRecordings.includes(state.currentChannel.url);
        
        if (isRec) {
            // Stop recording
            try {
                const res = await fetch('/api/record/stop', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ url: state.currentChannel.url })
                });
                const data = await res.json();
                toast(data.message, data.status === 'success' ? 'success' : 'error');
                if (data.status === 'success') {
                    state.activeRecordings = state.activeRecordings.filter(u => u !== state.currentChannel.url);
                    updateRecordButtonUI();
                }
            } catch(e) {
                toast('Error stopping recording', 'error');
            }
        } else {
            // Start recording
            try {
                const res = await fetch('/api/record/start', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ 
                        url: state.currentChannel.url,
                        channel_name: state.currentChannel.name 
                    })
                });
                const data = await res.json();
                toast(data.message, data.status === 'success' ? 'info' : 'error');
                if (data.status === 'success') {
                    state.activeRecordings.push(state.currentChannel.url);
                    updateRecordButtonUI();
                }
            } catch(e) {
                toast('Error starting recording', 'error');
            }
        }
    };

    // Settings Panel toggle
    dom.btnSettings.onclick = (e) => {
        e.stopPropagation();
        const show = dom.settingsPanel.style.display === 'none';
        dom.settingsPanel.style.display = show ? 'flex' : 'none';
    };

    document.addEventListener('click', (e) => {
        if (!dom.settingsPanel.contains(e.target) && e.target !== dom.btnSettings) {
            dom.settingsPanel.style.display = 'none';
        }
    });

    // Video Seek updates
    dom.video.addEventListener('timeupdate', updateTimelineUI);
    dom.video.addEventListener('progress', updateTimelineUI);

    dom.timelineSlider.oninput = (e) => {
        if (dom.video.duration && dom.video.duration !== Infinity) {
            dom.video.currentTime = parseFloat(e.target.value);
        }
    };

    // Auto-hide controls bar on mouse idle
    let hideTimer;
    const showControls = () => {
        if (!state.currentChannel) return;
        dom.controlsBar.style.opacity = '1';
        dom.controlsBar.style.transform = 'translateY(0)';
        clearTimeout(hideTimer);
        if (!dom.video.paused) {
            hideTimer = setTimeout(() => {
                if (!dom.controlsBar.matches(':hover') && dom.settingsPanel.style.display === 'none') {
                    dom.controlsBar.style.opacity = '0';
                    dom.controlsBar.style.transform = 'translateY(6px)';
                }
            }, 2500);
        }
    };

    dom.playerContainer.addEventListener('mousemove', showControls);
    dom.playerContainer.addEventListener('mouseleave', () => {
        if (!state.currentChannel) return;
        clearTimeout(hideTimer);
        dom.controlsBar.style.opacity = '0';
        dom.controlsBar.style.transform = 'translateY(6px)';
    });

    // Hotkey triggers
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                togglePlay();
                break;
            case 'f':
                dom.btnFullscreen.click();
                break;
            case 'm':
                dom.btnMute.click();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (dom.video.duration && dom.video.duration !== Infinity) {
                    dom.video.currentTime = Math.max(0, dom.video.currentTime - 5);
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                if (dom.video.duration && dom.video.duration !== Infinity) {
                    dom.video.currentTime = Math.min(dom.video.duration, dom.video.currentTime + 5);
                }
                break;
            case 'ArrowUp':
                e.preventDefault();
                dom.video.muted = false;
                dom.video.volume = Math.min(1.0, dom.video.volume + 0.05);
                dom.volumeSlider.value = dom.video.volume;
                syncVolumeUI();
                break;
            case 'ArrowDown':
                e.preventDefault();
                dom.video.volume = Math.max(0.0, dom.video.volume - 0.05);
                dom.video.muted = dom.video.volume === 0;
                dom.volumeSlider.value = dom.video.volume;
                syncVolumeUI();
                break;
            case 'Escape':
                if (dom.modalOverlay.style.display !== 'none') {
                    closeModal();
                }
                break;
        }
    });
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function togglePlay() {
    if (dom.video.paused) {
        dom.video.play().catch(() => {});
    } else {
        dom.video.pause();
    }
}

function syncVolumeUI() {
    const muted = dom.video.muted || dom.video.volume === 0;
    dom.iconVol.style.display = muted ? 'none' : 'block';
    dom.iconMuted.style.display = muted ? 'block' : 'none';
    const volVal = muted ? 0 : dom.video.volume;
    dom.volumeSlider.value = volVal;
    dom.volumeSlider.style.setProperty('--vol', (volVal * 100) + '%');
}

function formatTime(seconds) {
    if (isNaN(seconds) || seconds === Infinity) return "--:--";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatEpochTime(epoch) {
    if (!epoch) return "--:--";
    const d = new Date(epoch * 1000);
    const hrs = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    return `${hrs}:${mins}`;
}

function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

let toastTimer;
function toast(message, type = 'info') {
    dom.toast.textContent = message;
    dom.toast.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        dom.toast.classList.remove('show');
    }, 2500);
}

// Auto-update EPG titles on the sidebar every 30 seconds
setInterval(() => {
    if (state.channels.length > 0) {
        renderChannels();
    }
}, 30000);

function enableWheelScroll(el) {
    if (!el) return;
    el.addEventListener('wheel', (e) => {
        if (e.deltaY !== 0) {
            e.preventDefault();
            el.scrollLeft += e.deltaY;
        }
    }, { passive: false });
}
