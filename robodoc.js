// File: robodoc.js
// RoboDoc — live clinical co-pilot. Streams microphone audio to Deepgram for a
// live transcript (same resilient pipeline as app.js), and periodically sends
// the growing transcript to /api/robodoc, which returns new clinical prompts
// (red flags, questions to ask, examinations, differentials) rendered as a
// live feed beside the transcript.

// DOM Elements
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const transcriptDiv = document.getElementById('transcript');
const promptsFeed = document.getElementById('promptsFeed');
const promptCountEl = document.getElementById('promptCount');
const analysisStatusEl = document.getElementById('analysisStatus');
const processingHub = document.getElementById('processingHub');
const hubStatusText = document.getElementById('hubStatusText');

// --- STATE (streaming) ---
let audioContext = null;
let workletNode = null;
let mediaStreams = [];
let deviceSampleRate = 48000;

let dgSocket = null;
let dgConnecting = false;

let isRecording = false;
let streamActive = false;
let isPaused = false;
let finishing = false;
let intentionalClose = false;

let finalTranscript = '';
let interimTranscript = '';
let lastSpeaker = null;

let pendingChunks = [];
let pendingBytes = 0;
let reconnectAttempts = 0;
let reconnectTimer = null;
let keepAliveInterval = null;
let finishTimeout = null;

let recordingStartTime = null;
let recordingTimer = null;
let wakeLock = null;
let pausedDuration = 0;
let pauseStartTime = null;
let selectedMicId = null;

const MAX_RECONNECT_BACKOFF_MS = 5000;
const LONG_OUTAGE_SECONDS = 120;
const HARD_BUFFER_SECONDS = 600;

// --- STATE (analysis loop) ---
let analysisInterval = null;
let analysisInFlight = false;
let lastAnalyzedLength = 0;     // transcript length at the last completed analysis
let lastAnalysisTime = 0;
let analysisFailures = 0;       // consecutive failures — back off, don't spam alerts
let shownPrompts = [];          // [{category, title, detail}] in arrival order

// How often RoboDoc looks at the conversation. Each analysis is one AI call,
// so these gate both responsiveness and cost.
const ANALYSIS_TICK_MS = 5000;          // how often we check whether to analyse
const MIN_ANALYSIS_GAP_MS = 15000;      // at most one AI call per 15s
const MIN_NEW_CHARS = 60;               // need this much new speech to bother
const MAX_ANALYSIS_FAILURES = 3;        // stop trying after repeated errors

