// File: app.js
// Live streaming scribe: captures microphone (and optional telephone/screen)
// audio, streams raw linear16 PCM to Deepgram over a WebSocket, and renders the
// transcript live. Resilient to connection loss via local buffering + auto-reconnect.

// DOM Elements - Navigation & Controls
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');

// DOM Elements - Content Areas
const transcriptDiv = document.getElementById('transcript');
const summaryDiv = document.getElementById('summary');
const referralLetterDiv = document.getElementById('referralLetter');
const patientSummaryDiv = document.getElementById('patientSummary');

// DOM Elements - AI Buttons
const getSummaryBtn = document.getElementById('getSummary');
const generateReferralBtn = document.getElementById('generateReferral');
const generatePatientSummaryBtn = document.getElementById('generatePatientSummary');

// DOM Elements - Hub
const processingHub = document.getElementById('processingHub');
const hubStatusText = document.getElementById('hubStatusText');

// --- STATE ---
let audioContext = null;
let workletNode = null;
let mediaStreams = [];          // streams whose tracks we must stop on finish
let deviceSampleRate = 48000;

let dgSocket = null;            // active Deepgram WebSocket (null when disconnected)
let dgConnecting = false;       // guard against parallel connect attempts

let isRecording = false;        // actively capturing audio
let streamActive = false;       // we want a live connection (recording OR finishing-flush)
let isPaused = false;
let finishing = false;          // stop pressed, flushing the tail
let intentionalClose = false;   // true when we deliberately close (suppress reconnect)

let finalTranscript = '';       // accumulated finalized text (feeds the AI generation)
let interimTranscript = '';     // current in-progress partial
let lastSpeaker = null;         // last diarized speaker id, so labels only appear on change

let pendingChunks = [];         // PCM buffered while disconnected
let pendingBytes = 0;
let reconnectAttempts = 0;
let reconnectTimer = null;
let keepAliveInterval = null;
let finishTimeout = null;

let recordingStartTime = null;
let recordingTimer = null;
let wakeLock = null;            // screen wake lock held while recording
let pausedDuration = 0;
let pauseStartTime = null;
let selectedMicId = null;

// Cap how much disconnected audio we hold in memory. Oldest is dropped beyond
// the hard cap so a very long outage can't exhaust memory.
const MAX_RECONNECT_BACKOFF_MS = 5000;
const LONG_OUTAGE_SECONDS = 120;     // escalate the warning past this
const HARD_BUFFER_SECONDS = 600;     // ~10 min; drop oldest beyond this

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
// Stops the screen locking mid-consultation, which would suspend the tab and
// kill the recording. Best-effort: recording still works if unsupported.

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

