/**
 * IPTV v2 — Frontend Controller
 * Complete features with zero hardcoded text, client-side i18n, EPG, scanner, seek timeline, and settings.
 */

// ═══════════════════════════════════════════════════════════════════
// DOM Elements
// ═══════════════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
let activeMediaRecorder = null;

const dom = {
    video:              $('#video'),
    youtubePlayer:      $('#youtube-player'),
    playerContainer:    $('#player-container'),
    playerWelcome:      $('#player-welcome'),
    playerLoader:       $('#player-loader'),
    loaderPercent:      $('#loader-percent'),
    playerError:        $('#player-error'),
    errorMsg:           $('#error-msg'),
    btnRetry:           $('#btn-retry'),

    channelList:        $('#channel-list'),
    channelListContainer:$('#channel-list-container'),
    recordingsListContainer: $('#recordings-list-container'),
    recordingsList:     $('#recordings-list'),
    logo:               $('#app-logo'),
    btnTabBg:           $('#btn-tab-bg'),
    btnTabSession:      $('#btn-tab-session'),
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
    
    btnBgRecord:        $('#btn-bg-record'),
    bgRecordText:       $('#bg-record-text'),
};

// ═══════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════


window.playerConfig = { aspectRatio: 'auto', bufferSize: 'normal', autoplayLast: false, autoScanEnabled: true, lastChannel: null };
window.userConfig = { language: 'en', favorites: [], activePlaylistId: null };

let isAppLoading = true;
let scanIntervalId = null;

const debounceTimers = {};
function saveKVSetting(key, data) {
    console.log("[Guard Check] saveKVSetting triggered. isAppLoading =", isAppLoading, "key =", key);
    if (isAppLoading) return;
    clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(async () => {
        try {
            const res = await fetch(`/api/settings/kv/${key}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        } catch(e) {
            console.error(`[saveKVSetting] Failed to persist ${key}:`, e);
        }
    }, 500);
}

function updatePlayerConfig(updates) {
    Object.assign(window.playerConfig, updates);
    saveKVSetting('player_config', window.playerConfig);
}

function updateUserConfig(updates) {
    Object.assign(window.userConfig, updates);
    saveKVSetting('user_config', window.userConfig);
}

let state = {
    accountType: null,
    isScanning: false,
    isManualScanning: false,
    queuedIds: new Set(),
    scanningIds: new Set(),
    playlists: [],
    activePlaylistId: '',
    channels: [],
    filteredChannels: [],
    activeGroup: '',
    currentChannel: null,
    activeChannelId: null,
    hls: null,
    langKeys: {},
    currentLang: 'vi', // Default language
    modalMode: '', // 'import', 'epg', 'rename'
    recordedSegments: [],
    currentLoadingChannelId: null,
    transcodeMemoryMap: JSON.parse(localStorage.getItem('transcode_memory_map') || '{}'),
    prewarmedSessionId: null,
    prewarmedChannelId: null,
    prewarmedUrl: null,
    prewarmEvictionTimer: null,
    prewarmDebounceTimer: null,
    playbackWatchdog: null,
    isDirect: false,
    isPlaybackMode: false,
    directUrl: '',
    retryCount: 0,
    favorites: window.userConfig.favorites,
    activeRecordings: [],
    recordedSegments: [],
    username: '',
    displayName: 'User',
    avatar: ''
};

function updateUserUI() {
    const dashUsername = document.getElementById('dash-username');
    const dashAvatar = document.getElementById('dash-avatar');
    
    const nameToDisplay = state.displayName || (state.user && state.user.display_name) || state.username || 'Guest';
    
    if (dashUsername) dashUsername.textContent = nameToDisplay;
    
    if (dashAvatar) {
        const currentAvatar = state.avatar || (state.user && state.user.avatar);
        if (currentAvatar) {
            dashAvatar.innerHTML = `<img src="${currentAvatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
        } else {
            dashAvatar.innerHTML = nameToDisplay.charAt(0).toUpperCase();
        }
    }
    
    const profUsername = document.getElementById('profile-username');
    if (profUsername) profUsername.textContent = nameToDisplay;
    
    const profType = document.getElementById('profile-type');
    if (profType) {
        const currentAccountType = state.accountType || (state.user && state.user.account_type) || 'guest';
        profType.textContent = 'Role: ' + (currentAccountType === 'guest' ? 'GUEST' : 'ACCOUNT');
    }
}

function applyAspectRatio(mode) {
    const video = document.getElementById('video');
    if (!video) return;
    // Remove all ar-* classes
    video.classList.remove('ar-auto', 'ar-16-9', 'ar-4-3', 'ar-stretch', 'ar-zoom');
    const classMap = {
        'auto':    'ar-auto',
        '16:9':    'ar-16-9',
        '4:3':     'ar-4-3',
        'stretch': 'ar-stretch',
        'zoom':    'ar-zoom'
    };
    video.classList.add(classMap[mode] || 'ar-auto');
}

function getHlsBufferConfig() {
    const mode = window.playerConfig.bufferSize || 'normal';
    switch (mode) {
        case 'low':
            return {
                lowLatencyMode: true,
                maxBufferLength: 2,
                maxMaxBufferLength: 5,
                maxBufferSize: 5 * 1000 * 1000,
                backBufferLength: 5,
                liveSyncDuration: 2,
                liveMaxLatencyDuration: 5,
                startFragPrefetch: true,
            };
        case 'large':
            return {
                lowLatencyMode: false,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                maxBufferSize: 60 * 1000 * 1000,
                backBufferLength: 15,
                startFragPrefetch: true,
            };
        default: // normal
            return {
                lowLatencyMode: false,
                maxBufferLength: 20,
                maxMaxBufferLength: 30,
                maxBufferSize: 30 * 1000 * 1000,
                backBufferLength: 10,
                startFragPrefetch: true,
            };
    }
}

const virtualScroll = {
    itemHeight: 64, // Estimate 64px per item
    overscan: 10,
    totalCount: 0,
    lastStartIndex: -1,
    limit: 35,
    isFetching: false,
    abortController: null,
    searchTimeout: null,
    spacer: dom.channelList.querySelector('#virtual-spacer'),
    container: dom.channelList.querySelector('#virtual-container')
};

let lastRecordingsStr = '[]';
// Poll backend recording status
setInterval(async () => {
    try {
        const res = await fetch('/api/record/status');
        const data = await res.json();
        state.activeRecordings = data.active_urls || [];
        const newStr = JSON.stringify(state.activeRecordings);
        if (newStr !== lastRecordingsStr) {
            lastRecordingsStr = newStr;
            renderVirtualScroll(true);
        }
        updateRecordButtonUI();
    } catch(e) {}
}, 2000);

function updateRecordButtonUI() {
    if (dom.btnBgRecord) {
        dom.btnBgRecord.style.display = 'none';
        dom.btnBgRecord.remove();
        dom.btnBgRecord = null;
    }
    const bgRecordSection = document.getElementById('section-bg-record'); 
    if (bgRecordSection) {
        bgRecordSection.style.display = 'none';
        bgRecordSection.remove();
    }

    if (!state.currentChannel) return;
    const isRec = state.activeRecordings.includes(state.currentChannel.url);
    if (isRec) {
        dom.playerContainer.classList.add('is-recording');
    } else {
        dom.playerContainer.classList.remove('is-recording');
    }

    if (dom.btnDownload) {
        if (isRec) {
            dom.btnDownload.style.background = 'rgba(239, 68, 68, 0.1)';
            dom.btnDownload.style.color = '#ef4444';
            dom.btnDownload.style.border = '1px solid #ef4444';
        } else {
            dom.btnDownload.style.background = '';
            dom.btnDownload.style.color = '';
            dom.btnDownload.style.border = '';
        }
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
    updateUserConfig({favorites: state.favorites});
    if (state.activeGroup === 'Favorites' && state.favorites.length === 0) {
        state.activeGroup = '';
        updateChipStyles();
        reloadChannelCount();
    } else {
        renderVirtualScroll(true);
    }
};

let currentRecordingsTab = 'background'; // 'background' or 'session'
let allRecordings = [];

async function loadRecordings() {
    dom.recordingsList.innerHTML = '<div style="text-align:center; padding:20px;"><div class="spinner" style="margin:0 auto;"></div></div>';
    try {
        const res = await fetch('/api/recordings');
        const data = await res.json();
        if (data.status === 'success') {
            allRecordings = data.data;
            renderRecordingsList();
        } else {
            dom.recordingsList.innerHTML = `<div style="color:var(--error); padding:20px;">Error: ${data.message}</div>`;
        }
    } catch(e) {
        dom.recordingsList.innerHTML = '<div style="color:var(--error); padding:20px;">Server connection error</div>';
    }
}

function renderRecordingsList() {
    const query = (dom.searchInput.value || '').toLowerCase().trim();
    let items = allRecordings;
    
    if (query) {
        items = items.filter(r => r.filename.toLowerCase().includes(query) || r.channel_name.toLowerCase().includes(query));
    }
    
    if (items.length === 0) {
        dom.recordingsList.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-muted); font-size: 13px;" data-i18n="recordings_empty">No recordings found</div>';
        return;
    }
    
    let html = '';
    for (let r of items) {
        const date = new Date(r.start_time * 1000).toLocaleString();
        html += `
            <div class="recording-item" data-id="${r.id}" data-filename="${r.filename}" style="background: var(--bg-elevated); padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); display: flex; flex-direction: column; gap: 8px; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='var(--bg-elevated)'">
                <div style="display:flex; justify-content: space-between; align-items:flex-start;">
                    <div style="flex:1; min-width:0;">
                        <div style="font-weight: 600; font-size: 13px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${r.filename}">${r.filename}</div>
                        <div style="font-size: 11px; color: var(--text-secondary); margin-top:2px;"><span data-i18n="recordings_channel">Channel:</span> ${r.channel_name}</div>
                    </div>
                    <button class="btn-rename-rec" data-id="${r.id}" data-name="${r.filename}" style="background:transparent; border:none; cursor:pointer; color: var(--text-muted); padding:4px;" title="Rename">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                    </button>
                </div>
                <div style="display:flex; justify-content: space-between; align-items:center; font-size: 11px; color: var(--text-muted);">
                    <span>${date}</span>
                    <div style="display:flex; gap:8px;">
                        <span>${r.duration}</span>
                        <span>•</span>
                        <span>${r.size}</span>
                    </div>
                </div>
            </div>
        `;
    }
    dom.recordingsList.innerHTML = html;
    
    // Add playback events
    dom.recordingsList.querySelectorAll('.recording-item').forEach(item => {
        item.onclick = (e) => {
            if (e.target.closest('.btn-rename-rec')) return; // Ignore if clicked on rename button
            const id = item.getAttribute('data-id');
            const filename = item.getAttribute('data-filename');
            const playUrl = `/api/recordings/play/${id}${appToken ? `?token=${appToken}` : ''}`;
            
            // Set current channel to fake channel for player
            const fakeCh = { name: filename, url: playUrl, id: id, uniqueId: 'rec_' + id };
            state.currentChannel = fakeCh;
            state.activeChannelId = fakeCh.uniqueId;
            
            // UI Updates
            dom.playerContainer.dataset.mode = 'record';
            dom.playerWelcome.style.display = 'none';
            dom.playerError.style.display = 'none';
            dom.playerLoader.style.display = 'flex';
            dom.playerContainer.classList.add('active-player');
            dom.nowPlaying.textContent = getText('now_playing', { name: filename });
            
            destroyHls();
            
            startPlayback(playUrl, state.currentChannel, false, true);
        };
    });
    
    // Add rename events
    dom.recordingsList.querySelectorAll('.btn-rename-rec').forEach(btn => {
        btn.onclick = async () => {
            const id = btn.getAttribute('data-id');
            const oldName = btn.getAttribute('data-name');
            openModal('rename_recording', { id: id, oldName: oldName });
        };
    });
}

// User Dashboard Logic
if (dom.logo) {
    dom.logo.onclick = () => {
        const userDashboard = document.getElementById('user-dashboard');
        const dashAccountType = document.getElementById('dash-account-type');
        
        if (userDashboard) {
            userDashboard.style.display = 'flex';
            
            // Invoke the universal UI updater to correctly bind displayName and avatar image without clobbering
            updateUserUI();
            
            // Standardize account badge text for the new functional access roles
            if (dashAccountType) {
                const roleText = (state.accountType === 'account') ? 'ACCOUNT' : 'GUEST';
                dashAccountType.textContent = roleText;
                dashAccountType.className = `account-badge badge-${(state.accountType || 'guest').toLowerCase()}`;
            }
            
            if (state.accountType === 'account') {
                const menuUpgrade = document.getElementById('menu-upgrade');
                if (menuUpgrade) menuUpgrade.style.display = 'none';
            }
        }
    };
}

const btnCloseDashboard = document.getElementById('btn-close-dashboard');
if (btnCloseDashboard) {
    btnCloseDashboard.onclick = () => {
        document.getElementById('user-dashboard').style.display = 'none';
    };
}

const dashMenus = document.querySelectorAll('.dashboard-menu li[data-target]');
const dashPanels = document.querySelectorAll('.dashboard-panel');

dashMenus.forEach(menu => {
    menu.onclick = () => {
        dashMenus.forEach(m => m.classList.remove('active'));
        dashPanels.forEach(p => p.classList.remove('active'));
        menu.classList.add('active');
        document.getElementById(menu.getAttribute('data-target')).classList.add('active');
    };
});

const btnLogout = document.getElementById('btn-logout');
if (btnLogout) {
    btnLogout.onclick = async () => {
        try {
            // Physically wipe the session file on the system drive before resetting state
            await fetch('/api/logout', { method: 'POST' });
        } catch(e) {
            console.error("Failed to cleanly wipe session data from disk:", e);
        }
        state.username = null;
        state.accountType = 'guest';
        location.reload();
    };
}

const btnChangePassword = document.getElementById('btn-change-password');
if (btnChangePassword) {
    btnChangePassword.onclick = async () => {
        const oldP = document.getElementById('old-password').value;
        const newP = document.getElementById('new-password').value;
        const confP = document.getElementById('confirm-password').value;
        
        if (!oldP || !newP || !confP) {
            toast('Please fill all fields', 'error');
            return;
        }
        if (newP !== confP) {
            toast('New passwords do not match', 'error');
            return;
        }
        
        try {
            const res = await fetch('/api/user/password', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    username: state.username,
                    old_password: oldP,
                    new_password: newP
                })
            });
            const data = await res.json();
            if (data.status === 'success') {
                toast('Password updated successfully', 'success');
                document.getElementById('old-password').value = '';
                document.getElementById('new-password').value = '';
                document.getElementById('confirm-password').value = '';
            } else {
                toast(data.message || 'Error updating password', 'error');
            }
        } catch(e) {
            toast('Connection error', 'error');
        }
    };
}