// Reusable AudioWorklet module (inlined so there is no extra file to deploy).
let workletUrlCache = null;
function getWorkletUrl() {
    if (workletUrlCache) return workletUrlCache;
    const code = `
        class PCMProcessor extends AudioWorkletProcessor {
            process(inputs) {
                const input = inputs[0];
                if (input && input[0]) {
                    const data = input[0];               // Float32 [-1, 1]
                    const out = new Int16Array(data.length);
                    for (let i = 0; i < data.length; i++) {
                        const s = Math.max(-1, Math.min(1, data[i]));
                        out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                    this.port.postMessage(out.buffer, [out.buffer]);
                }
                return true;
            }
        }
        registerProcessor('pcm-processor', PCMProcessor);
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    workletUrlCache = URL.createObjectURL(blob);
    return workletUrlCache;
}

// --- SCREEN WAKE LOCK ---

async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (_) { /* denied or unsupported — carry on without it */ }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isRecording && !wakeLock) {
        acquireWakeLock();
    }
});

// --- MICROPHONE MANAGEMENT ---

async function populateMicrophoneDropdown() {
    const dropdown = document.getElementById('microphoneDropdown');
    if (!dropdown) return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const microphones = devices.filter(device => device.kind === 'audioinput');

        dropdown.innerHTML = '';
        if (microphones.length === 0) {
            dropdown.innerHTML = '<option value="">No microphones detected</option>';
            dropdown.disabled = true;
            return;
        }

        microphones.forEach((mic, index) => {
            const option = document.createElement('option');
            option.value = mic.deviceId;
            option.textContent = mic.label || `Microphone ${index + 1}`;
            if (mic.deviceId === 'default' || index === 0) {
                option.selected = true;
                selectedMicId = mic.deviceId;
            }
            dropdown.appendChild(option);
        });
    } catch (error) {
        console.warn('Microphone list unavailable until access is granted:', error);
        dropdown.innerHTML = '<option value="">Default microphone</option>';
    }
}

function handleMicrophoneSelection() {
    const dropdown = document.getElementById('microphoneDropdown');
    if (dropdown) selectedMicId = dropdown.value;
}

// --- RECORDING / STREAMING ---

async function startRecording() {
    if (isRecording) return;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
        alert('Your browser does not support audio capture. Please use a recent version of Chrome, Edge, or Safari.');
        return;
    }

    try {
        resetTranscriptState();
        resetPrompts();

        audioContext = new AudioCtx();
        deviceSampleRate = audioContext.sampleRate;

        if (!audioContext.audioWorklet) {
            throw new Error('AudioWorklet not supported in this browser.');
        }
        await audioContext.audioWorklet.addModule(getWorkletUrl());

        workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
        workletNode.port.onmessage = (e) => handlePcm(e.data);

        // Pull the graph through a muted sink so the worklet keeps processing
        // without routing the mic to the speakers (which would cause feedback).
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0;
        workletNode.connect(silentGain);
        silentGain.connect(audioContext.destination);

        const micStream = await navigator.mediaDevices.getUserMedia({
            audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true
        });
        mediaStreams.push(micStream);
        audioContext.createMediaStreamSource(micStream).connect(workletNode);

        isRecording = true;
        isPaused = false;
        streamActive = true;
        finishing = false;
        intentionalClose = false;
        recordingStartTime = Date.now();
        pausedDuration = 0;

        updateUI();
        startTimer();
        acquireWakeLock();
        startAnalysisLoop();

        connectDeepgram(); // self-retrying; audio buffers locally until connected

    } catch (err) {
        console.error('Error starting RoboDoc:', err);
        alert('Could not start listening. Please check microphone permissions and try again.');
        statusDiv.textContent = 'Failed to start';
        stopAudioCapture();
        releaseWakeLock();
        stopAnalysisLoop();
        isRecording = false;
        streamActive = false;
        updateUI();
    }
}

function pauseRecording() {
    if (!isRecording) return;
    if (!isPaused) {
        isPaused = true;
        pauseStartTime = Date.now();
        clearInterval(recordingTimer);
        if (audioContext) audioContext.suspend().catch(() => {});
    } else {
        isPaused = false;
        pausedDuration += (Date.now() - pauseStartTime);
        if (audioContext) audioContext.resume().catch(() => {});
        startTimer();
    }
    updateUI();
    if (dgSocket && dgSocket.readyState === WebSocket.OPEN) updateConnectionState('connected');
}

function stopRecording() {
    if (!isRecording) return;

    isRecording = false;
    isPaused = false;
    finishing = true;
    clearInterval(recordingTimer);

    stopAudioCapture();
    releaseWakeLock();
    stopAnalysisLoop();

    updateUI();
    statusDiv.textContent = 'Finalising transcription...';

    const cleanup = () => {
        clearTimeout(finishTimeout);
        streamActive = false;
        finishing = false;
        intentionalClose = true;
        stopKeepAlive();
        clearTimeout(reconnectTimer);
        if (dgSocket) { try { dgSocket.close(); } catch (_) {} dgSocket = null; }
        updateUI();
        finalizeSession();
    };

    if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        flushPendingChunks();
        try { dgSocket.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {}
        finishTimeout = setTimeout(cleanup, 2000);
    } else if (pendingChunks.length > 0) {
        statusDiv.textContent = 'Reconnecting to save final audio...';
        finishTimeout = setTimeout(() => {
            statusDiv.textContent = 'Some audio near the end may be missing (connection lost).';
            cleanup();
        }, 6000);
    } else {
        cleanup();
    }
}

function stopAudioCapture() {
    if (workletNode) {
        try { workletNode.port.onmessage = null; workletNode.disconnect(); } catch (_) {}
        workletNode = null;
    }
    mediaStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
    mediaStreams = [];
    if (audioContext) { try { audioContext.close(); } catch (_) {} audioContext = null; }
}

// --- DEEPGRAM WEBSOCKET ---

async function connectDeepgram() {
    if (dgConnecting) return;
    if (dgSocket && dgSocket.readyState === WebSocket.OPEN) return;
    if (!streamActive) return;

    dgConnecting = true;
    updateConnectionState('connecting');

    try {
        const tokenRes = await apiFetch('/api/deepgram-token', { method: 'POST' });
        if (!tokenRes.ok) {
            const errData = await tokenRes.json().catch(() => ({}));
            throw new Error(errData.error || `Token request failed (${tokenRes.status})`);
        }
        const { token } = await tokenRes.json();
        if (!token) throw new Error('No token returned from server');

        const params = new URLSearchParams({
            model: 'nova-3-medical',
            language: 'en-GB',
            punctuate: 'true',
            smart_format: 'true',
            diarize: 'true',
            interim_results: 'true',
            encoding: 'linear16',
            sample_rate: String(deviceSampleRate),
            channels: '1'
        });

        // Temporary token is passed via the WebSocket subprotocol (browser-safe).
        // Granted access tokens use 'bearer'; only raw API keys use 'token'.
        const socket = new WebSocket(
            `wss://api.deepgram.com/v1/listen?${params.toString()}`,
            ['bearer', token]
        );
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => {
            dgConnecting = false;
            dgSocket = socket;
            reconnectAttempts = 0;
            updateConnectionState('connected');
            flushPendingChunks();
            startKeepAlive();
            if (finishing) {
                try { socket.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {}
            }
        };

        socket.onmessage = (e) => {
            try {
                handleDeepgramMessage(JSON.parse(e.data));
            } catch (_) { /* non-JSON keep-alive ack, ignore */ }
        };

        socket.onerror = (e) => {
            console.error('Deepgram socket error', e);
        };

        socket.onclose = () => {
            dgConnecting = false;
            stopKeepAlive();
            if (dgSocket === socket) dgSocket = null;
            if (streamActive && !intentionalClose) scheduleReconnect();
        };

    } catch (err) {
        console.error('connectDeepgram failed:', err);
        dgConnecting = false;
        if (streamActive && !intentionalClose) scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (dgConnecting) return;
    if (!streamActive || intentionalClose) return;

    reconnectAttempts++;
    updateConnectionState(bufferedSeconds() > LONG_OUTAGE_SECONDS ? 'reconnecting-long' : 'reconnecting');

    const delay = Math.min(500 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_BACKOFF_MS);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        if (streamActive && !intentionalClose) connectDeepgram();
    }, delay);
}

