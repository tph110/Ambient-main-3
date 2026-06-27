// File: notes-referral.js
// Frontend logic for the Notes to Referral page

// --- DOM ELEMENTS ---
const generateBtn = document.getElementById('generateBtn');
const copyBtn = document.getElementById('copyBtn');
const clearBtn = document.getElementById('clearBtn');
const notesInput = document.getElementById('notesInput');
const instructionsInput = document.getElementById('instructionsInput');
const letterOutput = document.getElementById('letterOutput');
const statusMsg = document.getElementById('statusMsg');
const darkModeCheckbox = document.getElementById('darkModeCheckbox');
const copyBtnDefaultHtml = copyBtn.innerHTML;

// --- DARK MODE ---
function applyDarkMode(enabled) {
    if (enabled) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
}

// Load saved dark mode preference (shared with rest of app)
const savedDark = localStorage.getItem('echodoc-dark-mode') === 'true';
darkModeCheckbox.checked = savedDark;
applyDarkMode(savedDark);

darkModeCheckbox.addEventListener('change', () => {
    applyDarkMode(darkModeCheckbox.checked);
    localStorage.setItem('echodoc-dark-mode', darkModeCheckbox.checked);
});

// --- STATUS HELPERS ---
function showStatus(message, type = 'info') {
    statusMsg.textContent = message;
    statusMsg.style.display = 'block';
    statusMsg.style.color =
        type === 'error' ? 'var(--error-color)' :
        type === 'success' ? 'var(--success-color)' :
        'var(--text-secondary)';
}

function hideStatus() {
    statusMsg.style.display = 'none';
}

// --- PLACEHOLDER HANDLING ---
function clearPlaceholder() {
    if (letterOutput.querySelector('.placeholder')) {
        letterOutput.innerHTML = '';
    }
}

function restorePlaceholder() {
    if (letterOutput.textContent.trim() === '') {
        letterOutput.innerHTML = '<p class="placeholder">Your referral letter will appear here. You can edit it before copying.</p>';
    }
}

// --- GENERATE REFERRAL LETTER ---
generateBtn.addEventListener('click', async () => {
    const notes = notesInput.value.trim();
    const instructions = instructionsInput.value.trim();

    if (!notes) {
        showStatus('Please paste your consultation notes before generating.', 'error');
        notesInput.focus();
        return;
    }

    // UI: loading state
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating letter…';
    showStatus('Calling AI — this usually takes 5–15 seconds...', 'info');
    clearPlaceholder();
    letterOutput.textContent = '';

    try {
        const response = await apiFetch('/api/notes-to-referral', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes, instructions })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `Server error (${response.status})`);
        }

        // Display the letter, preserving line breaks. Each line is set via
        // textContent so API content can never execute as HTML.
        letterOutput.innerHTML = '';
        data.letter.split('\n').forEach(line => {
            const p = document.createElement('p');
            if (line) {
                p.textContent = line;
            } else {
                p.innerHTML = '&nbsp;';
            }
            letterOutput.appendChild(p);
        });

        showStatus('Letter generated. Review, edit if needed, then copy.', 'success');

        // Scroll output into view on mobile
        letterOutput.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (error) {
        console.error('Generation error:', error);
        restorePlaceholder();
        showStatus(`Error: ${error.message}`, 'error');
    } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate referral letter';
    }
});

// --- COPY TO CLIPBOARD ---
copyBtn.addEventListener('click', async () => {
    const text = letterOutput.innerText.trim();

    if (!text || letterOutput.querySelector('.placeholder')) {
        showStatus('Nothing to copy yet — generate a letter first.', 'error');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        copyBtn.innerHTML = '<svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
        copyBtn.classList.add('is-copied');
        showStatus('Copied to clipboard.', 'success');
        setTimeout(() => {
            copyBtn.innerHTML = copyBtnDefaultHtml;
            copyBtn.classList.remove('is-copied');
            hideStatus();
        }, 2000);
    } catch {
        showStatus('Copy failed — please select and copy the text manually.', 'error');
    }
});

// --- CLEAR OUTPUT ---
clearBtn.addEventListener('click', () => {
    restorePlaceholder();
    hideStatus();
});