const btnOpenRecordings = document.getElementById('btn-open-recordings');
if (btnOpenRecordings) {
    btnOpenRecordings.onclick = () => {
        if (dom.playlistMenu) dom.playlistMenu.style.display = 'none';
        dom.channelListContainer.style.display = 'none';
        if (dom.playlistBar) dom.playlistBar.style.display = 'none';
        if (dom.groupBar) dom.groupBar.style.display = 'none';
        if (dom.btnAdd) dom.btnAdd.style.display = 'none';
        dom.recordingsListContainer.style.display = 'flex';
        dom.searchInput.placeholder = 'Search recordings...';
        dom.searchInput.value = '';
        loadRecordings();
    };
}

const btnBackChannels = document.getElementById('btn-back-channels');
if (btnBackChannels) {
    btnBackChannels.onclick = () => {
        dom.recordingsListContainer.style.display = 'none';
        dom.channelListContainer.style.display = 'flex';
        if (dom.btnAdd) dom.btnAdd.style.display = '';
        dom.searchInput.placeholder = 'Search channels...';
        dom.searchInput.value = '';
        
        // Strict state alignment back to live playlist
        if (state.activePlaylistId) {
            if (dom.playlistSelect) dom.playlistSelect.value = state.activePlaylistId;
            loadChannels(state.activePlaylistId);
        } else {
            renderPlaylistSelector();
            renderGroups();
            reloadChannelCount();
        }
    };
}

if (dom.btnTabBg) {
    dom.btnTabBg.onclick = () => {
        currentRecordingsTab = 'background';
        dom.btnTabBg.style.background = 'rgba(99,102,241,0.2)';
        dom.btnTabBg.style.color = '#818cf8';
        dom.btnTabBg.style.borderColor = 'rgba(99,102,241,0.3)';
        dom.btnTabSession.style.background = 'transparent';
        dom.btnTabSession.style.color = 'var(--text-primary)';
        dom.btnTabSession.style.borderColor = 'rgba(255,255,255,0.1)';
        renderRecordingsList();
    };
}

if (dom.btnTabSession) {
    dom.btnTabSession.onclick = () => {
        currentRecordingsTab = 'session';
        dom.btnTabSession.style.background = 'rgba(99,102,241,0.2)';
        dom.btnTabSession.style.color = '#818cf8';
        dom.btnTabSession.style.borderColor = 'rgba(99,102,241,0.3)';
        dom.btnTabBg.style.background = 'transparent';
        dom.btnTabBg.style.color = 'var(--text-primary)';
        dom.btnTabBg.style.borderColor = 'rgba(255,255,255,0.1)';
        renderRecordingsList();
    };
}


// ═══════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════

let appToken = '';
let isAppReady = false;

const originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
    if (typeof url === 'string' && url.startsWith('/api/')) {
        options.headers = options.headers || {};
        if (appToken) options.headers['X-App-Token'] = appToken;
    } else if (url instanceof Request && url.url.includes('/api/')) {
        url.headers.set('X-App-Token', appToken);
    }
    return originalFetch.call(this, url, options);
};

async function initApp() {
    console.log("[Init] Starting app initialization...");
    if (isAppReady) return;
    isAppReady = true;

    try {
        const hevcSupported = (typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function')
            ? MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')
            : false;
        console.log("[HEVC Support Check] Browser reports HEVC support:", hevcSupported);
    } catch (e) {
        console.error("[HEVC Support Check] Error querying support:", e);
    }

    // State defaults from global config (hydration happens at end of initApp)
    state.favorites = window.userConfig.favorites || [];
    state.activePlaylistId = window.userConfig.activePlaylistId || null;

    if (window.pywebview && window.pywebview.api && window.pywebview.api.get_token) {
        try {
            appToken = await window.pywebview.api.get_token();
        } catch(e) {
            console.error("Failed to fetch token", e);
        }
    }

    const initialLang = 'en';
    await loadLanguage(initialLang);

    // Delaying isAppLoading release to end of initApp

    initCustomDropdowns();
    // Login overlay handling
    const loginOverlay = document.getElementById('login-overlay');
    const loginUsernameInput = document.getElementById('login-username');
    const loginPasswordInput = document.getElementById('login-password');
    const btnLogin = document.getElementById('btn-login');
    const loginError = document.getElementById('login-error');
    
    const handleSuccessfulLogin = async (data, username) => {
        state.accountType = data.type; // 'free' or 'pro'
        state.username = username;
        state.displayName = data.display_name || username;
        state.avatar = data.avatar || '';
        
        // Persist to local storage
        
        
        
        
        updateUserUI();
        
        if (dom.btnBgRecord) {
            dom.btnBgRecord.style.display = 'none';
            dom.btnBgRecord.remove();
            dom.btnBgRecord = null;
        }
        const bgRecordSection = document.getElementById('section-bg-record'); 
        if (bgRecordSection) {
            bgRecordSection.style.display = 'none';
            bgRecordSection.remove();
        }
        if (dom.btnTabBg) {
            dom.btnTabBg.style.display = 'none';
            if (dom.btnTabBg.parentElement) dom.btnTabBg.parentElement.style.display = 'none';
        }
        if (dom.btnTabSession) dom.btnTabSession.style.display = 'none';
        
        if (state.accountType === 'guest') {
            if (dom.btnSettings) dom.btnSettings.style.display = 'inline-flex';
            
            try {
                const statusRes = await fetch('/api/guest/status');
                const statusData = await statusRes.json();
                
                if (!statusData.is_activated) {
                    const blocker = document.createElement('div');
                    blocker.id = 'guest-activation-overlay';
                    blocker.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(7, 9, 14, 0.85); backdrop-filter: blur(15px); z-index: 999999; display: flex; align-items: center; justify-content: center; flex-direction: column;';
                    
                    blocker.innerHTML = `
                        <div style="background: var(--bg-surface); padding: 30px; border-radius: 12px; width: 400px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1);">
                            <h2 style="margin-bottom: 20px; font-weight: 600; font-size: 1.5rem; color: #fff;">Activate License</h2>
                            <p id="guest-activation-warning" style="margin-bottom: 20px; color: var(--text-secondary); font-size: 0.9rem;">
                                Please enter your activation code.
                            </p>
                            <input type="text" id="guest-activation-code" placeholder="Enter activation code" style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.3); color: white; margin-bottom: 20px; outline: none;" />
                            <div style="display: flex; gap: 10px;">
                                <button id="guest-btn-quit" style="flex: 1; padding: 12px; border-radius: 8px; background: rgba(255,255,255,0.1); border: none; color: white; cursor: pointer; font-weight: 600;">Quit</button>
                                <button id="guest-btn-ok" style="flex: 1; padding: 12px; border-radius: 8px; background: #6366f1; border: none; color: white; cursor: pointer; font-weight: 600; box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);">OK</button>
                            </div>
                        </div>
                    `;
                    document.body.appendChild(blocker);
                    
                    const blockEsc = (e) => {
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                        }
                    };
                    window.addEventListener('keydown', blockEsc, true);
                    
                    const btnQuit = document.getElementById('guest-btn-quit');
                    const btnOk = document.getElementById('guest-btn-ok');
                    const inputCode = document.getElementById('guest-activation-code');
                    const warningText = document.getElementById('guest-activation-warning');
                    
                    btnQuit.onclick = () => {
                        if (window.pywebview && window.pywebview.api) {
                            window.pywebview.api.terminate_application();
                        } else {
                            window.close();
                        }
                    };
                    
                    let lockoutInterval;
                    const setLockoutTimer = (lockoutUntil) => {
                        btnOk.disabled = true;
                        inputCode.disabled = true;
                        btnOk.style.opacity = '0.5';
                        const updateTimer = () => {
                            const now = Math.floor(Date.now() / 1000);
                            const rem = lockoutUntil - now;
                            if (rem <= 0) {
                                clearInterval(lockoutInterval);
                                warningText.innerText = 'Please enter your activation code.';
                                warningText.style.color = "var(--text-secondary)";
                                btnOk.disabled = false;
                                inputCode.disabled = false;
                                btnOk.style.opacity = '1';
                            } else {
                                const m = String(Math.floor(rem / 60)).padStart(2, '0');
                                const s = String(rem % 60).padStart(2, '0');
                                warningText.innerText = `Try again in ${m}:${s}`;
                            }
                        };
                        updateTimer();
                        lockoutInterval = setInterval(updateTimer, 1000);
                    };
                    
                    if (statusData.lockout_until) {
                        setLockoutTimer(statusData.lockout_until);
                    }
                    
                    btnOk.onclick = async () => {
                        if (btnOk.disabled) return;
                        
                        btnOk.disabled = true;
                        const originalText = btnOk.textContent;
                        btnOk.textContent = 'Checking...';
                        
                        try {
                            const vRes = await fetch('/api/guest/verify-code', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({code: inputCode.value.trim()})
                            });
                            const vData = await vRes.json();
                            if (vData.status === 'success') {
                                document.body.removeChild(blocker);
                                window.removeEventListener('keydown', blockEsc, true);
                                const guestDaysEl = document.getElementById('guest-days-remaining');
                                if (guestDaysEl) {
                                    guestDaysEl.style.display = 'block';
                                    state.guestExpiryDate = vData.expiry_date;
                                    guestDaysEl.innerText = `Expiry Date: ${state.guestExpiryDate}`;
                                }
                            } else {
                                warningText.innerText = vData.message || vData.detail || "Invalid code.";
                                warningText.style.color = "#ef4444";
                                
                                if (vData.lockout_until) {
                                    btnOk.textContent = originalText;
                                    setLockoutTimer(vData.lockout_until);
                                } else {
                                    btnOk.disabled = false;
                                    btnOk.textContent = originalText;
                                }
                            }
                        } catch(e) {
                            warningText.innerText = "Connection error.";
                            warningText.style.color = "#ef4444";
                            btnOk.disabled = false;
                            btnOk.textContent = originalText;
                        }
                    };
                } else if (statusData.is_activated) {
                    state.guestDaysRemaining = statusData.days_remaining;
                    const guestDaysEl = document.getElementById('guest-days-remaining');
                    if (guestDaysEl) {
                        guestDaysEl.style.display = 'block';
                        state.guestExpiryDate = statusData.expiry_date;
                        guestDaysEl.innerText = `Expiry Date: ${state.guestExpiryDate}`;
                    }
                }
            } catch(e) {}
        }
        
        // Hide overlay, show app
        loginOverlay.style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        
        // Load data
        await loadPlaylists();
        setupEventListeners();
        syncVolumeUI();
        
        // Dashboard settings logic
        
        // Fetch Network Settings
        try {
            const netRes = await fetch('/api/settings/network');
            const netData = await netRes.json();
            if (document.getElementById('dash-ua-input')) {
                document.getElementById('dash-ua-input').value = netData.user_agent || '';
            }
            if (document.getElementById('dash-proxy-input')) {
                document.getElementById('dash-proxy-input').value = netData.proxy || '';
            }
            if (document.getElementById('dash-scan-concurrency')) {
                const scanConcurrency = netData.scan_concurrency || 30;
                document.getElementById('dash-scan-concurrency').value = scanConcurrency;
                if (document.getElementById('dash-scan-concurrency-value')) {
                    document.getElementById('dash-scan-concurrency-value').textContent = scanConcurrency;
                }
            }
        } catch(e) {}

        const btnSaveNetwork = document.getElementById('btn-save-network');
        if (btnSaveNetwork) {
            btnSaveNetwork.onclick = async () => {
                const ua = document.getElementById('dash-ua-input').value.trim();
                const proxy = document.getElementById('dash-proxy-input').value.trim();
                let scanConcurrency = 30;
                if (document.getElementById('dash-scan-concurrency')) {
                    scanConcurrency = parseInt(document.getElementById('dash-scan-concurrency').value) || 30;
                }
                const originalText = btnSaveNetwork.textContent;
                btnSaveNetwork.textContent = "Saving...";
                btnSaveNetwork.disabled = true;
                try {
                    const res = await fetch('/api/settings/network', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({proxy: proxy, user_agent: ua, scan_concurrency: scanConcurrency})
                    });
                    const data = await res.json();
                    if (data.status === 'success') {
                        toast("Network settings saved successfully", "success");
                    } else {
                        toast("Error saving network settings", "error");
                    }
                } catch(e) {
                    toast("Connection error", "error");
                }
                btnSaveNetwork.textContent = originalText;
                btnSaveNetwork.disabled = false;
            };
        }

        const dashScanConcurrency = document.getElementById('dash-scan-concurrency');
        if (dashScanConcurrency) {
            dashScanConcurrency.addEventListener('input', (e) => {
                const val = e.target.value;
                const label = document.getElementById('dash-scan-concurrency-value');
                if (label) label.textContent = val;
            });
        }

        const autoPlaySwitch = document.getElementById('dash-autoplay-switch');
        if (autoPlaySwitch) {
            autoPlaySwitch.checked = window.playerConfig.autoplayLast === true;
            autoPlaySwitch.onchange = (e) => {
                updatePlayerConfig({autoplayLast: e.target.checked});
            };
        }
        
        fetch('/api/settings/kv/auto_scan_enabled').then(r => r.ok ? r.json() : {}).then(data => {
            if (data.value !== undefined) {
                window.playerConfig.autoScanEnabled = data.value === 'true';
            } else {
                window.playerConfig.autoScanEnabled = true;
            }
            const autoScanSwitch = document.getElementById('dash-autoscan-switch');
            if (autoScanSwitch) {
                autoScanSwitch.checked = window.playerConfig.autoScanEnabled;
                autoScanSwitch.onchange = (e) => {
                    window.playerConfig.autoScanEnabled = e.target.checked;
                    fetch('/api/settings/kv/auto_scan_enabled', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({value: e.target.checked ? 'true' : 'false'})
                    });
                };
            }
        });

