// File: app.js

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

// State Management
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let isPaused = false;
let finalTranscript = '';
let recordingStartTime = null;
let recordingTimer = null;
let pausedDuration = 0;
let pauseStartTime = null;
let selectedMicId = null;
let telephoneStreams = null;
let sizeMonitorInterval = null;

// UPDATED: More conservative size limits accounting for base64 overhead
const MAX_RAW_AUDIO_SIZE_MB = 3;  // Raw audio limit (becomes ~4MB when base64 encoded)
const MAX_BASE64_SIZE_MB = 4.5;   // Vercel's limit

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

// --- RECORDING LOGIC ---

async function startRecording() {
    try {
        audioChunks = [];
        const telephoneMode = document.getElementById('telephoneModeCheckbox')?.checked;

        let stream;
        if (telephoneMode) {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ 
                video: true, 
                audio: { echoCancellation: true, noiseSuppression: true } 
            });
            const micStream = await navigator.mediaDevices.getUserMedia({ 
                audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true 
            });
            
            const audioContext = new AudioContext();
            const destination = audioContext.createMediaStreamDestination();
            audioContext.createMediaStreamSource(micStream).connect(destination);
            if (screenStream.getAudioTracks().length > 0) {
                audioContext.createMediaStreamSource(screenStream).connect(destination);
            }
            stream = destination.stream;
            telephoneStreams = [screenStream, micStream];
        } else {
            stream = await navigator.mediaDevices.getUserMedia({ 
                audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true 
            });
        }

        // Use more aggressive compression
        let options;
        const preferredCodecs = [
            { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 12000 },
            { mimeType: 'audio/ogg;codecs=opus', audioBitsPerSecond: 12000 },
            { mimeType: 'audio/webm', audioBitsPerSecond: 12000 }
        ];

        for (const codec of preferredCodecs) {
            if (MediaRecorder.isTypeSupported(codec.mimeType)) {
                options = codec;
                break;
            }
        }

        mediaRecorder = new MediaRecorder(stream, options);
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = processRecording;
        mediaRecorder.start();
        
        isRecording = true;
        isPaused = false;
        recordingStartTime = Date.now();
        pausedDuration = 0;
        
        resetWorkflow(); // Lock buttons until this new recording is transcribed
        enableControlButtons();
        updateUI();
        startTimer();
        startSizeMonitor();

    } catch (err) {
        console.error("Error starting recording:", err);
        alert("Could not start recording. Please check permissions and try again.");
        statusDiv.textContent = "Recording failed";
    }
}

function resetWorkflow() {
    processingHub.classList.add('inactive');
    processingHub.classList.remove('active');
    hubStatusText.innerText = "Recording in progress...";
    
    // Disable all AI buttons to prevent calls without a transcript
    [getSummaryBtn, generateReferralBtn, generatePatientSummaryBtn].forEach(btn => {
        btn.disabled = true;
    });
    
    // Clear previous outputs
    transcriptDiv.innerHTML = '<p class="placeholder">Recording in progress...</p>';
    summaryDiv.innerHTML = '<p class="placeholder">Will generate only on command...</p>';
    referralLetterDiv.innerHTML = '<p class="placeholder">Will generate only on command...</p>';
    patientSummaryDiv.innerHTML = '<p class="placeholder">Will generate only on command...</p>';
}

function enableControlButtons() {
    [pauseBtn, stopBtn].forEach(btn => {
        if (btn) {
            btn.disabled = false;
            btn.style.pointerEvents = "auto";
            btn.style.opacity = "1";
        }
    });
}

function pauseRecording() {
    if (!mediaRecorder || !isRecording) return;
    if (!isPaused) {
        mediaRecorder.pause();
        isPaused = true;
        pauseStartTime = Date.now();
        clearInterval(recordingTimer);
    } else {
        mediaRecorder.resume();
        isPaused = false;
        pausedDuration += (Date.now() - pauseStartTime);
        startTimer();
    }
    updateUI();
}

function stopRecording() {
    if (mediaRecorder) {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
        isRecording = false;
        isPaused = false;
        clearInterval(recordingTimer);
        clearInterval(sizeMonitorInterval);
        
        if (telephoneStreams) {
            telephoneStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
            telephoneStreams = null;
        }
        updateUI();
    }
}

// --- TRANSCRIPTION & INDEPENDENT ACTIVATION ---