function startKeepAlive() {
    stopKeepAlive();
    keepAliveInterval = setInterval(() => {
        if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
            try { dgSocket.send(JSON.stringify({ type: 'KeepAlive' })); } catch (_) {}
        }
    }, 8000);
}

function stopKeepAlive() {
    if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
}

// --- AUDIO ROUTING (send live, buffer when offline) ---

function handlePcm(buffer) {
    if (!isRecording || isPaused) return;
    if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        try { dgSocket.send(buffer); } catch (_) { bufferChunk(buffer); }
    } else {
        bufferChunk(buffer);
    }
}

function bufferChunk(buffer) {
    pendingChunks.push(buffer);
    pendingBytes += buffer.byteLength;

    const hardCapBytes = HARD_BUFFER_SECONDS * deviceSampleRate * 2;
    while (pendingBytes > hardCapBytes && pendingChunks.length > 1) {
        const dropped = pendingChunks.shift();
        pendingBytes -= dropped.byteLength;
    }

    if (bufferedSeconds() > LONG_OUTAGE_SECONDS) updateConnectionState('reconnecting-long');
}

function flushPendingChunks() {
    if (!dgSocket || dgSocket.readyState !== WebSocket.OPEN) return;
    while (pendingChunks.length) {
        const chunk = pendingChunks.shift();
        try { dgSocket.send(chunk); } catch (_) { break; }
    }
    pendingBytes = 0;
}

function bufferedSeconds() {
    return pendingBytes / (deviceSampleRate * 2);
}

// --- TRANSCRIPT HANDLING ---

function handleDeepgramMessage(msg) {
    if (!msg || msg.type !== 'Results') return;
    const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
    const text = alt ? (alt.transcript || '') : '';

    if (msg.is_final) {
        if (text) appendFinalSegment(alt);
        interimTranscript = '';
    } else {
        interimTranscript = text;
    }
    renderLiveTranscript();
}

