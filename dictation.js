// Letter Dictation App - dictation.js
// Live streaming dictation: captures microphone audio, streams raw linear16
// PCM to Deepgram over a WebSocket (same resilient pipeline as the Clinical
// Scribe) and renders the transcript live as the clinician speaks.
// Deepgram's dictation mode converts spoken commands ("full stop", "comma",
// "new paragraph") into real punctuation. No upload size limit — audio never
// passes through the server.

// DOM Elements
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const transcriptDiv = document.getElementById('transcript');
const formattedLetterDiv = document.getElementById('formattedLetter');
const statusDiv = document.getElementById('status');
const formatLetterBtn = document.getElementById('formatLetterBtn');
const clearTranscriptBtn = document.getElementById('clearTranscript');
const copyLetterBtn = document.getElementById('copyLetter');
const connectionStatus = document.getElementById('connectionStatus');

// --- STATE ---
let audioContext = null;
let workletNode = null;
let mediaStreams = [];
let deviceSampleRate = 48000;

let dgSocket = null;            // active Deepgram WebSocket (null when disconnected)
let dgConnecting = false;       // guard against parallel connect attempts

let isRecording = false;
let streamActive = false;       // we want a live connection (recording OR finishing-flush)
let isPaused = false;
let finishing = false;          // stop pressed, flushing the tail
let intentionalClose = false;   // true when we deliberately close (suppress reconnect)

let finalTranscript = '';       // accumulated finalized text
let interimTranscript = '';     // current in-progress partial

let pendingChunks = [];         // PCM buffered while disconnected
let pendingBytes = 0;
let reconnectAttempts = 0;
let reconnectTimer = null;
let keepAliveInterval = null;
let finishTimeout = null;

let wakeLock = null;            // screen wake lock held while dictating
let selectedMicId = null;

// Cap how much disconnected audio we hold in memory. Oldest is dropped beyond
// the hard cap so a very long outage can't exhaust memory.
const MAX_RECONNECT_BACKOFF_MS = 5000;
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
        // Permission not granted yet (or dismissed) — stay calm. It is
        // requested again on Start, and a real failure is reported there.
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
        if (formatLetterBtn) formatLetterBtn.disabled = true;

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

        updateUI();
        acquireWakeLock();

        connectDeepgram(); // self-retrying; audio buffers locally until connected

    } catch (err) {
        console.error('Error starting dictation:', err);
        alert('Could not start dictation. Please check microphone permissions and try again.');
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
        if (audioContext) audioContext.suspend().catch(() => {});
    } else {
        isPaused = false;
        if (audioContext) audioContext.resume().catch(() => {});
    }
    updateUI();
    if (dgSocket && dgSocket.readyState === WebSocket.OPEN) updateConnectionState('connected');
}

function stopRecording() {
    if (!isRecording) return;

    isRecording = false;
    isPaused = false;
    finishing = true;

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
        finalizeDictation();
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
            dictation: 'true',       // spoken "full stop" / "new paragraph" become punctuation
            numerals: 'true',
            diarize: 'false',        // single speaker
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
    updateConnectionState('reconnecting');

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
}

function flushPendingChunks() {
    if (!dgSocket || dgSocket.readyState !== WebSocket.OPEN) return;
    while (pendingChunks.length) {
        const chunk = pendingChunks.shift();
        try { dgSocket.send(chunk); } catch (_) { break; }
    }
    pendingBytes = 0;
}

// --- TRANSCRIPT HANDLING ---

function handleDeepgramMessage(msg) {
    if (!msg || msg.type !== 'Results') return;
    const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
    const text = alt ? (alt.transcript || '') : '';

    if (msg.is_final) {
        if (text.trim()) {
            finalTranscript += (finalTranscript ? ' ' : '') + text.trim();
        }
        interimTranscript = '';
    } else {
        interimTranscript = text;
    }
    renderLiveTranscript();
}

function renderLiveTranscript() {
    const text = (finalTranscript + (interimTranscript ? ' ' + interimTranscript : '')).trim();
    if (!text) {
        transcriptDiv.innerHTML = '<p class="placeholder">Listening… your dictation will appear here live.</p>';
        return;
    }
    // One <p> per line with textContent (not innerHTML) — preserves paragraph
    // breaks from dictation mode and never executes API-returned content.
    transcriptDiv.innerHTML = '';
    text.split('\n').forEach(line => {
        if (!line.trim()) return;
        const p = document.createElement('p');
        p.textContent = line;
        transcriptDiv.appendChild(p);
    });
    transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
}

function finalizeDictation() {
    interimTranscript = '';
    renderLiveTranscript();
    if (finalTranscript.trim()) {
        if (formatLetterBtn) formatLetterBtn.disabled = false;
        statusDiv.textContent = "Transcription ready. Click 'Generate letter'.";
    } else {
        statusDiv.textContent = 'No speech captured';
    }
}

function resetTranscriptState() {
    finalTranscript = '';
    interimTranscript = '';
    pendingChunks = [];
    pendingBytes = 0;
    reconnectAttempts = 0;
    transcriptDiv.innerHTML = '<p class="placeholder">Listening… your dictation will appear here live.</p>';
}