// === DEFENSIVE LANGUAGE SELECTOR & LISTENER ===
        const langSelectElement = document.getElementById('dash-language-select') || document.getElementById('language-select') || document.getElementById('dash-lang-select');
        if (langSelectElement) {
            langSelectElement.value = window.userConfig.language || 'vi';
            langSelectElement.addEventListener('change', async (e) => {
                const val = e.target.value;
                console.log("[UI Change] Language mutated to:", val);
                await loadLanguage(val);
                updateUserConfig({ language: val });
            });
        }


        const btnExportM3u = document.getElementById('btn-export-m3u');
        if (btnExportM3u) {
            btnExportM3u.style.cssText = 'background-color: #6366f1; color: #ffffff; width: 100%; justify-content: center; transition: all 0.2s ease-in-out; border-radius: 8px; cursor: pointer; padding: 10px 15px; border: none; outline: none; margin-bottom: 10px; font-weight: 500; font-size: 0.9rem; display: flex; align-items: center;';
            btnExportM3u.onmouseover = () => {
                btnExportM3u.style.backgroundColor = '#4f46e5';
                btnExportM3u.style.boxShadow = '0 4px 12px rgba(99, 102, 241, 0.3)';
            };
            btnExportM3u.onmouseout = () => {
                btnExportM3u.style.backgroundColor = '#6366f1';
                btnExportM3u.style.boxShadow = 'none';
            };
            btnExportM3u.onclick = async () => {
                try {
                    const res = await fetch(`/api/export/playlist${appToken ? '?token=' + appToken : ''}`);
                    const data = await res.json();
                    if (data.status === 'success') {
                        toast("Export Playlist successful! Saved to Downloads/list_exported/playlists/", "success");
                    } else if (data.status === 'error') {
                        toast("Export Error: " + data.message, "error");
                    }
                } catch (err) {
                    toast("Export Error: " + err.message, "error");
                }
            };
        }
        
        const btnExportEpg = document.getElementById('btn-export-epg');
        if (btnExportEpg) {
            btnExportEpg.style.cssText = 'background-color: #6366f1; color: #ffffff; width: 100%; justify-content: center; transition: all 0.2s ease-in-out; border-radius: 8px; cursor: pointer; padding: 10px 15px; border: none; outline: none; font-weight: 500; font-size: 0.9rem; display: flex; align-items: center;';
            btnExportEpg.onmouseover = () => {
                btnExportEpg.style.backgroundColor = '#4f46e5';
                btnExportEpg.style.boxShadow = '0 4px 12px rgba(99, 102, 241, 0.3)';
            };
            btnExportEpg.onmouseout = () => {
                btnExportEpg.style.backgroundColor = '#6366f1';
                btnExportEpg.style.boxShadow = 'none';
            };
            btnExportEpg.onclick = async () => {
                try {
                    const res = await fetch(`/api/export/epg${appToken ? '?token=' + appToken : ''}`);
                    const data = await res.json();
                    if (data.status === 'success') {
                        toast("Export EPG successful! Saved to Downloads/list_exported/schedules/", "success");
                    } else if (data.status === 'error') {
                        toast("Export Error: " + data.message, "error");
                    }
                } catch (err) {
                    toast("Export Error: " + err.message, "error");
                }
            };
        }
        
        const btnClearCache = document.getElementById('btn-clear-cache');
        if (btnClearCache) {
            btnClearCache.onclick = async () => {
                const originalText = btnClearCache.textContent;
                btnClearCache.textContent = "Clearing...";
                btnClearCache.disabled = true;
                try {
                    const res = await fetch('/api/settings/clear_cache', { method: 'POST' });
                    const data = await res.json();
                    if (data.status === 'success') {
                        toast(data.message, 'success');
                        if (window.pywebview && window.pywebview.api && window.pywebview.api.clear_cache) {
                            await window.pywebview.api.clear_cache();
                        }
                    } else {
                        toast(data.message || 'Error clearing cache', 'error');
                    }
                } catch(e) {
                    toast('Connection error', 'error');
                }
                btnClearCache.textContent = originalText;
                btnClearCache.disabled = false;
            };
        }
        
        // Dash Menu Navigation
        document.querySelectorAll('.dashboard-menu li[data-target]').forEach(li => {
            li.addEventListener('click', (e) => {
                document.querySelectorAll('.dashboard-menu li').forEach(el => el.classList.remove('active'));
                e.target.classList.add('active');
                document.querySelectorAll('.dashboard-panel').forEach(p => p.classList.remove('active'));
                const targetId = e.target.getAttribute('data-target');
                document.getElementById(targetId).classList.add('active');
                
                // If User Profile tab, populate inputs
                if (targetId === 'dash-user') {
                    document.getElementById('user-avatar-base64').value = state.avatar || '';
                    document.getElementById('user-display-name').value = state.displayName || '';
                    const prev = document.getElementById('user-avatar-preview');
                    const plac = document.getElementById('user-avatar-placeholder');
                    if (state.avatar) {
                        prev.src = state.avatar;
                        prev.style.display = 'block';
                        plac.style.display = 'none';
                    } else {
                        prev.src = '';
                        prev.style.display = 'none';
                        plac.style.display = 'block';
                        plac.textContent = (state.displayName || 'U').charAt(0).toUpperCase();
                    }
                }
            });
        });
        
        // Avatar File Upload
        const avatarFile = document.getElementById('user-avatar-file');
        if (avatarFile) {
            avatarFile.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                
                // Limit size to 1MB
                if (file.size > 1024 * 1024) {
                    return toast('Avatar file is too large (max 1MB)', 'error');
                }
                
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const b64 = ev.target.result;
                    document.getElementById('user-avatar-base64').value = b64;
                    document.getElementById('user-avatar-preview').src = b64;
                    document.getElementById('user-avatar-preview').style.display = 'block';
                    document.getElementById('user-avatar-placeholder').style.display = 'none';
                };
                reader.readAsDataURL(file);
            });
        }
        
        // Update Profile
        const btnUpdateProfile = document.getElementById('btn-update-profile');
        if (btnUpdateProfile) {
            btnUpdateProfile.onclick = async () => {
                const avatar = document.getElementById('user-avatar-base64').value;
                const displayName = document.getElementById('user-display-name').value.trim();
                if (!displayName) return toast('Display name cannot be empty', 'error');
                
                const payload = { username: state.username, display_name: displayName, avatar: avatar };
                console.log("[Profile] Sending update payload:", payload);
                
                btnUpdateProfile.disabled = true;
                btnUpdateProfile.textContent = "Updating...";
                try {
                    const res = await fetch('/api/user/profile', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    const data = await res.json();
                    if (data.status === 'success') {
                        toast('Profile updated!', 'success');
                        state.displayName = displayName;
                        state.avatar = avatar;
                        
                        
                        updateUserUI();
                    } else {
                        toast(data.message, 'error');
                    }
                } catch(e) {
                    toast('Connection error', 'error');
                }
                btnUpdateProfile.disabled = false;
                btnUpdateProfile.textContent = "Update Profile";
            };
        }
        
        // Change Password
        const btnChangePass = document.getElementById('btn-change-password');
        if (btnChangePass) {
            btnChangePass.onclick = async () => {
                const oldPass = document.getElementById('old-password').value;
                const newPass = document.getElementById('new-password').value;
                const confPass = document.getElementById('confirm-password').value;
                
                if (!oldPass || !newPass) return toast('Please fill all fields', 'error');
                if (newPass !== confPass) return toast('Passwords do not match', 'error');
                
                btnChangePass.disabled = true;
                btnChangePass.textContent = "Updating...";
                try {
                    const res = await fetch('/api/user/password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: state.username, old_password: oldPass, new_password: newPass })
                    });
                    const data = await res.json();
                    if (data.status === 'success') {
                        toast('Password updated successfully!', 'success');
                        document.getElementById('old-password').value = '';
                        document.getElementById('new-password').value = '';
                        document.getElementById('confirm-password').value = '';
                    } else {
                        toast(data.message, 'error');
                    }
                } catch(e) {
                    toast('Connection error', 'error');
                }
                btnChangePass.disabled = false;
                btnChangePass.textContent = "Update Password";
            };
        }
        
        // Auto-play Last Channel
        if (window.playerConfig.autoplayLast === true) {
            const lastChStr = (window.playerConfig.lastChannel ? JSON.stringify(window.playerConfig.lastChannel) : null);
            if (lastChStr) {
                try {
                    const lastCh = JSON.parse(lastChStr);
                    if (lastCh && lastCh.url) {
                        if (!lastCh.uniqueId) lastCh.uniqueId = lastCh.id ? lastCh.id.toString() : 'ch_' + (lastCh.url + lastCh.name).replace(/[^a-zA-Z0-9]/g, '');
                        state.activeChannelId = lastCh.uniqueId;
                        setTimeout(() => {
                            playChannel(lastCh);
                            if (lastCh.playlist_id) {
                                state.activePlaylistId = lastCh.playlist_id;
                                if (dom.playlistSelect) dom.playlistSelect.value = state.activePlaylistId;
                                loadChannels(state.activePlaylistId);
                            }
                        }, 800);
                    }
                } catch(e) {}
            }
        }
    };

    // Check existing session — force live DB data into state
    try {
        const sessionRes = await fetch('/api/check-session');
        const sessionData = await sessionRes.json();
        if (sessionData.status === 'success') {
            state.username = sessionData.username;
            state.displayName = sessionData.display_name || sessionData.username;
            state.avatar = sessionData.avatar || '';
            state.accountType = sessionData.type;
            updateUserUI();
            await handleSuccessfulLogin(sessionData, sessionData.username);
        }
    } catch(e) {
        console.error("Session check failed", e);
    }
    
    // Attempt to login
    const performLogin = async () => {
        const username = loginUsernameInput.value.trim();
        const password = loginPasswordInput.value.trim();
        if (!username || !password) {
            loginError.textContent = "Please enter username and password.";
            loginError.style.display = 'block';
            return;
        }
        
        try {
            btnLogin.disabled = true;
            btnLogin.textContent = "Logging in...";
            const rememberMe = document.getElementById('login-remember-me') ? document.getElementById('login-remember-me').checked : false;
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, remember_me: rememberMe })
            });
            const data = await res.json();
            if (data.status === 'success') {
                await handleSuccessfulLogin(data, username);
            } else {

                loginError.textContent = data.message || "Invalid credentials.";
                loginError.style.display = 'block';
                btnLogin.disabled = false;
                btnLogin.textContent = "Sign In";
            }
        } catch (e) {
            loginError.textContent = "Connection error.";
            loginError.style.display = 'block';
            btnLogin.disabled = false;
            btnLogin.textContent = "Sign In";
        }
    };
    
    btnLogin.onclick = performLogin;
    loginPasswordInput.onkeyup = (e) => {
        if (e.key === 'Enter') performLogin();
    };

    const btnGuestLogin = document.getElementById('btn-guest-login');
    if (btnGuestLogin) {
        btnGuestLogin.onclick = async () => {
            try {
                btnGuestLogin.disabled = true;
                btnGuestLogin.textContent = "Logging in...";
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ login_type: 'guest' })
                });
                const data = await res.json();
                if (data.status === 'success') {
                    await handleSuccessfulLogin(data, data.username);
                } else {
                    loginError.textContent = data.message || "Failed to login as guest.";
                    loginError.style.display = 'block';
                    btnGuestLogin.disabled = false;
                    btnGuestLogin.textContent = "Continue as Guest";
                }
            } catch (e) {
                loginError.textContent = "Connection error.";
                loginError.style.display = 'block';
                btnGuestLogin.disabled = false;
                btnGuestLogin.textContent = "Continue as Guest";
            }
        };
    }
    
    enableWheelScroll(dom.groupChips);
    enableWheelScroll(dom.epgScheduleStrip);

    dom.channelList.addEventListener('scroll', () => {
        requestAnimationFrame(renderVirtualScroll);
    });
    window.addEventListener('resize', () => {
        dom.channelList.getBoundingClientRect(); // Force cleanly updated bounding calculations
        requestAnimationFrame(() => renderVirtualScroll(true));
    });

    // === BULLETPROOF PERSISTENT HYDRATION (single source of truth) ===
    try {
        console.log("[Init] Fetching persistent configurations...");
        const [playerRes, userRes] = await Promise.all([
            fetch('/api/settings/kv/player_config').then(r => r.ok ? r.json() : {}).catch(() => ({})),
            fetch('/api/settings/kv/user_config').then(r => r.ok ? r.json() : {}).catch(() => ({}))
        ]);

        // Force repair if backend sent double-stringified data
        let cleanPlayerConfig = (typeof playerRes === 'string') ? JSON.parse(playerRes) : playerRes;
        let cleanUserConfig = (typeof userRes === 'string') ? JSON.parse(userRes) : userRes;

        if (cleanPlayerConfig && Object.keys(cleanPlayerConfig).length > 0) {
            window.playerConfig = { ...window.playerConfig, ...cleanPlayerConfig };
            console.log("[Init] Hydrated Player Config:", window.playerConfig);
            
            const arSelect = document.getElementById('dash-aspect-ratio') || document.getElementById('aspect-ratio-select');
            const bufSelect = document.getElementById('dash-buffer-size') || document.getElementById('buffer-size-select');
            
            if (arSelect && window.playerConfig.aspectRatio) arSelect.value = window.playerConfig.aspectRatio;
            if (bufSelect && window.playerConfig.bufferSize) bufSelect.value = window.playerConfig.bufferSize;
        }

        if (cleanUserConfig && Object.keys(cleanUserConfig).length > 0) {
            window.userConfig = { ...window.userConfig, ...cleanUserConfig };
            state.favorites = window.userConfig.favorites || state.favorites;
            state.activePlaylistId = window.userConfig.activePlaylistId || state.activePlaylistId;
            console.log("[Init] Hydrated User Config:", window.userConfig);
            
            // Explicitly apply the stored language configuration from the database on startup
            if (window.userConfig.language) {
                await loadLanguage(window.userConfig.language);
                const langSelect = document.getElementById('dash-language-select') || document.getElementById('language-select') || document.getElementById('dash-lang-select');
                if (langSelect) langSelect.value = window.userConfig.language;
            }
        }

        updateUserUI();
    } catch (err) {
        console.error("[Init] Hydration error:", err);
    }

    // Release the persistence guard — this is the ONLY place isAppLoading is set to false
    isAppLoading = false;
    console.log("[Init] Guard released. isAppLoading =", isAppLoading);
}