function appendFinalSegment(alt) {
    const words = alt.words || [];
    if (!words.length || typeof words[0].speaker !== 'number') {
        const text = (alt.transcript || '').trim();
        if (text) finalTranscript += (finalTranscript ? ' ' : '') + text;
        return;
    }
    for (const w of words) {
        const wordText = w.punctuated_word || w.word;
        if (w.speaker !== lastSpeaker) {
            lastSpeaker = w.speaker;
            finalTranscript += (finalTranscript ? '\n' : '') + `Speaker ${w.speaker + 1}: ` + wordText;
        } else {
            finalTranscript += ' ' + wordText;
        }
    }
}

function renderLiveTranscript() {
    const text = (finalTranscript + (interimTranscript ? ' ' + interimTranscript : '')).trim();
    if (!text) {
        transcriptDiv.innerHTML = '<p class="placeholder">Listening… the conversation will appear here live.</p>';
        return;
    }
    // One <p> per line with textContent (not innerHTML) — preserves the speaker
    // line breaks and never executes API-returned content.
    transcriptDiv.innerHTML = '';
    text.split('\n').forEach(line => {
        if (!line.trim()) return;
        const p = document.createElement('p');
        p.textContent = line;
        transcriptDiv.appendChild(p);
    });
    transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
}

function finalizeSession() {
    interimTranscript = '';
    renderLiveTranscript();
    if (finalTranscript.trim()) {
        statusDiv.textContent = 'Session complete';
        hubStatusText.innerText = 'Session ended';
        setAnalysisStatus('RoboDoc has stopped listening. Prompts above remain for your review.');
        // One last look at the full conversation, catching anything said since
        // the previous analysis window.
        runAnalysis(true);
    } else {
        statusDiv.textContent = 'No speech captured';
        hubStatusText.innerText = 'No transcript captured';
        setAnalysisStatus('Nothing was captured — check your microphone and try again.');
    }
}

// --- ROBODOC ANALYSIS LOOP ---

function startAnalysisLoop() {
    stopAnalysisLoop();
    lastAnalyzedLength = 0;
    lastAnalysisTime = 0;
    analysisFailures = 0;
    analysisInterval = setInterval(analysisTick, ANALYSIS_TICK_MS);
}

function stopAnalysisLoop() {
    if (analysisInterval) { clearInterval(analysisInterval); analysisInterval = null; }
    setAnalysisIndicator(false);
}

function analysisTick() {
    if (!isRecording || isPaused || analysisInFlight) return;
    if (analysisFailures >= MAX_ANALYSIS_FAILURES) return;
    if (Date.now() - lastAnalysisTime < MIN_ANALYSIS_GAP_MS) return;
    if (finalTranscript.length - lastAnalyzedLength < MIN_NEW_CHARS) return;
    runAnalysis(false);
}

async function runAnalysis(isFinalPass) {
    const transcript = finalTranscript.trim();
    if (!transcript) return;
    if (isFinalPass && transcript.length - lastAnalyzedLength < 20) return; // nothing meaningful since last pass
    if (analysisInFlight) return;

    analysisInFlight = true;
    const analyzedLength = finalTranscript.length;
    setAnalysisIndicator(true);

    const anonymize = document.getElementById('anonymizeCheckbox')?.checked;
    const content = anonymize ? anonymizeTranscript(transcript) : transcript;

    try {
        const response = await apiFetch('/api/robodoc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                transcript: content,
                existingPrompts: shownPrompts.map(p => p.title)
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `Analysis failed (${response.status})`);
        }

        const data = await response.json();
        analysisFailures = 0;
        lastAnalyzedLength = analyzedLength;
        lastAnalysisTime = Date.now();

        const fresh = (data.prompts || []).filter(p => !isDuplicatePrompt(p.title));
        fresh.forEach(addPromptCard);

        if (shownPrompts.length === 0) {
            setAnalysisStatus('RoboDoc is listening — no prompts needed yet.');
        } else if (fresh.length === 0 && !isFinalPass) {
            setAnalysisStatus('RoboDoc is listening — nothing new to add.');
        }
    } catch (err) {
        console.error('RoboDoc analysis error:', err);
        analysisFailures++;
        lastAnalysisTime = Date.now(); // still wait before retrying
        if (analysisFailures >= MAX_ANALYSIS_FAILURES) {
            setAnalysisStatus('Live prompts unavailable (analysis keeps failing) — transcription continues normally.');
        } else {
            setAnalysisStatus('Analysis hiccup — retrying shortly. Transcription is unaffected.');
        }
    } finally {
        analysisInFlight = false;
        setAnalysisIndicator(false);
    }
}