// The browser silently releases the lock when the tab is hidden; re-acquire it
// when the user returns if we are still recording.
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
        console.error('Error detecting microphones:', error);
        statusDiv.textContent = 'Microphone access denied. Please allow microphone access.';
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
        resetWorkflow();

        const telephoneMode = document.getElementById('telephoneModeCheckbox')?.checked;

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

        if (telephoneMode) {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: { echoCancellation: true, noiseSuppression: true }
            });
            const micStream = await navigator.mediaDevices.getUserMedia({
                audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true
            });
            mediaStreams.push(screenStream, micStream);
            audioContext.createMediaStreamSource(micStream).connect(workletNode);
            if (screenStream.getAudioTracks().length > 0) {
                audioContext.createMediaStreamSource(screenStream).connect(workletNode);
            }
        } else {
            const micStream = await navigator.mediaDevices.getUserMedia({
                audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true
            });
            mediaStreams.push(micStream);
            audioContext.createMediaStreamSource(micStream).connect(workletNode);
        }

        isRecording = true;
        isPaused = false;
        streamActive = true;
        finishing = false;
        intentionalClose = false;
        recordingStartTime = Date.now();
        pausedDuration = 0;

        enableControlButtons();
        updateUI();
        startTimer();
        acquireWakeLock();

        connectDeepgram(); // self-retrying; audio buffers locally until connected

    } catch (err) {
        console.error('Error starting recording:', err);
        alert('Could not start recording. Please check microphone permissions and try again.');
        statusDiv.textContent = 'Recording failed';
        stopAudioCapture();
        releaseWakeLock();
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

    stopAudioCapture(); // no more PCM will be produced
    releaseWakeLock();

    updateUI();
    statusDiv.textContent = 'Finalising transcription...';

    // Flush whatever we can to Deepgram, then close gracefully.
    const cleanup = () => {
        clearTimeout(finishTimeout);
        streamActive = false;
        finishing = false;
        intentionalClose = true;
        stopKeepAlive();
        clearTimeout(reconnectTimer);
        if (dgSocket) { try { dgSocket.close(); } catch (_) {} dgSocket = null; }
        updateUI();
        finalizeWorkflow();
    };

    if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        flushPendingChunks();
        try { dgSocket.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {}
        // Give Deepgram a moment to return the final results, then clean up.
        finishTimeout = setTimeout(cleanup, 2000);
    } else if (pendingChunks.length > 0) {
        // Disconnected right at the end but we still hold buffered audio.
        // Keep the reconnect loop alive briefly so it can flush the tail.
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
        const socket = new WebSocket(
            `wss://api.deepgram.com/v1/listen?${params.toString()}`,
            ['token', token]
        );
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => {
            dgConnecting = false;
            dgSocket = socket;
            reconnectAttempts = 0;
            updateConnectionState('connected');
            flushPendingChunks();      // send anything buffered during the outage
            startKeepAlive();
            if (finishing) {
                // We reconnected only to flush the tail — ask Deepgram to finalise.
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
            // 'close' will follow and drive any reconnect.
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
    // Deepgram closes idle sockets after ~10s; this keeps the stream alive
    // during silence or while paused.
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
    if (!isRecording || isPaused) return; // drop audio while paused/stopped
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

// Append a finalized segment word-by-word, inserting a "Speaker N:" label on a
// new line whenever the diarized speaker changes. Falls back to plain text if
// no per-word speaker data is present.
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
        transcriptDiv.innerHTML = '<p class="placeholder">Listening… your words will appear here live.</p>';
        return;
    }
    // One <p> per line with textContent (not innerHTML) — preserves the speaker
    // line breaks and never executes API-returned content. See XSS fix.
    transcriptDiv.innerHTML = '';
    text.split('\n').forEach(line => {
        if (!line.trim()) return;
        const p = document.createElement('p');
        p.textContent = line;
        transcriptDiv.appendChild(p);
    });
    transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
}

function finalizeWorkflow() {
    interimTranscript = '';
    renderLiveTranscript();
    if (finalTranscript.trim()) {
        statusDiv.textContent = 'Transcription complete';
        activateIndependentWorkflow();
    } else {
        statusDiv.textContent = 'No speech captured';
        hubStatusText.innerText = 'No transcript captured';
    }
}

function activateIndependentWorkflow() {
    processingHub.classList.remove('inactive');
    processingHub.classList.add('active');
    hubStatusText.innerText = 'Ready to generate documents';

    const dot = processingHub.querySelector('.status-dot');
    if (dot) dot.style.background = '';

    [getSummaryBtn, generateReferralBtn, generatePatientSummaryBtn].forEach(btn => {
        btn.disabled = false;
    });

    if (window.anime) {
        anime({
            targets: '#processingHub',
            translateY: [-20, 0],
            opacity: [0, 1],
            duration: 800,
            easing: 'easeOutExpo'
        });
    }
}

// --- WORKFLOW / UI STATE ---

function resetTranscriptState() {
    finalTranscript = '';
    interimTranscript = '';
    lastSpeaker = null;
    pendingChunks = [];
    pendingBytes = 0;
    reconnectAttempts = 0;
}

function resetWorkflow() {
    [getSummaryBtn, generateReferralBtn, generatePatientSummaryBtn].forEach(btn => {
        btn.disabled = true;
    });
    transcriptDiv.innerHTML = '<p class="placeholder">Listening… your words will appear here live.</p>';
    summaryDiv.innerHTML = '<p class="placeholder">Will generate only on command...</p>';
    referralLetterDiv.innerHTML = '<p class="placeholder">Will generate only on command...</p>';
    patientSummaryDiv.innerHTML = '<p class="placeholder">Will generate only on command...</p>';
}

function enableControlButtons() {
    [pauseBtn, stopBtn].forEach(btn => {
        if (btn) {
            btn.disabled = false;
            btn.style.pointerEvents = 'auto';
            btn.style.opacity = '1';
        }
    });
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
            hubStatusText.innerText = isPaused ? 'Paused' : 'Live transcription active';
            if (dot) dot.style.background = '';
            if (isRecording) statusDiv.textContent = isPaused ? 'Paused' : 'Recording...';
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
    startBtn.style.display = recordingOrFinishing ? 'none' : 'inline-block';
    pauseBtn.style.display = isRecording ? 'inline-block' : 'none';
    stopBtn.style.display = isRecording ? 'inline-block' : 'none';
    pauseBtn.innerHTML = isPaused
        ? '<span class="pause-icon" aria-hidden="true"></span> Resume'
        : '<span class="pause-icon" aria-hidden="true"></span> Pause';

    const timerEl = document.getElementById('recordingTimer');
    if (isRecording) {
        statusDiv.textContent = isPaused ? 'Paused' : 'Recording...';
        if (timerEl) timerEl.style.display = 'block';
    } else if (!finishing) {
        if (timerEl) timerEl.style.display = 'none';
        if (!finalTranscript) statusDiv.textContent = 'Ready';
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

// --- INDEPENDENT AI GENERATION (TOKEN SAVER MODE) ---

// Read the transcript from the on-screen box (not the internal variable) so
// any manual corrections the clinician typed are included in generation.
function getCurrentTranscript() {
    if (!transcriptDiv.querySelector('.placeholder')) {
        const edited = transcriptDiv.innerText.trim();
        if (edited) return edited;
    }
    return finalTranscript.trim();
}

async function generateAIContent(type, targetDiv, button) {
    const transcript = getCurrentTranscript();
    if (!transcript) {
        alert('No transcript available to process.');
        return;
    }

    const originalText = button.innerText;
    button.innerText = 'AI Thinking...';
    button.disabled = true;
    targetDiv.style.opacity = '0.5';

    const anonymize = document.getElementById('anonymizeCheckbox')?.checked;
    const contentToProcess = anonymize ? anonymizeTranscript(transcript) : transcript;

    try {
        const response = await apiFetch('/api/summarize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcript: contentToProcess, type: type })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `AI generation failed (${response.status})`);
        }

        const data = await response.json();

        if (data.summary) {
            // Build the output with textContent per line so API content can never
            // execute as HTML, while preserving line breaks.
            targetDiv.innerHTML = '';
            data.summary.split('\n').forEach(line => {
                const p = document.createElement('p');
                p.textContent = line;
                targetDiv.appendChild(p);
            });
        } else {
            throw new Error('No summary returned from AI');
        }
    } catch (err) {
        console.error('AI generation error:', err);
        targetDiv.textContent = `Failed to generate document: ${err.message}`;
        targetDiv.style.color = 'red';
        alert(`Failed to generate ${type} document: ${err.message}`);
    } finally {
        button.innerText = originalText.replace('Generate', 'Regenerate');
        button.disabled = false;
        targetDiv.style.opacity = '1';
    }
}

function anonymizeTranscript(text) {
    return text
        .replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, '[POSTCODE]')
        .replace(/\b\d{3}\s*\d{3}\s*\d{4}\b/g, '[NHS NUMBER]')
        .replace(/\b07\d{9}\b/g, '[PHONE]');
}

// --- COPY FUNCTIONS ---

function copyToClipboard(elementId) {
    const element = document.getElementById(elementId);
    const text = element.innerText.trim();

    if (!text ||
        text.length < 20 ||
        text.includes('Type or paste consultation') ||
        text.includes('will appear here') ||
        text.includes('An AI-generated summary') ||
        text.includes('Click "Generate')) {
        return;
    }

    navigator.clipboard.writeText(text)
        .then(() => {
            const copyBtn = event.currentTarget;
            const originalHTML = copyBtn.innerHTML;

            copyBtn.innerHTML = '<svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
            copyBtn.classList.add('is-copied');

            setTimeout(() => {
                copyBtn.innerHTML = originalHTML;
                copyBtn.classList.remove('is-copied');
            }, 2000);
        })
        .catch(err => {
            console.error('Copy error:', err);
        });
}

// --- INITIALIZATION ---

document.addEventListener('DOMContentLoaded', () => {
    populateMicrophoneDropdown();
    initializeDarkMode();

    // The streaming pipeline has no upload size limit, so hide the size meter.
    const progressContainer = document.querySelector('.progress-bar-container');
    if (progressContainer) progressContainer.style.display = 'none';

    // Session Management Listeners
    startBtn.addEventListener('click', startRecording);
    pauseBtn.addEventListener('click', pauseRecording);
    stopBtn.addEventListener('click', stopRecording);

    // INDEPENDENT Trigger Listeners (Cost control)
    getSummaryBtn.addEventListener('click', () =>
        generateAIContent('clinical', summaryDiv, getSummaryBtn));

    generateReferralBtn.addEventListener('click', () =>
        generateAIContent('referral', referralLetterDiv, generateReferralBtn));

    generatePatientSummaryBtn.addEventListener('click', () =>
        generateAIContent('patient', patientSummaryDiv, generatePatientSummaryBtn));

    // Copy button listeners
    document.getElementById('copySummary')?.addEventListener('click', () => copyToClipboard('summary'));
    document.getElementById('copyReferral')?.addEventListener('click', () => copyToClipboard('referralLetter'));
    document.getElementById('copyPatientSummary')?.addEventListener('click', () => copyToClipboard('patientSummary'));

    // Clear transcript
    document.getElementById('clearTranscript')?.addEventListener('click', () => {
        finalTranscript = '';
        interimTranscript = '';
        lastSpeaker = null;
        renderLiveTranscript();
    });

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