// === UNIFIED EVENT-DRIVEN POLLING BOOTSTRAPPER ===
function bootstrapApp() {
    if (isAppReady) return;
    
    // Core event handler execution branch
    const executeNativeBoot = async () => {
        if (isAppReady) return;
        if (window.pywebview && window.pywebview.api && window.pywebview.api.get_token) {
            window.removeEventListener('pywebviewready', executeNativeBoot);
            clearInterval(bootFallbackInterval);
            await initApp();
        }
    };

    // Attach native event listener dispatched by the desktop shell container
    window.addEventListener('pywebviewready', executeNativeBoot);

    // Defensive micro-polling loop (Runs every 50ms, times out after 2 seconds)
    let bootAttempts = 0;
    const bootFallbackInterval = setInterval(async () => {
        bootAttempts++;
        
        if (window.pywebview && window.pywebview.api && window.pywebview.api.get_token) {
            clearInterval(bootFallbackInterval);
            window.removeEventListener('pywebviewready', executeNativeBoot);
            if (!isAppReady) {
                await initApp();
            }
        } else if (bootAttempts > 40) { 
            // Graceful fallback threshold reached for standard web browser containers
            clearInterval(bootFallbackInterval);
            window.removeEventListener('pywebviewready', executeNativeBoot);
            console.warn("[Bootstrap] WebView API bridge not detected. Proceeding with fallback boot.");
            if (!isAppReady) {
                await initApp();
            }
        }
    }, 50);
}

// Bind the updated bootstrap framework securely to the DOM completion phase
window.removeEventListener('DOMContentLoaded', bootstrapApp);
window.addEventListener('DOMContentLoaded', bootstrapApp);

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
            el.textContent = state.langKeys[key];
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
        const storedPlaylistId = window.userConfig.activePlaylistId;
        if (storedPlaylistId && state.playlists.find(p => p.id === storedPlaylistId)) {
            state.activePlaylistId = storedPlaylistId;
        }
        if (!state.activePlaylistId || !state.playlists.find(p => p.id === state.activePlaylistId)) {
            state.activePlaylistId = state.playlists[0].id;
        }
        updateUserConfig({activePlaylistId: state.activePlaylistId});
        dom.playlistSelect.value = state.activePlaylistId;
        await loadChannels(state.activePlaylistId);
    } else {
        state.activePlaylistId = '';
        virtualScroll.container.innerHTML = `
            <div class="empty-state" id="empty-state">
                <div class="empty-icon-static"></div>
                <p>${getText('empty_state_title')}</p>
                <span>${getText('empty_state_subtitle')}</span>
            </div>`;
        virtualScroll.spacer.style.height = '0px';
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
        opt.textContent = `${p.name} (${p.count || 0})`;
        select.appendChild(opt);
    });
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

async function checkActiveScanState() {
    if (!state.activePlaylistId) return;
    try {
        const progressRes = await fetch(`/api/scan/progress?playlist_id=${state.activePlaylistId}&token=${appToken}`);
        const progressData = await progressRes.json();
        const btnTextSpan = dom.btnScan.querySelector('span');
        const originalText = getText('btn_scan_title') || 'Scan Status';

        if (progressData.is_scanning) {
            state.queuedIds = new Set(progressData.queued_ids || []);
            state.scanningIds = new Set(progressData.processing_ids || []);
            fetchVisibleChannels(true);
            
            if (scanIntervalId) {
                clearInterval(scanIntervalId);
            }
            state.isScanning = true;
            dom.btnScan.classList.add('scanning-active');
            if (btnTextSpan) {
                btnTextSpan.textContent = `Stop Scan (${progressData.progress_percent}%)`;
            }
            
            scanIntervalId = setInterval(async () => {
                try {
                    const pRes = await fetch(`/api/scan/progress?playlist_id=${state.activePlaylistId}&token=${appToken}`);
                    const pData = await pRes.json();
                    
                    if (!pData.is_scanning) {
                        clearInterval(scanIntervalId);
                        scanIntervalId = null;
                        state.isScanning = false;
                        state.queuedIds.clear();
                        state.scanningIds.clear();
                        dom.btnScan.classList.remove('scanning-active');
                        if (btnTextSpan) btnTextSpan.textContent = originalText;
                        
                        if (state.isManualScanning) {
                            toast('Scan completed!', 'success');
                            state.isManualScanning = false;
                            await loadChannels(state.activePlaylistId);
                        } else {
                            fetchVisibleChannels(true);
                        }
                    } else {
                        state.queuedIds = new Set(pData.queued_ids || []);
                        state.scanningIds = new Set(pData.processing_ids || []);
                        fetchVisibleChannels(true);
                        
                        const percent = pData.progress_percent;
                        if (btnTextSpan) {
                            btnTextSpan.textContent = `Stop Scan (${percent}%)`;
                        }
                    }
                } catch (err) {
                    clearInterval(scanIntervalId);
                    scanIntervalId = null;
                    state.isScanning = false;
                    state.queuedIds.clear();
                    state.scanningIds.clear();
                    dom.btnScan.classList.remove('scanning-active');
                    if (btnTextSpan) btnTextSpan.textContent = originalText;
                }
            }, 2000);
        } else {
            if (scanIntervalId) {
                clearInterval(scanIntervalId);
                scanIntervalId = null;
            }
            state.isScanning = false;
            state.queuedIds.clear();
            state.scanningIds.clear();
            dom.btnScan.classList.remove('scanning-active');
            if (btnTextSpan) btnTextSpan.textContent = originalText;
        }
    } catch (e) {
        console.error("Error checking active scan state:", e);
    }
}

async function loadChannels(playlistId) {
    state.activeGroup = '';
    dom.searchInput.value = '';
    
    try {
        const res = await fetch(`/api/groups?playlist_id=${playlistId}`);
        const groups = await res.json();
        renderGroupChips(groups);
    } catch (e) {
        console.error('Failed to load groups:', e);
    }

    await reloadChannelCount();
    checkActiveScanState();
}