function isDuplicatePrompt(title) {
    const norm = (title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    return shownPrompts.some(p =>
        p.normTitle === norm || (norm.length > 12 && (p.normTitle.includes(norm) || norm.includes(p.normTitle)))
    );
}

const CATEGORY_META = {
    red_flag: { label: 'Red flag', className: 'robodoc-prompt-redflag' },
    ask:      { label: 'Ask',      className: 'robodoc-prompt-ask' },
    examine:  { label: 'Examine',  className: 'robodoc-prompt-examine' },
    consider: { label: 'Consider', className: 'robodoc-prompt-consider' }
};

function addPromptCard(prompt) {
    const meta = CATEGORY_META[prompt.category] || CATEGORY_META.consider;

    shownPrompts.push({
        category: prompt.category,
        title: prompt.title,
        detail: prompt.detail,
        normTitle: prompt.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
    });

    // Remove the placeholder on first prompt
    const placeholder = promptsFeed.querySelector('.placeholder');
    if (placeholder) placeholder.remove();

    // Built with createElement + textContent so AI output can never run as HTML.
    const card = document.createElement('div');
    card.className = `robodoc-prompt ${meta.className}`;

    const header = document.createElement('div');
    header.className = 'robodoc-prompt-header';

    const badge = document.createElement('span');
    badge.className = 'robodoc-prompt-badge';
    badge.textContent = meta.label;

    const time = document.createElement('span');
    time.className = 'robodoc-prompt-time';
    time.textContent = elapsedLabel();

    header.appendChild(badge);
    header.appendChild(time);

    const title = document.createElement('div');
    title.className = 'robodoc-prompt-title';
    title.textContent = prompt.title;

    card.appendChild(header);
    card.appendChild(title);

    if (prompt.detail) {
        const detail = document.createElement('div');
        detail.className = 'robodoc-prompt-detail';
        detail.textContent = prompt.detail;
        card.appendChild(detail);
    }

    // Newest prompts appear at the top of the feed
    promptsFeed.insertBefore(card, promptsFeed.firstChild);

    if (promptCountEl) {
        promptCountEl.textContent = String(shownPrompts.length);
        promptCountEl.style.display = 'inline-flex';
    }

    setAnalysisStatus(prompt.category === 'red_flag'
        ? 'Red flag surfaced — review the latest prompt.'
        : 'New prompt added.');

    if (window.anime) {
        anime({
            targets: card,
            translateY: [-14, 0],
            opacity: [0, 1],
            duration: 500,
            easing: 'easeOutExpo'
        });
    }
}

function elapsedLabel() {
    if (!recordingStartTime) return '';
    const elapsed = Date.now() - recordingStartTime - pausedDuration;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function resetPrompts() {
    shownPrompts = [];
    promptsFeed.innerHTML = '<p class="placeholder">Prompts will appear here as RoboDoc analyses the conversation — red flags to rule out, questions worth asking and differentials to consider.</p>';
    if (promptCountEl) {
        promptCountEl.textContent = '0';
        promptCountEl.style.display = 'none';
    }
}

function setAnalysisStatus(text) {
    if (analysisStatusEl) analysisStatusEl.textContent = text;
}

function setAnalysisIndicator(active) {
    processingHub.classList.toggle('robodoc-analysing', !!active);
    if (active) hubStatusText.innerText = 'RoboDoc is analysing the conversation…';
    else if (isRecording) hubStatusText.innerText = isPaused ? 'Paused' : 'RoboDoc is listening';
}

function anonymizeTranscript(text) {
    return text
        .replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, '[POSTCODE]')
        .replace(/\b\d{3}\s*\d{3}\s*\d{4}\b/g, '[NHS NUMBER]')
        .replace(/\b07\d{9}\b/g, '[PHONE]');
}

// --- UI STATE ---

function resetTranscriptState() {
    finalTranscript = '';
    interimTranscript = '';
    lastSpeaker = null;
    pendingChunks = [];
    pendingBytes = 0;
    reconnectAttempts = 0;
    transcriptDiv.innerHTML = '<p class="placeholder">Listening… the conversation will appear here live.</p>';
}

function updateConnectionState(state) {
    const dot = processingHub.querySelector('.status-dot');
    processingHub.classList.remove('inactive');
    processingHub.classList.add('active');

    switch (state) {
        case 'connecting':
            hubStatusText.innerText = 'Connecting to transcription service...';
            if (dot) dot.style.background = '';
            break;
        case 'connected':
            hubStatusText.innerText = isPaused ? 'Paused' : 'RoboDoc is listening';
            if (dot) dot.style.background = '';
            if (isRecording) statusDiv.textContent = isPaused ? 'Paused' : 'Listening...';
            break;
        case 'reconnecting':
            hubStatusText.innerText = 'Connection lost — buffering audio, reconnecting...';
            if (dot) dot.style.background = '#f59e0b';
            if (isRecording) statusDiv.textContent = 'Reconnecting...';
            break;
        case 'reconnecting-long':
            hubStatusText.innerText = 'Still reconnecting — audio is being saved locally. Please check your connection.';
            if (dot) dot.style.background = '#ef4444';
            if (isRecording) statusDiv.textContent = 'Reconnecting...';
            break;
    }
}

function updateUI() {
    const recordingOrFinishing = isRecording || finishing;
    statusDiv.classList.toggle('recording', isRecording && !isPaused);
    startBtn.style.display = recordingOrFinishing ? 'none' : 'inline-block';
    pauseBtn.style.display = isRecording ? 'inline-block' : 'none';
    stopBtn.style.display = isRecording ? 'inline-block' : 'none';
    pauseBtn.innerHTML = isPaused
        ? '<span class="pause-icon" aria-hidden="true"></span> Resume'
        : '<span class="pause-icon" aria-hidden="true"></span> Pause';

    const timerEl = document.getElementById('recordingTimer');
    if (isRecording) {
        statusDiv.textContent = isPaused ? 'Paused' : 'Listening...';
        if (timerEl) timerEl.style.display = 'block';
    } else if (!finishing) {
        if (timerEl) timerEl.style.display = 'none';
        if (!finalTranscript) statusDiv.textContent = 'Ready to listen';
    }
}

function startTimer() {
    if (recordingTimer) clearInterval(recordingTimer);
    recordingTimer = setInterval(() => {
        const elapsed = Date.now() - recordingStartTime - pausedDuration;
        const mins = Math.floor(elapsed / 60000);
        const secs = Math.floor((elapsed % 60000) / 1000);
        const timerLabel = document.getElementById('timerElapsed');
        if (timerLabel) timerLabel.innerText = `${mins}:${secs.toString().padStart(2, '0')}`;
    }, 1000);
}

// --- INITIALIZATION ---

document.addEventListener('DOMContentLoaded', () => {
    populateMicrophoneDropdown();
    initializeDarkMode();

    startBtn.addEventListener('click', startRecording);
    pauseBtn.addEventListener('click', pauseRecording);
    stopBtn.addEventListener('click', stopRecording);

    document.getElementById('clearTranscript')?.addEventListener('click', () => {
        finalTranscript = '';
        interimTranscript = '';
        lastSpeaker = null;
        lastAnalyzedLength = 0;
        renderLiveTranscript();
    });

    document.getElementById('clearPrompts')?.addEventListener('click', resetPrompts);

    const micDropdown = document.getElementById('microphoneDropdown');
    if (micDropdown) micDropdown.addEventListener('change', handleMicrophoneSelection);

    updateUI();
});

function initializeDarkMode() {
    const btn = document.getElementById('darkModeCheckbox');
    if (!btn) return;
    if (localStorage.getItem('echodoc-dark-mode') === 'true') {
        document.body.classList.add('dark-mode');
        btn.checked = true;
    }
    btn.addEventListener('change', () => {
        document.body.classList.toggle('dark-mode');
        localStorage.setItem('echodoc-dark-mode', document.body.classList.contains('dark-mode') ? 'true' : 'false');
    });
}
