// Letter Dictation App - dictation.js

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
const downloadLetterBtn = document.getElementById('downloadLetter');
const letterTypeSelect = document.getElementById('letterType');

// State
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let isPaused = false;
let finalTranscript = '';
let formattedLetter = '';
let recordingStartTime = null;
let recordingTimer = null;
let selectedMicId = null;
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
        dropdown.innerHTML = '<option value="">Microphone access denied</option>';
        dropdown.disabled = true;
        statusDiv.textContent = 'Microphone access denied — please allow access in your browser settings and refresh the page.';
    }
}

function handleMicrophoneSelection() {
    const dropdown = document.getElementById('microphoneDropdown');
    if (dropdown) selectedMicId = dropdown.value;
}

// --- RECORDING LOGIC ---

async function startRecording() {
    try {
        const constraints = {
            audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
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
        audioChunks = [];
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = processRecording;
        mediaRecorder.start();
        
        isRecording = true;
        isPaused = false;
        recordingStartTime = Date.now();
        
        // Reset button state for new session
        if (formatLetterBtn) {
            formatLetterBtn.disabled = true;
        }

        updateUI();
        startTimer();
        startSizeMonitor();
        
    } catch (err) {
        console.error("Error starting recording:", err);
        statusDiv.textContent = "Recording failed";
        alert("Could not start recording. Please check microphone permissions and try again.");
    }
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
        isRecording = false;
        isPaused = false;
        clearInterval(recordingTimer);
        clearInterval(sizeMonitorInterval);
        updateUI();
    }
}

async function processRecording() {
    statusDiv.textContent = "Preparing audio for transcription...";
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    
    // Check raw audio size
    const rawSizeMB = audioBlob.size / (1024 * 1024);
    console.log(`Raw audio size: ${rawSizeMB.toFixed(2)} MB`);
    
    if (rawSizeMB > MAX_RAW_AUDIO_SIZE_MB) {
        statusDiv.textContent = "Recording too long";
        alert(`Recording is too large (${rawSizeMB.toFixed(1)}MB). Please keep recordings under ${MAX_RAW_AUDIO_SIZE_MB}MB (about ${Math.floor(MAX_RAW_AUDIO_SIZE_MB * 8 * 60 / 12)} minutes).\n\nTip: Dictate shorter letters or split long content.`);
        return;
    }
    
    try {
        statusDiv.textContent = "Transcribing dictation...";
        
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
            const base64Audio = reader.result.split(',')[1];
            const base64SizeMB = (base64Audio.length * 0.75) / (1024 * 1024);
            
            console.log(`Base64 size: ${base64SizeMB.toFixed(2)} MB`);
            
            if (base64SizeMB > MAX_BASE64_SIZE_MB) {
                statusDiv.textContent = "Audio file too large";
                alert(`Encoded audio is too large for transmission (${base64SizeMB.toFixed(1)}MB). Maximum is ${MAX_BASE64_SIZE_MB}MB.\n\nPlease dictate a shorter letter.`);
                return;
            }
            
            try {
                const response = await apiFetch('/api/transcribe', {
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
                    finalTranscript = data.text.trim();

                    // Update Transcript Text (textContent — never execute API content)
                    transcriptDiv.textContent = finalTranscript;
                    
                    // ENABLE the Generate button
                    if (formatLetterBtn) {
                        formatLetterBtn.disabled = false;
                        statusDiv.textContent = "Transcription ready. Click 'Generate Letter'.";
                    }
                } else {
                    throw new Error('No transcript returned from API');
                }
            } catch (err) {
                console.error('Transcription error:', err);
                statusDiv.textContent = "Transcription failed";
                
                let errorMessage = "Transcription failed. ";
                if (err.message.includes('413') || err.message.includes('Payload Too Large')) {
                    errorMessage += "The audio file is too large. Please dictate a shorter letter.";
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

// --- AI FORMATTING ---

async function formatLetter() {
    // 1. Grab text directly from the transcription box
    const transcriptBox = document.getElementById('transcript');
    const rawText = transcriptBox ? transcriptBox.innerText.trim() : "";

    // 2. Safety check: Don't run if empty or placeholder
    if (!rawText || rawText.includes("Your dictation will appear")) {
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

function updateUI() {
    startBtn.style.display = isRecording ? 'none' : 'flex';
    pauseBtn.style.display = isRecording ? 'flex' : 'none';
    stopBtn.style.display = isRecording ? 'flex' : 'none';
    statusDiv.textContent = isRecording ? (isPaused ? "Paused" : "Recording...") : "Ready";
    
    if (isRecording) {
        statusDiv.classList.add('recording');
    } else {
        statusDiv.classList.remove('recording');
    }
}

function startTimer() {
    const timerDisplay = document.getElementById('timerElapsed');
    if (recordingTimer) clearInterval(recordingTimer);
    
    recordingTimer = setInterval(() => {
        const elapsed = Date.now() - recordingStartTime;
        const mins = Math.floor(elapsed / 60000);
        const secs = Math.floor((elapsed % 60000) / 1000);
        if (timerDisplay) timerDisplay.innerText = `${mins}:${secs.toString().padStart(2, '0')}`;
    }, 1000);
}

function startSizeMonitor() {
    sizeMonitorInterval = setInterval(() => {
        if (audioChunks.length === 0) return;
        const size = new Blob(audioChunks).size / (1024 * 1024);
        
        // Auto-stop if too large
        if (size >= MAX_RAW_AUDIO_SIZE_MB) {
            console.warn('Recording size limit reached, auto-stopping');
            stopRecording();
            alert(`Recording stopped automatically - reached ${MAX_RAW_AUDIO_SIZE_MB}MB limit.\n\nProcessing your audio now...`);
        }
    }, 2000);
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
    stopBtn.addEventListener('click', stopRecording);
    
    // Attach event listener to the correct button
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
                transcriptDiv.innerHTML = '<p class="placeholder">Your dictation will appear here...</p>';
                finalTranscript = '';
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