async function reloadChannelCount() {
    if (!state.activePlaylistId) return;

    const search = dom.searchInput.value.toLowerCase().trim();
    const group = state.activeGroup;

    if (group === 'Favorites') {
        const filteredFavs = state.favorites.filter(f => !search || f.name.toLowerCase().includes(search));
        virtualScroll.totalCount = filteredFavs.length;
        
        dom.sidebarFooter.style.display = 'block';
        dom.channelCount.textContent = `${virtualScroll.totalCount} kenh`;
        
        virtualScroll.spacer.style.height = `${virtualScroll.totalCount * virtualScroll.itemHeight}px`;
        dom.channelList.scrollTop = 0;
        virtualScroll.lastStartIndex = -1;
        
        await renderVirtualScroll(true);
        return;
    }

    try {
        const res = await fetch(`/api/channels/count?playlist_id=${state.activePlaylistId}&search=${encodeURIComponent(search)}&group=${encodeURIComponent(group)}`);
        const data = await res.json();
        virtualScroll.totalCount = data.count;
        
        dom.sidebarFooter.style.display = 'block';
        dom.channelCount.textContent = `${virtualScroll.totalCount} kenh`;
        
        virtualScroll.spacer.style.height = `${virtualScroll.totalCount * virtualScroll.itemHeight}px`;
        dom.channelList.scrollTop = 0;
        virtualScroll.lastStartIndex = -1;
        
        await renderVirtualScroll(true);
    } catch (e) {
        console.error('Failed to load channel count:', e);
    }
}

function renderGroupChips(groups) {
    if (!groups || groups.length <= 1) {
        dom.groupBar.style.display = 'none';
        return;
    }

    dom.groupBar.style.display = 'block';
    dom.groupChips.innerHTML = '';

    if (state.favorites && state.favorites.length > 0) {
        const favChip = document.createElement('button');
        favChip.className = `chip${state.activeGroup === 'Favorites' ? ' active' : ''}`;
        favChip.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="margin-right:4px; margin-bottom:-2px;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>Favorites (${state.favorites.length})`;
        favChip.dataset.group = 'Favorites';
        favChip.onclick = () => {
            state.activeGroup = 'Favorites';
            updateChipStyles();
            reloadChannelCount();
        };
        dom.groupChips.appendChild(favChip);
    }

    // "All" chip
    const allChip = document.createElement('button');
    allChip.className = `chip${state.activeGroup === '' ? ' active' : ''}`;
    allChip.textContent = `${getText('settings_auto')} (All)`;
    allChip.onclick = () => {
        state.activeGroup = '';
        updateChipStyles();
        reloadChannelCount();
    };
    dom.groupChips.appendChild(allChip);

    groups.forEach(g => {
        const chip = document.createElement('button');
        chip.className = `chip${state.activeGroup === g ? ' active' : ''}`;
        chip.textContent = g;
        chip.dataset.group = g;
        chip.onclick = () => {
            state.activeGroup = g;
            updateChipStyles();
            reloadChannelCount();
        };
        dom.groupChips.appendChild(chip);
    });
}

function updateChipStyles() {
    $$('.group-chips .chip').forEach(chip => {
        if ((!state.activeGroup && chip.textContent.includes('All')) || chip.dataset.group === state.activeGroup) {
            chip.classList.add('active');
        } else {
            chip.classList.remove('active');
        }
    });
}

async function renderVirtualScroll(force = false) {
    if (!state.activePlaylistId) return;
    if (virtualScroll.totalCount === 0) {
        virtualScroll.container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon-static" style="filter: hue-rotate(45deg);"></div>
                <p>${getText('empty_state_no_results')}</p>
                <span>${getText('empty_state_try_again')}</span>
            </div>`;
        return;
    }

    const scrollTop = dom.channelList.scrollTop;
    const viewportHeight = dom.channelList.clientHeight;
    virtualScroll.visibleCount = Math.ceil(viewportHeight / virtualScroll.itemHeight);
    
    let startIndex = Math.floor(scrollTop / virtualScroll.itemHeight) - virtualScroll.overscan;
    startIndex = Math.max(0, startIndex);
    
    // Check if we need to fetch
    if (!force && Math.abs(startIndex - virtualScroll.lastStartIndex) < (virtualScroll.overscan / 2)) {
        return; 
    }
    
    virtualScroll.lastStartIndex = startIndex;
    const limit = virtualScroll.visibleCount + (virtualScroll.overscan * 2);
    
    if (virtualScroll.abortController) {
        virtualScroll.abortController.abort();
    }
    virtualScroll.abortController = new AbortController();

    const search = dom.searchInput.value.toLowerCase().trim();
    const group = state.activeGroup;

    if (group === 'Favorites') {
        const filteredFavs = state.favorites.filter(f => !search || f.name.toLowerCase().includes(search));
        const channels = filteredFavs.slice(startIndex, startIndex + limit);
        renderChannelElements(channels, startIndex);
        return;
    }

    try {
        const res = await fetch(`/api/channels?playlist_id=${state.activePlaylistId}&offset=${startIndex}&limit=${limit}&search=${encodeURIComponent(search)}&group=${encodeURIComponent(group)}`, {
            signal: virtualScroll.abortController.signal
        });
        const channels = await res.json();
        renderChannelElements(channels, startIndex);
    } catch (e) {
        if (e.name !== 'AbortError') {
            console.error('Virtual fetch error:', e);
        }
    }
}

function getCurrentEpgProgram(ch) {
    if (!ch.epg_programs || ch.epg_programs.length === 0) return null;
    const now = Math.floor(Date.now() / 1000);
    return ch.epg_programs.find(p => p.start <= now && now < p.stop) || null;
}

function renderChannelElements(channels, startIndex) {
    if (window.playerConfig.autoScanEnabled && channels.length > 0) {
        const unknownIds = channels
            .filter(c => c.status === 'unknown')
            .map(c => c.id);
            
        if (unknownIds.length > 0) {
            fetch(`/api/scan?token=${appToken}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-App-Token': appToken
                },
                body: JSON.stringify({
                    playlist_id: state.activePlaylistId,
                    channel_ids: unknownIds
                })
            })
            .then(() => checkActiveScanState())
            .catch(err => console.error("AutoScan error:", err));
        }
    }

    const defaultLogo = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="%23334155"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="16" fill="%2394a3b8">TV</text></svg>'
    );

    const frag = document.createDocumentFragment();

    channels.forEach((ch, idx) => {
        // Sinh ID duy nhất nếu chưa có (id từ DB hoặc hash url+name)
        if (!ch.uniqueId) {
            ch.uniqueId = ch.id ? ch.id.toString() : 'ch_' + (ch.url + ch.name).replace(/[^a-zA-Z0-9]/g, '');
        }

        const absoluteIndex = startIndex + idx;
        const div = document.createElement('div');
        div.className = 'ch-item';
        div.dataset.key = ch.uniqueId; // Dùng uniqueId làm key
        if (ch.id) {
            const dbId = parseInt(ch.id);
            div.dataset.id = dbId;
            if (state.scanningIds && state.scanningIds.has(dbId)) {
                div.classList.add('scanning');
            } else if (state.queuedIds && state.queuedIds.has(dbId)) {
                div.classList.add('queued');
            }
        }
        div.style.position = 'absolute';
        div.style.top = `${absoluteIndex * virtualScroll.itemHeight}px`;
        div.style.left = '0';
        div.style.right = '0';
        div.style.height = `${virtualScroll.itemHeight - 2}px`; // accounting for margin
        
        // Kiểm tra đúng activeChannelId thay vì url
        if (state.activeChannelId && state.activeChannelId === ch.uniqueId) {
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

        const isRecording = state.activeRecordings && state.activeRecordings.includes(ch.url);
        const recordIcon = isRecording 
            ? `<div class="recording-indicator" title="Recording in background"></div>`
            : '';

        div.innerHTML = `
            <img class="ch-logo" src="${ch.logo || defaultLogo}" onerror="this.src='${defaultLogo}'" loading="lazy" alt="">
            <div class="ch-info">
                <div class="ch-name" title="${escapeHTML(displayName)}">${escapeHTML(displayName)}</div>
                ${epgText}
            </div>
            <div class="ch-actions">
                ${recordIcon}
                <button class="btn-fav ${isFav ? 'favorited' : ''}" onclick="window.toggleFavorite(event, '${ch.url.replace(/'/g, "\\'")}', '${ch.name.replace(/'/g, "\\'")}')" title="Toggle Favorite">
                    ${favIcon}
                </button>
            </div>
            <div class="ch-status ${ch.status || 'unknown'}" title="${getText('status_' + (ch.status || 'unknown'))}"></div>
        `;

        div.onclick = () => playChannel(ch);
        frag.appendChild(div);
    });

    virtualScroll.container.innerHTML = '';
    virtualScroll.container.appendChild(frag);
}

// Removed IndexedDB chunking


function playChannel(ch) {
    if (!ch.uniqueId) {
        ch.uniqueId = ch.id ? ch.id.toString() : 'ch_' + (ch.url + ch.name).replace(/[^a-zA-Z0-9]/g, '');
    }
    
    // TTL Expiration Evaluation
    let mem = state.transcodeMemoryMap[ch.uniqueId];
    const nowSec = Math.floor(Date.now() / 1000);
    if (mem && typeof mem === 'object') {
        if (nowSec - mem.last_checked > 2592000) {
            mem.mode = 'unknown';
            mem.fail_count = 0;
            mem.last_checked = nowSec;
            localStorage.setItem('transcode_memory_map', JSON.stringify(state.transcodeMemoryMap));
        }
    } else if (mem === true || typeof mem !== 'object') {
        // Upgrade legacy boolean format
        state.transcodeMemoryMap[ch.uniqueId] = { mode: mem === true ? 'transcode' : 'unknown', fail_count: mem === true ? 3 : 0, last_checked: nowSec };
        localStorage.setItem('transcode_memory_map', JSON.stringify(state.transcodeMemoryMap));
    }
    
    // Adaptive State Normalization Layer
    if (ch.stream_links && Array.isArray(ch.stream_links) && ch.stream_links.length > 0) {
        window.currentStreamOptions = ch.stream_links;
    } else if (ch.sources && Array.isArray(ch.sources) && ch.sources.length > 0) {
        window.currentStreamOptions = ch.sources;
    } else {
        window.currentStreamOptions = [{ name: "Auto", url: ch.url, request_headers: [] }];
    }
    
    // Auto-select first active headers if applicable
    const activeOpt = window.currentStreamOptions.find(o => o.url === ch.url) || window.currentStreamOptions[0];
    if (activeOpt && activeOpt.request_headers) {
        ch.request_headers = activeOpt.request_headers;
    }
    
    state.currentChannel = ch;
    state.activeChannelId = ch.uniqueId; // Lưu trạng thái bằng ID duy nhất
    state.currentLoadingChannelId = ch.uniqueId;
    state.retryCount = 0;
    updatePlayerConfig({lastChannel: ch});

    // Reset settings panel
    dom.settingsPanel.style.display = 'none';

    // Update UI
    dom.playerWelcome.style.display = 'none';
    dom.playerError.style.display = 'none';
    updateLoaderProgress(0);
    dom.playerContainer.classList.add('active-player');
    dom.nowPlaying.textContent = getText('now_playing', { name: ch.name });

    // Highlight active item by forcing a re-render or querying DOM
    $$('.ch-item').forEach((el) => {
        el.classList.remove('active');
    });
    // Virtual scroll will apply .active class natively on next render
    renderVirtualScroll(true);

    if (ch.epg_programs) {
        const now = Math.floor(Date.now() / 1000);
        ch.epg_current_index = ch.epg_programs.findIndex(p => p.start <= now && now < p.stop);
    }

    renderEpgStrip(ch);
    destroyHls();
    applyAspectRatio(window.playerConfig.aspectRatio || 'auto');
    startPlayback(ch.url, ch);
}