// --- AI FORMATTING ---

async function formatLetter() {
    // 1. Grab text directly from the transcription box so any manual
    //    corrections the clinician typed are included.
    const transcriptBox = document.getElementById('transcript');
    const rawText = transcriptBox ? transcriptBox.innerText.trim() : "";

    // 2. Safety check: Don't run if empty or placeholder
    if (!rawText || rawText.includes("your dictation will appear")) {
        alert("Please dictate some text first!");
        return;
    }

    // 3. UI Feedback
    const btn = formatLetterBtn;
    const outputArea = document.getElementById('formattedLetter');
    const originalText = btn.innerHTML;

    btn.innerHTML = "Formatting letter…";
    btn.disabled = true;
    outputArea.style.opacity = "0.5";
    statusDiv.textContent = "Generating formatted letter...";

    try {
        const response = await apiFetch('/api/format-letter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                transcript: rawText,
                letterType: document.getElementById('letterType').value
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.letter) {
            // Success! Render line-by-line via text nodes so API content can
            // never execute as HTML, while preserving line breaks.
            outputArea.textContent = '';
            data.letter.split('\n').forEach((line, i) => {
                if (i > 0) outputArea.appendChild(document.createElement('br'));
                outputArea.appendChild(document.createTextNode(line));
            });
            statusDiv.textContent = "Letter generated successfully.";
            btn.innerHTML = "Regenerate letter";
        } else {
            throw new Error('No letter returned from API');
        }
    } catch (err) {
        console.error("Error:", err);
        statusDiv.textContent = "Letter generation failed.";
        btn.innerHTML = originalText;
        alert("AI formatting failed: " + err.message + "\n\nPlease check your connection and try again.");
    } finally {
        // Reset button
        btn.disabled = false;
        outputArea.style.opacity = "1";
    }
}

// --- UI HELPERS & LISTENERS ---

function updateConnectionState(state) {
    const dot = connectionStatus ? connectionStatus.querySelector('.status-dot') : null;
    switch (state) {
        case 'connecting':
            if (isRecording) statusDiv.textContent = 'Connecting...';
            if (dot) dot.style.background = '';
            break;
        case 'connected':
            if (isRecording) statusDiv.textContent = isPaused ? 'Paused' : 'Dictating...';
            if (dot) dot.style.background = '';
            break;
        case 'reconnecting':
            if (isRecording) statusDiv.textContent = 'Reconnecting — audio is being saved locally...';
            if (dot) dot.style.background = '#f59e0b';
            break;
    }
}

function updateUI() {
    const recordingOrFinishing = isRecording || finishing;
    statusDiv.classList.toggle('recording', isRecording && !isPaused);
    startBtn.style.display = recordingOrFinishing ? 'none' : 'flex';
    pauseBtn.style.display = isRecording ? 'flex' : 'none';
    stopBtn.style.display = isRecording ? 'flex' : 'none';
    pauseBtn.innerHTML = isPaused
        ? '<span class="pause-icon"></span> Resume'
        : '<span class="pause-icon"></span> Pause';

    if (isRecording) {
        statusDiv.textContent = isPaused ? 'Paused' : 'Dictating...';
    } else if (!finishing && !finalTranscript) {
        statusDiv.textContent = 'Ready to dictate';
    }
}

function copyLetter() {
    const text = formattedLetterDiv.innerText;
    if (!text || text.includes("Formatted letter will appear")) {
        alert("No letter to copy yet!");
        return;
    }

    navigator.clipboard.writeText(text).then(() => {
        const originalText = copyLetterBtn.innerHTML;
        copyLetterBtn.innerHTML = '<svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
        copyLetterBtn.classList.add('is-copied');
        setTimeout(() => {
            copyLetterBtn.innerHTML = originalText;
            copyLetterBtn.classList.remove('is-copied');
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy:', err);
        alert('Failed to copy to clipboard');
    });
}

// --- INITIALIZATION ---

document.addEventListener('DOMContentLoaded', () => {
    populateMicrophoneDropdown();

    startBtn.addEventListener('click', startRecording);
    pauseBtn.addEventListener('click', pauseRecording);
    stopBtn.addEventListener('click', stopRecording);

    if (formatLetterBtn) {
        formatLetterBtn.addEventListener('click', formatLetter);
    }

    if (copyLetterBtn) {
        copyLetterBtn.addEventListener('click', copyLetter);
    }

    // Clear functionality
    if (clearTranscriptBtn) {
        clearTranscriptBtn.addEventListener('click', () => {
            if (confirm("Clear transcription?")) {
                transcriptDiv.innerHTML = '<p class="placeholder">Your dictation will appear here as raw text...</p>';
                finalTranscript = '';
                interimTranscript = '';
                if (formatLetterBtn) {
                    formatLetterBtn.disabled = true;
                }
            }
        });
    }

    const micDropdown = document.getElementById('microphoneDropdown');
    if (micDropdown) micDropdown.addEventListener('change', handleMicrophoneSelection);

    updateUI();
});