async function processRecording() {
    statusDiv.textContent = "Preparing audio for transcription...";
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    
    // Check raw audio size
    const rawSizeMB = audioBlob.size / (1024 * 1024);
    console.log(`Raw audio size: ${rawSizeMB.toFixed(2)} MB`);
    
    if (rawSizeMB > MAX_RAW_AUDIO_SIZE_MB) {
        statusDiv.textContent = "Recording too long";
        alert(`Recording is too large (${rawSizeMB.toFixed(1)}MB). Please keep recordings under ${MAX_RAW_AUDIO_SIZE_MB}MB (about ${Math.floor(MAX_RAW_AUDIO_SIZE_MB * 8 * 60 / 12)} minutes).\n\nTip: Record shorter consultations or split long sessions.`);
        return;
    }
    
    try {
        statusDiv.textContent = "Transcribing medical audio...";
        
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
            const base64Audio = reader.result.split(',')[1];
            const base64SizeMB = (base64Audio.length * 0.75) / (1024 * 1024); // Approximate decoded size
            
            console.log(`Base64 size: ${base64SizeMB.toFixed(2)} MB`);
            
            if (base64SizeMB > MAX_BASE64_SIZE_MB) {
                statusDiv.textContent = "Audio file too large";
                alert(`Encoded audio is too large for transmission (${base64SizeMB.toFixed(1)}MB). Maximum is ${MAX_BASE64_SIZE_MB}MB.\n\nPlease record a shorter consultation.`);
                return;
            }
            
            try {
                const response = await fetch('/api/transcribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ audioBlob: base64Audio })
                });

                // Check if response is JSON before parsing
                const contentType = response.headers.get('content-type');
                if (!contentType || !contentType.includes('application/json')) {
                    const errorText = await response.text();
                    console.error('Non-JSON response:', errorText);
                    throw new Error(`Server returned non-JSON response (${response.status}). This may indicate a file size or server error.`);
                }

                const data = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.error || `Transcription failed with status ${response.status}`);
                }
                
                if (data.text) {
                    finalTranscript = data.text;
                    transcriptDiv.innerHTML = `<p>${finalTranscript}</p>`;
                    activateIndependentWorkflow();
                } else {
                    throw new Error('No transcript returned from server');
                }
            } catch (err) {
                console.error('Transcription error:', err);
                statusDiv.textContent = "Transcription failed";
                
                let errorMessage = "Transcription failed. ";
                if (err.message.includes('413') || err.message.includes('Payload Too Large')) {
                    errorMessage += "The audio file is too large. Please record a shorter consultation.";
                } else if (err.message.includes('Failed to fetch') || err.message.includes('network')) {
                    errorMessage += "Network error. Please check your connection and try again.";
                } else {
                    errorMessage += err.message;
                }
                
                alert(errorMessage);
            }
        };
        
        reader.onerror = () => {
            statusDiv.textContent = "Failed to read audio file";
            alert("Failed to process audio file. Please try recording again.");
        };
        
    } catch (err) {
        statusDiv.textContent = "Processing failed";
        console.error('Processing error:', err);
        alert("Failed to process recording: " + err.message);
    }
}