function getYouTubeId(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

function isDirectVideo(url) {
    const cleanUrl = url.split('|')[0].split('?')[0].toLowerCase();
    return cleanUrl.endsWith('.mp4') || cleanUrl.endsWith('.webm') || cleanUrl.endsWith('.ogg') || cleanUrl.endsWith('.mov') || cleanUrl.endsWith('.mp3') || cleanUrl.includes('/api/recordings/play/');
}

let stallCheckInterval = null;
let lastVideoTime = -1;
let stallTicks = 0;

function stopStallMonitor() {
    if (stallCheckInterval) {
        clearInterval(stallCheckInterval);
        stallCheckInterval = null;
    }
}

function startStallMonitor(url, ch, isProxy, isCatchup, linkIndex) {
    stopStallMonitor();
    stallTicks = 0;
    lastVideoTime = -1;
    
    stallCheckInterval = setInterval(() => {
        if (!dom.video || dom.video.paused || dom.video.ended) {
            lastVideoTime = -1;
            stallTicks = 0;
            return;
        }
        
        if (dom.video.currentTime === lastVideoTime) {
            stallTicks++;
            if (stallTicks >= 4) {
                console.log('[Stall Monitor] Stalled for 4s, reconnecting...');
                toast('Network slow, forcing reconnect...', 'warning');
                
                const savedTime = dom.video.currentTime;
                state.retryCount++;
                
                if (state.retryCount <= 3) {
                    destroyHls();
                    startPlayback(url, ch, isProxy, isCatchup, linkIndex, savedTime);
                } else {
                    let links = [];
                    if (Array.isArray(ch.stream_links)) {
                        links = ch.stream_links.map(l => typeof l === 'string' ? l : (l.url || l.src || ''));
                    }
                    if (links.length > linkIndex + 1) {
                        toast('Current stream failed, switching to fallback...', 'warning');
                        state.retryCount = 0;
                        destroyHls();
                        const nextUrl = links[linkIndex + 1];
                        startPlayback(nextUrl, ch, isProxy, isCatchup, linkIndex + 1, savedTime);
                    } else {
                        stopStallMonitor();
                        update_channel_status(ch.id, state.activeChannelId, 'dead');
                        showError("Error: This channel is currently unavailable.");
                    }
                }
            }
        } else {
            lastVideoTime = dom.video.currentTime;
            stallTicks = 0;
        }
    }, 1000);
}

function startPlayback(url, ch, isProxy = false, isCatchup = false, linkIndex = 0, resumeTime = 0, forceTranscodeSession = false) {
    if (dom.video.src) {
        dom.video.pause();
        dom.video.removeAttribute('src');
        dom.video.load();
    }
    
    // Force pitch preservation to prevent 'demon voice' when HLS slows down
    if ('preservesPitch' in dom.video) dom.video.preservesPitch = true;
    if ('mozPreservesPitch' in dom.video) dom.video.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in dom.video) dom.video.webkitPreservesPitch = true;
    
    // Disable timeline logging
    window.playbackTimeline = [];
    window.logTimelineEvent = function(eventName) {};

    
    state.recordedSegments = [];
    if (dom.downloadCount) dom.downloadCount.style.display = 'none';
    state.isLive = !isCatchup;
    setupPlayerSettings();

    dom.video.style.display = 'block';
    dom.youtubePlayer.style.display = 'none';
    dom.youtubePlayer.src = '';

    const rawUrl = url.split('|')[0];
    const youtubeId = getYouTubeId(rawUrl);

    state.isPlaybackMode = rawUrl.includes('/api/recordings/play/');
    
    // Hide download button in playback mode
    if (dom.btnDownload) {
        dom.btnDownload.style.display = state.isPlaybackMode ? 'none' : 'inline-flex';
    }
    
    if (youtubeId) {
        state.isLive = false; // YouTube videos are VOD
        dom.video.style.display = 'none';
        dom.youtubePlayer.style.display = 'block';
        dom.youtubePlayer.src = `https://www.youtube.com/embed/${youtubeId}?autoplay=1&controls=1`;
        dom.playerLoader.style.display = 'none';
        return;
    }

    if (isDirectVideo(rawUrl)) {
        state.isLive = false; // Direct MP4/MKV files are VOD
        state.isDirect = true;
        state.directUrl = url;
        updateRecordButtonUI();
        if (resumeTime > 0) dom.video.currentTime = resumeTime;
        dom.video.src = url;
        dom.video.play().catch(() => {});
        // ISOLATED: startStallMonitor(url, ch, isProxy, isCatchup, linkIndex);
        return;
    }

    state.isLive = true;
    state.isDirect = true;
    state.directUrl = url;
    updateRecordButtonUI();
    dom.playerContainer.dataset.mode = 'live';
    
    let payload = { url: url };
    if (ch && ch.request_headers && ch.request_headers.length > 0) {
        payload.headers = JSON.stringify(ch.request_headers);
    }
    
    // Completely remove timeline instrumentation and memory map logic
    // ISOLATED: Force Transcode for ALL non-direct video streams
    updateLoaderProgress(0);
    if (true) {
        updateLoaderProgress(5);
        fetch('/api/transcode/init' + (typeof appToken !== 'undefined' && appToken ? `?token=${appToken}` : ''), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(res => {
            if (window.logTimelineEvent) window.logTimelineEvent('transcode_init_response_received');
            return res.json();
        }).then(data => {
            if (state.currentLoadingChannelId !== ch.uniqueId) {
                if (data.session_id) {
                    fetch('/api/transcode/stop', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ session_id: data.session_id })
                    }).catch(()=>{});
                }
                return;
            }

            if (data.status === 'success') {
                if (window.logTimelineEvent) window.logTimelineEvent('transcode_playlist_request_started');
                state.transcodeSessionId = data.session_id;
                const hlsUrl = data.url;
                updateLoaderProgress(20, true);
                if (Hls.isSupported() || dom.video.canPlayType('application/vnd.apple.mpegurl')) {
                    if (window.logTimelineEvent) window.logTimelineEvent('transcode_polling_started');
                    let attempts = 0;
                    if (state.transcodeCheckInterval) clearInterval(state.transcodeCheckInterval);
                    state.transcodeCheckInterval = setInterval(async () => {
                        attempts++;
                        try {
                            const checkRes = await fetch(hlsUrl);
                            if (checkRes.ok) {
                                const playlistText = await checkRes.text();
                                if (playlistText.includes('#EXTINF:')) {
                                    clearInterval(state.transcodeCheckInterval);
                                    state.transcodeCheckInterval = null;
                                    if (window.logTimelineEvent) window.logTimelineEvent('transcode_playlist_ready');
                                    
                                    updateLoaderProgress(80);
                                    
                                    if (Hls.isSupported()) {
                                        const bufConfig = getHlsBufferConfig();
                                        state.hls = new Hls({
                                            enableWorker: true,
                                            lowLatencyMode: false,
                                            maxBufferLength: bufConfig.maxBufferLength || 20,
                                            maxMaxBufferLength: bufConfig.maxMaxBufferLength || 30,
                                            maxBufferSize: bufConfig.maxBufferSize || 30 * 1000 * 1000,
                                            backBufferLength: bufConfig.backBufferLength || 10,
                                            startFragPrefetch: true,
                                            liveSyncDurationCount: 3,
                                            liveMaxLatencyDurationCount: 6,
                                            liveDurationInfinity: true,
                                        });
                                        state.hls.loadSource(hlsUrl);
                                        state.hls.attachMedia(dom.video);
                                        state.hls.on(Hls.Events.MANIFEST_PARSED, function() {
                                            updateLoaderProgress(90);
                                            dom.video.play().catch(() => {});
                                        });
                                        dom.video.addEventListener('playing', function() {
                                            updateLoaderProgress(100);
                                            setTimeout(() => {
                                                if (dom.playerLoader) dom.playerLoader.style.display = 'none';
                                            }, 250);
                                        }, { once: true });
                                        state.hls.on(Hls.Events.ERROR, function(event, data) {
                                            console.error("HLS Error", data);
 
                                            if (data.fatal) {
                                                switch (data.type) {
                                                    case Hls.ErrorTypes.NETWORK_ERROR:
                                                        state.hls.startLoad();
                                                        break;
                                                    case Hls.ErrorTypes.MEDIA_ERROR:
                                                        state.hls.recoverMediaError();
                                                        break;
                                                    default:
                                                        if (!state.autoRetryCount) state.autoRetryCount = 0;
                                                        if (state.autoRetryCount < 3) {
                                                            state.autoRetryCount++;
                                                            console.log("Auto-retrying fatal transcode error...");
                                                            if (state.currentChannel && typeof playChannel === 'function') {
                                                                playChannel(state.currentChannel);
                                                            }
                                                        } else {
                                                            destroyHls();
                                                            if (dom.playerLoader) dom.playerLoader.style.display = 'none';
                                                            showError("Fatal transcode error.");
                                                            state.autoRetryCount = 0;
                                                        }
                                                        break;
                                                }
                                            }
                                        });
                                    } else {
                                        dom.video.src = hlsUrl;
                                        dom.video.addEventListener('loadedmetadata', function() {
                                            updateLoaderProgress(90);
                                            dom.video.play().catch(() => {});
                                        }, { once: true });
                                        dom.video.addEventListener('playing', function() {
                                            updateLoaderProgress(100);
                                            setTimeout(() => {
                                                if (dom.playerLoader) dom.playerLoader.style.display = 'none';
                                                state.autoRetryCount = 0; // Reset counter on success
                                            }, 250);
                                        }, { once: true });
                                    }
                                } // end EXTINF check
                            } else if (checkRes.status >= 500) {
                                clearInterval(state.transcodeCheckInterval);
                                state.transcodeCheckInterval = null;
                                if (state.transcodeSessionId) {
                                    fetch('/api/transcode/stop', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ session_id: state.transcodeSessionId })
                                    }).catch(()=>{});
                                    state.transcodeSessionId = null;
                                }
                                showError(getText('player_error_title') || "Failed to load channel");
                                return;
                            }
                        } catch (e) {
                            // ignore network errors during polling
                        }
                    }, 500);
                } else {
                    if (dom.playerLoader) dom.playerLoader.style.display = 'none';
                    showError("HLS is not supported in this browser.");
                }
            } else {
                if (dom.playerLoader) dom.playerLoader.style.display = 'none';
                showError("Transcode initialization failed");
            }
        }).catch(err => {
            if (dom.playerLoader) dom.playerLoader.style.display = 'none';
            showError("Transcode backend unavailable");
        });
    }
}

function destroyHls() {
    if (window.logTimelineEvent) window.logTimelineEvent('destroyHls_called');
    stopStallMonitor();
    state.isDirect = false;
    state.directUrl = '';
    if (activeMediaRecorder && activeMediaRecorder.state !== 'inactive') {
        try { activeMediaRecorder.stop(); } catch(e){}
        activeMediaRecorder = null;
    }
    
    if (state.transcodeSessionId) {
        fetch('/api/transcode/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: state.transcodeSessionId })
        }).catch(()=>{});
        state.transcodeSessionId = null;
    }
    
    if (state.transcodeCheckInterval) {
        clearInterval(state.transcodeCheckInterval);
        state.transcodeCheckInterval = null;
    }

    if (state.playbackWatchdog) {
        clearTimeout(state.playbackWatchdog);
        state.playbackWatchdog = null;
    }
    
    if (state.hls) {
        state.hls.detachMedia();
        state.hls.destroy();
        state.hls = null;
    }
    if (dom.video) {
        dom.video.pause();
        dom.video.removeAttribute('src');
        dom.video.load();
    }
    dom.youtubePlayer.src = '';
    dom.youtubePlayer.style.display = 'none';
    dom.video.style.display = 'block';
}

let progressAnimInterval = null;
let progressCrawlInterval = null;

function updateLoaderProgress(target, crawl = false) {
    if (dom.playerLoader) {
        if (dom.playerLoader.style.display === 'none') {
            dom.playerLoader.style.display = 'flex';
        }
    }
    
    if (typeof state.currentProgress === 'undefined') {
        state.currentProgress = 0;
    }
    
    if (progressAnimInterval) {
        clearInterval(progressAnimInterval);
        progressAnimInterval = null;
    }
    if (progressCrawlInterval) {
        clearInterval(progressCrawlInterval);
        progressCrawlInterval = null;
    }
    
    if (target === 0) {
        state.currentProgress = 0;
        if (dom.loaderPercent) dom.loaderPercent.textContent = `0%`;
        return;
    }
    
    const start = state.currentProgress;
    const end = target;
    
    if (start === end) {
        if (dom.loaderPercent) dom.loaderPercent.textContent = `${end}%`;
        if (crawl) startProgressCrawl(end);
        return;
    }
    
    let current = start;
    const direction = end > start ? 1 : -1;
    const gap = Math.abs(end - start);
    const stepTime = Math.max(6, Math.min(25, Math.floor(250 / gap))); 
    
    progressAnimInterval = setInterval(() => {
        current += direction;
        state.currentProgress = current;
        if (dom.loaderPercent) {
            dom.loaderPercent.textContent = `${current}%`;
        }
        
        if (current === end) {
            clearInterval(progressAnimInterval);
            progressAnimInterval = null;
            if (crawl) {
                startProgressCrawl(end);
            }
        }
    }, stepTime);
}