function activateIndependentWorkflow() {
    statusDiv.textContent = "Transcription complete";
    processingHub.classList.remove('inactive');
    processingHub.classList.add('active');
    hubStatusText.innerText = "Ready to generate documents";

    // Enable the individual buttons now that we have a transcript
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

// --- INDEPENDENT AI GENERATION (TOKEN SAVER MODE) ---

async function generateAIContent(type, targetDiv, button) {
    if (!finalTranscript) {
        alert("No transcript available to process.");
        return;
    }

    const originalText = button.innerText;
    button.innerText = "AI Thinking..."; 
    button.disabled = true;
    
    // Provide visual feedback for the specific document area
    targetDiv.style.opacity = "0.5";

    const anonymize = document.getElementById('anonymizeCheckbox')?.checked;
    const contentToProcess = anonymize ? anonymizeTranscript(finalTranscript) : finalTranscript;

    try {
        const response = await fetch('/api/summarize', {
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
            // Split on blank lines into paragraphs so section spacing is preserved,
            // then convert remaining single newlines (e.g. within HPC) to line breaks.
            const html = data.summary
                .split(/\n\s*\n/)
                .map(block => `<p class="summary-block">${block.replace(/\n/g, '<br>')}</p>`)
                .join('');
            targetDiv.innerHTML = html;
        } else {
            throw new Error("No summary returned from AI");
        }
    } catch (err) {
        console.error('AI generation error:', err);
        targetDiv.innerHTML = `<p style="color:red">Failed to generate document: ${err.message}</p>`;
        alert(`Failed to generate ${type} document: ${err.message}`);
    } finally {
        button.innerText = originalText.replace("Generate", "Regenerate");
        button.disabled = false;
        targetDiv.style.opacity = "1";
    }
}

function anonymizeTranscript(text) {
    return text
        .replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, '[POSTCODE]')
        .replace(/\b\d{3}\s*\d{3}\s*\d{4}\b/g, '[NHS NUMBER]')
        .replace(/\b07\d{9}\b/g, '[PHONE]');
}

// --- UI HELPERS ---

function updateUI() {
    startBtn.style.display = isRecording ? 'none' : 'inline-block';
    pauseBtn.style.display = isRecording ? 'inline-block' : 'none';
    stopBtn.style.display = isRecording ? 'inline-block' : 'none';
    pauseBtn.innerText = isPaused ? "Resume" : "Pause";
    
    if (isRecording) {
        statusDiv.textContent = isPaused ? "Paused" : "Recording...";
        document.getElementById('recordingTimer').style.display = 'block';
    } else {
        document.getElementById('recordingTimer').style.display = 'none';
        if (!finalTranscript) {
            statusDiv.textContent = "Ready";
        }
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

function startSizeMonitor() {
    sizeMonitorInterval = setInterval(() => {
        if (audioChunks.length === 0) return;
        const size = new Blob(audioChunks).size / (1024 * 1024);
        const sizeLabel = document.getElementById('timerSize');
        if (sizeLabel) sizeLabel.innerText = `${size.toFixed(1)} MB`;
        
        const progressBar = document.getElementById('progressBar');
        if (progressBar) {
            const percent = Math.min((size / MAX_RAW_AUDIO_SIZE_MB) * 100, 100);
            progressBar.style.width = `${percent}%`;
            
            // Warning color when approaching limit
            if (percent > 80) {
                progressBar.style.background = '#ef4444'; // red
            } else if (percent > 60) {
                progressBar.style.background = '#f59e0b'; // orange
            } else {
                progressBar.style.background = '#0284c7'; // blue
            }
        }
        
        // Auto-stop if too large
        if (size >= MAX_RAW_AUDIO_SIZE_MB) {
            console.warn('Recording size limit reached, auto-stopping');
            stopRecording();
            alert(`Recording stopped automatically - reached ${MAX_RAW_AUDIO_SIZE_MB}MB limit.\n\nProcessing your audio now...`);
        }
    }, 2000);
}

// --- COPY FUNCTIONS ---
function copyToClipboard(elementId) {
    const element = document.getElementById(elementId);
    const text = element.innerText.trim();
    
    // Updated placeholder detection to match actual text
    if (!text || 
        text.length < 20 ||
        text.includes('Type or paste consultation') ||
        text.includes('will appear here') ||
        text.includes('An AI-generated summary') ||
        text.includes('Click "Generate')) {
        return; // Silently skip - no alert
    }
    
    navigator.clipboard.writeText(text)
        .then(() => {
            const copyBtn = event.target;
            const originalHTML = copyBtn.innerHTML;
            
            // Success feedback
            copyBtn.innerHTML = '✓ Copied!';
            copyBtn.style.backgroundColor = '#10b981';
            copyBtn.style.color = 'white';
            
            setTimeout(() => {
                copyBtn.innerHTML = originalHTML;
                copyBtn.style.backgroundColor = '';
                copyBtn.style.color = '';
            }, 2000);
        })
        .catch(err => {
            console.error('Copy error:', err);
            // Don't show alert - copy probably worked anyway
        });
}

// --- INITIALIZATION ---

document.addEventListener('DOMContentLoaded', () => {
    populateMicrophoneDropdown();
    initializeDarkMode();

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
    
    const micDropdown = document.getElementById('microphoneDropdown');
    if (micDropdown) micDropdown.addEventListener('change', handleMicrophoneSelection);

    updateUI();
});

function initializeDarkMode() {
    const btn = document.getElementById('darkModeCheckbox');
    if (!btn) return;
    if (localStorage.getItem('darkMode') === 'enabled') {
        document.body.classList.add('dark-mode');
        btn.checked = true;
    }
    btn.addEventListener('change', () => {
        document.body.classList.toggle('dark-mode');
        localStorage.setItem('darkMode', document.body.classList.contains('dark-mode') ? 'enabled' : 'disabled');
    });
}