function startProgressCrawl(startVal) {
    if (progressCrawlInterval) {
        clearInterval(progressCrawlInterval);
    }
    
    let current = startVal;
    progressCrawlInterval = setInterval(() => {
        if (current < 75) {
            current++;
            state.currentProgress = current;
            if (dom.loaderPercent) {
                dom.loaderPercent.textContent = `${current}%`;
            }
        } else {
            clearInterval(progressCrawlInterval);
            progressCrawlInterval = null;
        }
    }, 150);
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
    if (state.isPlaybackMode) {
        dom.settingsPanel.style.display = 'none';
        return; // Skip setting up stream-specific network settings
    }

    dom.qualityList.innerHTML = '';
    dom.audioList.innerHTML = '';

    let hasQualities = false;
    let hasAudioTracks = false;

    const ch = state.currentChannel;

    // Quality/Stream selection
    if (window.currentStreamOptions && window.currentStreamOptions.length > 0) {
        hasQualities = true;
        $('#section-quality').style.display = 'block';

        window.currentStreamOptions.forEach((streamOpt) => {
            const opt = document.createElement('div');
            const isActive = ch.url === streamOpt.url || window.currentStreamOptions.length === 1;
            opt.className = `settings-item${isActive ? ' active' : ''}`;
            
            let displayName = streamOpt.name || 'Auto';
            if (displayName.includes(' - ')) {
                displayName = displayName.split(' - ').pop().trim();
            } else {
                displayName = 'Auto';
            }
            opt.textContent = displayName;
            
            opt.onclick = () => {
                if (ch.url !== streamOpt.url) {
                    ch.url = streamOpt.url;
                    if (streamOpt.request_headers) {
                        ch.request_headers = streamOpt.request_headers;
                    }
                    destroyHls(false);
                    startPlayback(ch.url, ch);
                }
                dom.settingsPanel.style.display = 'none';
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
        $('#section-quality').style.display = 'block';
        const autoOpt = document.createElement('div');
        autoOpt.className = 'settings-item active';
        autoOpt.textContent = 'Auto';
        autoOpt.onclick = () => {
            dom.settingsPanel.style.display = 'none';
        };
        dom.qualityList.appendChild(autoOpt);
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
        $('#section-audio').style.display = 'block';
        const autoOpt = document.createElement('div');
        autoOpt.className = 'settings-item active';
        autoOpt.textContent = 'Auto';
        autoOpt.onclick = () => {
            dom.settingsPanel.style.display = 'none';
        };
        dom.audioList.appendChild(autoOpt);
    }

    // Always show settings button because we have the Force Transcode toggle
    if (state.accountType === 'account' || state.accountType === 'guest') {
    }
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

function openModal(mode, context = null) {
    state.modalMode = mode;
    state.modalContext = context; // Track temporary payload attributes safely
    
    dom.modalOverlay.style.display = 'flex';
    dom.modalInput.value = '';
    dom.modalInput.style.display = 'block'; // Default to visible
    dom.modalError.style.display = 'none';
    dom.modalOk.textContent = getText('btn_ok');
    dom.modalFileContainer.style.display = 'none';

    if (mode === 'import') {
        dom.modalTitle.textContent = getText('modal_import_title');
        dom.modalInput.setAttribute('placeholder', getText('modal_import_placeholder'));
        dom.modalFileContainer.style.display = 'block';
    } else if (mode === 'epg') {
        dom.modalTitle.textContent = getText('modal_epg_title');
        dom.modalInput.setAttribute('placeholder', getText('modal_epg_placeholder'));
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
    } else if (mode === 'rename_recording') {
        dom.modalTitle.textContent = "Rename Recording File";
        dom.modalInput.setAttribute('placeholder', "Enter new filename (e.g., video.mp4)");
        if (context && context.oldName) {
            dom.modalInput.value = context.oldName;
        }
    } else if (mode === 'delete_playlist_confirm') {
        dom.modalTitle.textContent = getText('toast_delete_confirm') || "Are you sure you want to delete this playlist?";
        dom.modalInput.style.display = 'none'; // Hide input field for confirmation layout
    }

    if (dom.modalInput.style.display !== 'none') {
        setTimeout(() => dom.modalInput.focus(), 150);
    }
}

function closeModal() {
    dom.modalOverlay.style.display = 'none';
    dom.modalError.style.display = 'none';
    dom.modalFileInput.value = '';
    dom.modalInput.style.display = 'block'; // Reset display layout state
    dom.fileUploadText.textContent = getText('file_upload_select');
    state.modalContext = null; // Clear tracking cache context
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
        } else if (state.modalMode === 'rename_recording') {
            const value = dom.modalInput.value.trim();
            if (!value) throw new Error('Filename cannot be empty');
            const id = state.modalContext.id;
            
            res = await fetch('/api/recordings/rename', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({id: id, new_name: value})
            });
            data = await res.json();
            if (data.status !== 'success') throw new Error(data.message || 'Error renaming file');
            
            toast('Successfully renamed file', 'success');
            closeModal();
            loadRecordings();
        } else if (state.modalMode === 'delete_playlist_confirm') {
            res = await fetch(`/api/playlists/${state.activePlaylistId}?lang=${state.currentLang}`, { method: 'DELETE' });
            data = await res.json();
            toast(data.message, 'success');
            state.activePlaylistId = '';
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

async function update_channel_status(ch_id, uniqueId, newStatus) {
    if (!ch_id) return;
    try {
        await fetch('/api/channel/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: ch_id, status: newStatus })
        });
        const statusDot = document.querySelector(`.ch-item[data-key="${uniqueId}"] .ch-status`);
        if (statusDot) {
            statusDot.className = `ch-status ${newStatus}`;
        }
    } catch (e) {
        console.error("Status update failed", e);
    }
}

function setupEventListeners() {
    
    function handleCancelPrewarm(e) {
        if (state.prewarmDebounceTimer) clearTimeout(state.prewarmDebounceTimer);
    }
    
    function handlePrewarm(e) {
        const item = e.target.closest('.ch-item');
        if (!item) return;
        const chId = item.dataset.id;
        if (!chId) return;
        const ch = (state.filteredChannels && state.filteredChannels.length > 0) ? state.filteredChannels.find(c => (c.uniqueId || c.id.toString()) === chId) : state.channels.find(c => (c.uniqueId || c.id.toString()) === chId);
        if (!ch) return;
        let mem = state.transcodeMemoryMap[ch.uniqueId];
        if (!mem || mem.mode !== 'transcode') return;
        if (state.activeChannelId === ch.uniqueId) return;
        if (state.prewarmedChannelId === ch.uniqueId) return;
        
        if (state.prewarmDebounceTimer) clearTimeout(state.prewarmDebounceTimer);
        
        state.prewarmDebounceTimer = setTimeout(() => {
            if (state.prewarmedSessionId && state.prewarmedChannelId !== ch.uniqueId) {
                fetch('/api/transcode/stop', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: state.prewarmedSessionId })
                }).catch(()=>{});
            }
            
            state.prewarmedChannelId = ch.uniqueId;
            if (state.prewarmEvictionTimer) clearTimeout(state.prewarmEvictionTimer);
            
            let payload = { url: ch.url };
            if (ch && ch.request_headers && ch.request_headers.length > 0) {
                payload.headers = JSON.stringify(ch.request_headers);
            }
            fetch('/api/transcode/init' + (typeof appToken !== 'undefined' && appToken ? `?token=${appToken}` : ''), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).then(r => r.json()).then(data => {
                if (data.status === 'success') {
                    if (state.prewarmedChannelId !== ch.uniqueId || state.activeChannelId === ch.uniqueId) {
                        fetch('/api/transcode/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: data.session_id }) }).catch(()=>{});
                        return;
                    }
                    state.prewarmedSessionId = data.session_id;
                    state.prewarmedUrl = data.url;
                    
                    state.prewarmEvictionTimer = setTimeout(() => {
                        if (state.prewarmedSessionId === data.session_id) {
                            fetch('/api/transcode/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: data.session_id }) }).catch(()=>{});
                            state.prewarmedSessionId = null;
                            state.prewarmedChannelId = null;
                            state.prewarmedUrl = null;
                        }
                    }, 4000);
                }
            }).catch(()=>{});
        }, 600);
    }

    // === AUTOMATIC LOADER CONTROL VIA NATIVE FRAME RENDER EVENTS ===
    if (dom.video) {
        dom.video.addEventListener('stalled', () => {
            if (window.logTimelineEvent) window.logTimelineEvent('stalled');
        });
        
        dom.video.addEventListener('loadeddata', () => {
            if (window.logTimelineEvent) window.logTimelineEvent('loadeddata');
            if (dom.playerLoader) dom.playerLoader.style.display = 'none';
            if (state.playbackWatchdog) { clearTimeout(state.playbackWatchdog); state.playbackWatchdog = null; }
        });
        
        dom.video.addEventListener('playing', () => {
            if (window.logTimelineEvent) window.logTimelineEvent('playing');
            if (dom.playerLoader) dom.playerLoader.style.display = 'none';
            if (state.playbackWatchdog) { clearTimeout(state.playbackWatchdog); state.playbackWatchdog = null; }
        });
        
        dom.video.addEventListener('canplay', () => {
            if (window.logTimelineEvent) window.logTimelineEvent('canplay');
            if (dom.playerLoader) dom.playerLoader.style.display = 'none';
        });
        
        dom.video.addEventListener('waiting', () => {
            if (window.logTimelineEvent) window.logTimelineEvent('waiting');
            updateLoaderProgress(99);
        });
        
        dom.video.addEventListener('loadstart', () => {
            if (window.logTimelineEvent) window.logTimelineEvent('loadstart');
            if (dom.playerLoader && dom.playerLoader.style.display === 'none') {
                updateLoaderProgress(90);
            }
        });

        dom.video.addEventListener('playing', () => {
            if (state.currentChannel) {
                update_channel_status(state.currentChannel.id, state.activeChannelId, 'alive');
            }
        });

        dom.video.addEventListener('error', () => {
            if (state.currentChannel) {
                const err = dom.video.error;
                let errMsg = "Error: This channel is currently unavailable.";
                if (err) {
                    errMsg += ` (Code: ${err.code}`;
                    if (err.message) errMsg += `, Msg: ${err.message}`;
                    errMsg += `)`;
                }
                console.error("[Video Error]", err);
                update_channel_status(state.currentChannel.id, state.activeChannelId, 'dead');
                showError(errMsg);
            }
        });
    }

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
        openModal('delete_playlist_confirm');
    };

    dom.btnScan.onclick = async () => {
        if (!state.activePlaylistId) return;
        
        const btnTextSpan = dom.btnScan.querySelector('span');
        const originalText = getText('btn_scan_title') || 'Scan Status';
        
        if (state.isScanning) {
            toast('Cancelling scan...', 'info');
            try {
                await fetch(`/api/scan/cancel?token=${appToken}`, {
                    method: 'POST',
                    headers: { 'X-App-Token': appToken }
                });
                if (scanIntervalId) {
                    clearInterval(scanIntervalId);
                    scanIntervalId = null;
                }
                state.isScanning = false;
                state.isManualScanning = false;
                state.queuedIds.clear();
                state.scanningIds.clear();
                dom.btnScan.classList.remove('scanning-active');
                if (btnTextSpan) btnTextSpan.textContent = originalText;
                toast('Scan cancelled', 'success');
                await loadChannels(state.activePlaylistId);
            } catch (err) {
                toast('Failed to cancel scan', 'error');
            }
            return;
        }

        toast(getText('toast_scan_start'), 'info');
        state.isScanning = true;
        state.isManualScanning = true;
        dom.btnScan.classList.add('scanning-active');

        try {
            const res = await fetch(`/api/scan?token=${appToken}&lang=${state.currentLang}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-App-Token': appToken
                },
                body: JSON.stringify({ playlist_id: state.activePlaylistId })
            });
            const data = await res.json();
            
            if (data.status === 'completed') {
                toast(data.message || 'Scan completed', 'success');
                state.isScanning = false;
                state.isManualScanning = false;
                dom.btnScan.classList.remove('scanning-active');
                await loadChannels(state.activePlaylistId);
                return;
            }
            
            await checkActiveScanState();
        } catch (e) {
            toast(e.message, 'error');
            state.isScanning = false;
            state.isManualScanning = false;
            dom.btnScan.classList.remove('scanning-active');
            if (btnTextSpan) btnTextSpan.textContent = originalText;
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
            updateUserConfig({activePlaylistId: state.activePlaylistId});
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
    dom.searchInput.oninput = () => {
        clearTimeout(virtualScroll.searchTimeout);
        virtualScroll.searchTimeout = setTimeout(() => {
            if (dom.recordingsListContainer.style.display !== 'none') {
                renderRecordingsList();
            } else {
                reloadChannelCount();
            }
        }, 300);
    };

    // Player controls events
    Object.assign(dom.btnRetry.style, {
        backgroundColor: '#6366f1',
        color: '#ffffff',
        border: 'none',
        padding: '8px 22px',
        borderRadius: '6px',
        fontWeight: '500',
        fontSize: '0.85rem',
        cursor: 'pointer',
        outline: 'none',
        transition: 'all 0.2s ease-in-out'
    });

    dom.btnRetry.onmouseover = () => {
        dom.btnRetry.style.backgroundColor = '#4f46e5';
        dom.btnRetry.style.boxShadow = '0 4px 12px rgba(99, 102, 241, 0.3)';
    };

    dom.btnRetry.onmouseout = () => {
        dom.btnRetry.style.backgroundColor = '#6366f1';
        dom.btnRetry.style.boxShadow = 'none';
    };

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
        dom.iconPlay.style.display = 'block'; // Keep original display bindings intact
        dom.iconPause.style.display = 'none';
        if (activeMediaRecorder && activeMediaRecorder.state !== 'inactive') {
            activeMediaRecorder.stop();
        }
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
            document.body.classList.toggle('fullscreen-mode');
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
    
    // Press ESC to exit fullscreen mode in Desktop app
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('fullscreen-mode')) {
            document.body.classList.remove('fullscreen-mode');
            if (window.pywebview && window.pywebview.api) {
                window.pywebview.api.toggle_fullscreen();
            }
        }
    });

    // Download segment/video
    // === CORRECTED SESSION-BASED MANUAL RECORDING EXTRACTION ===
    // === HYBRID INTELIGENT SESSION MANUAL RECORDING CONTROLLER ===
    dom.btnDownload.onclick = async () => {
        if (!state.currentChannel) return;
        
        const isRec = state.activeRecordings.includes(state.currentChannel.url);
        if (isRec) {
            try {
                const res = await fetch('/api/record/stop', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ url: state.currentChannel.url })
                });
                const data = await res.json();
                toast(data.message || 'Recording stopped successfully', data.status === 'success' ? 'success' : 'error');
                if (data.status === 'success') {
                    state.activeRecordings = state.activeRecordings.filter(u => u !== state.currentChannel.url);
                    updateRecordButtonUI();
                }
            } catch(e) {
                toast('Error stopping recording session', 'error');
            }
        } else {
            try {
                const res = await fetch('/api/record/start', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        url: state.currentChannel.url,
                        channel_name: state.currentChannel.name,
                        filepath: null
                    })
                });
                const data = await res.json();
                toast(data.message || 'Background recording started', data.status === 'success' ? 'success' : 'error');
                if (data.status === 'success') {
                    state.activeRecordings.push(state.currentChannel.url);
                    updateRecordButtonUI();
                }
            } catch(e) {
                toast('Error starting background recording session', 'error');
            }
        }
    };

    // Type 2: Background FFmpeg recording (in settings)
    if (dom.btnBgRecord) {
        dom.btnBgRecord.onclick = async (e) => {
            e.stopPropagation();
            if (!state.currentChannel) return;
            const isRec = state.activeRecordings.includes(state.currentChannel.url);
            
            if (isRec) {
                // Stop background recording
                try {
                    const res = await fetch('/api/record/stop', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ url: state.currentChannel.url })
                    });
                    const data = await res.json();
                    toast(data.message || data.detail || 'Error stopping recording', data.status === 'success' ? 'success' : 'error');
                    if (data.status === 'success') {
                        state.activeRecordings = state.activeRecordings.filter(u => u !== state.currentChannel.url);
                        updateRecordButtonUI();
                    }
                } catch(e) {
                    toast(e.message || 'Error stopping recording', 'error');
                }
            } else {
                // Start background recording (Silent, no dialog)
                try {
                    const res = await fetch('/api/record/start', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ 
                            url: state.currentChannel.url,
                            channel_name: state.currentChannel.name,
                            filepath: null // Will auto-save to %APPDATA%/recordings/ with timestamp
                        })
                    });
                    const data = await res.json();
                    toast(data.message || data.detail || 'Error starting background record', data.status === 'success' ? 'info' : 'error');
                    if (data.status === 'success') {
                        state.activeRecordings.push(state.currentChannel.url);
                        updateRecordButtonUI();
                    }
                } catch(e) {
                    toast(e.message || 'Error starting background record', 'error');
                }
            }
        };
    }

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

// === DEFENSIVE ASPECT RATIO LISTENER ===
const arSelectElement = document.getElementById('dash-aspect-ratio') || document.getElementById('aspect-ratio-select');
if (arSelectElement) {
    arSelectElement.addEventListener('change', (e) => {
        const val = e.target.value;
        console.log("[UI Change] Aspect Ratio mutated to:", val);
        window.playerConfig.aspectRatio = val;
        updatePlayerConfig({ aspectRatio: val });
        if (typeof applyAspectRatio === 'function') {
            applyAspectRatio(val);
        }
    });
}

// === DEFENSIVE BUFFER SIZE LISTENER ===
const bufSelectElement = document.getElementById('dash-buffer-size') || document.getElementById('buffer-size-select');
if (bufSelectElement) {
    bufSelectElement.addEventListener('change', (e) => {
        const val = e.target.value;
        console.log("[UI Change] Buffer Size mutated to:", val);
        window.playerConfig.bufferSize = val;
        updatePlayerConfig({ bufferSize: val });
        if (state.currentChannel && typeof playChannel === 'function') {
            playChannel(state.currentChannel);
        }
    });
}

// === DEFENSIVE HARDWARE ACCELERATION LISTENER ===
const hwSelectElement = document.getElementById('dash-hw-select') || document.getElementById('hardware-acceleration-select') || document.getElementById('hw-accel-select') || document.getElementById('hw-select');
if (hwSelectElement) {
    hwSelectElement.value = window.playerConfig.hwAccel || 'auto';
    hwSelectElement.addEventListener('change', (e) => {
        const val = e.target.value;
        console.log("[UI Change] Hardware Acceleration mutated to:", val);
        window.playerConfig.hwAccel = val;
        updatePlayerConfig({ hwAccel: val });
    });
}

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
        if (document.getElementById('guest-activation-overlay')) return;
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
                dom.video.volume = Math.max(0.0, dom.video.volume - 0.05);
                dom.video.muted = dom.video.volume === 0;
                dom.volumeSlider.value = dom.video.volume;
                syncVolumeUI();
                break;
            case 'ArrowRight':
                e.preventDefault();
                dom.video.muted = false;
                dom.video.volume = Math.min(1.0, dom.video.volume + 0.05);
                dom.volumeSlider.value = dom.video.volume;
                syncVolumeUI();
                break;
            case 'ArrowUp':
                e.preventDefault();
                playPrevChannel();
                break;
            case 'ArrowDown':
                e.preventDefault();
                playNextChannel();
                break;
            case 'Escape':
                if (dom.modalOverlay.style.display !== 'none') {
                    closeModal();
                }
                break;
        }
    });
}

function playNextChannel() {
    if (!state.filteredChannels || state.filteredChannels.length === 0 || !state.currentChannel) return;
    const currentId = state.currentChannel.id;
    const idx = state.filteredChannels.findIndex(c => c.id === currentId);
    if (idx !== -1 && idx < state.filteredChannels.length - 1) {
        const nextCh = state.filteredChannels[idx + 1];
        const item = document.querySelector(`.channel-item[data-id="${nextCh.id}"]`);
        if (item) item.click();
    }
}

function playPrevChannel() {
    if (!state.filteredChannels || state.filteredChannels.length === 0 || !state.currentChannel) return;
    const currentId = state.currentChannel.id;
    const idx = state.filteredChannels.findIndex(c => c.id === currentId);
    if (idx > 0) {
        const prevCh = state.filteredChannels[idx - 1];
        const item = document.querySelector(`.channel-item[data-id="${prevCh.id}"]`);
        if (item) item.click();
    }
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
    if (state.activePlaylistId) {
        renderVirtualScroll(true);
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

// ═══════════════════════════════════════════════════════════════════
// Custom Dropdown Integration
// ═══════════════════════════════════════════════════════════════════

const originalSelectDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
Object.defineProperty(HTMLSelectElement.prototype, 'value', {
    get: function() {
        return originalSelectDescriptor.get.call(this);
    },
    set: function(val) {
        originalSelectDescriptor.set.call(this, val);
        if (this.dataset.customized) {
            this.dispatchEvent(new Event('custom-select-update'));
        }
    }
});

function createCustomDropdown(selectElement) {
    if (selectElement.dataset.customized) return;
    selectElement.dataset.customized = "true";
    selectElement.style.display = "none";

    const wrapper = document.createElement("div");
    wrapper.className = "custom-select-wrapper";
    if (selectElement.id) wrapper.id = selectElement.id + "-wrapper";
    if (selectElement.style.maxWidth) wrapper.style.maxWidth = selectElement.style.maxWidth;
    if (selectElement.style.width) wrapper.style.width = selectElement.style.width;
    wrapper.classList.add(...Array.from(selectElement.classList).filter(c => c !== 'input-field'));
    
    const trigger = document.createElement("div");
    trigger.className = "custom-select-trigger";
    
    const textSpan = document.createElement("span");
    trigger.appendChild(textSpan);
    
    const svgIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgIcon.setAttribute("viewBox", "0 0 24 24");
    svgIcon.className.baseVal = "arrow";
    svgIcon.innerHTML = `<polyline points="6 9 12 15 18 9"></polyline>`;
    trigger.appendChild(svgIcon);
    
    const optionsContainer = document.createElement("div");
    optionsContainer.className = "custom-select-options";
    
    wrapper.appendChild(trigger);
    wrapper.appendChild(optionsContainer);
    
    selectElement.parentNode.insertBefore(wrapper, selectElement);
    wrapper.appendChild(selectElement);
    
    function renderOptions() {
        optionsContainer.innerHTML = "";
        const options = Array.from(selectElement.options);
        
        let selectedText = "";
        options.forEach(opt => {
            const optionDiv = document.createElement("div");
            optionDiv.className = "custom-select-option";
            if (opt.selected || selectElement.value === opt.value) {
                optionDiv.classList.add("selected");
                selectedText = opt.text;
            }
            optionDiv.textContent = opt.text;
            
            optionDiv.addEventListener("click", (e) => {
                e.stopPropagation();
                selectElement.value = opt.value;
                selectElement.dispatchEvent(new Event("change"));
                wrapper.classList.remove("open");
                renderOptions();
            });
            optionsContainer.appendChild(optionDiv);
        });
        textSpan.textContent = selectedText;
    }
    
    renderOptions();
    
    const observer = new MutationObserver(() => renderOptions());
    observer.observe(selectElement, { childList: true });
    
    selectElement.addEventListener('change', renderOptions);
    selectElement.addEventListener('custom-select-update', renderOptions);
    
    trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = wrapper.classList.contains("open");
        document.querySelectorAll(".custom-select-wrapper").forEach(w => w.classList.remove("open"));
        if (!isOpen) {
            wrapper.classList.add("open");
            const selectedOpt = optionsContainer.querySelector('.selected');
            if (selectedOpt) {
                selectedOpt.scrollIntoView({ block: 'nearest' });
            }
        }
    });
    
    document.addEventListener("click", (e) => {
        if (!wrapper.contains(e.target)) {
            wrapper.classList.remove("open");
        }
    });
}

function initCustomDropdowns() {
    document.querySelectorAll("select").forEach(select => {
        createCustomDropdown(select);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initCustomDropdowns();
});

setInterval(async () => {
    if (window.playerConfig && window.playerConfig.autoScanEnabled && state.activePlaylistId && document.getElementById('app').style.display !== 'none') {
        try {
            await fetch(`/api/scan?token=${appToken}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-App-Token': appToken
                },
                body: JSON.stringify({ playlist_id: state.activePlaylistId })
            });
            await renderVirtualScroll(true);
        } catch (e) {}
    }
}, 300000);
