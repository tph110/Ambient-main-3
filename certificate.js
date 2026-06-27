// File: certificate.js
// Frontend logic for the Oxford Medical Certificate generator

const generateBtn = document.getElementById('generateBtn');
const copyBtn = document.getElementById('copyBtn');
const clearBtn = document.getElementById('clearBtn');
const notesInput = document.getElementById('notesInput');
const certificateOutput = document.getElementById('certificateOutput');
const statusMsg = document.getElementById('statusMsg');
const darkModeCheckbox = document.getElementById('darkModeCheckbox');
const copyBtnDefaultHtml = copyBtn.innerHTML;

// --- DARK MODE ---
const savedDark = localStorage.getItem('echodoc-dark-mode') === 'true';
darkModeCheckbox.checked = savedDark;
if (savedDark) document.body.classList.add('dark-mode');

darkModeCheckbox.addEventListener('change', () => {
    document.body.classList.toggle('dark-mode', darkModeCheckbox.checked);
    localStorage.setItem('echodoc-dark-mode', darkModeCheckbox.checked);
});

// --- SECURITY: escape AI-generated values before inserting into HTML ---
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// --- STATUS HELPERS ---
function showStatus(message, type = 'info') {
    statusMsg.textContent = message;
    statusMsg.style.display = 'block';
    statusMsg.style.color =
        type === 'error' ? 'var(--error-color)' :
        type === 'success' ? 'var(--success-color)' :
        'var(--text-secondary)';
}

function val(text) {
    if (!text || text.trim() === '' || text.trim().toLowerCase() === 'none') return null;
    return text.trim();
}

function fieldHtml(label, value, highlight = false) {
    const isEmpty = !val(value);
    return `
        <div class="cert-field">
            <div class="cert-label">${label}</div>
            <div class="cert-value ${isEmpty ? 'empty' : ''} ${highlight ? 'highlight' : ''}">
                ${isEmpty ? 'Not mentioned in notes' : escapeHtml(val(value))}
            </div>
        </div>`;
}

function impactHtml(label, value) {
    const isEmpty = !val(value);
    return `
        <div class="impact-item">
            <div class="impact-item-label">${label}</div>
            <div class="impact-item-value ${isEmpty ? 'none' : ''}">
                ${isEmpty ? 'No significant impact' : escapeHtml(val(value))}
            </div>
        </div>`;
}

function disabilityBadge(value) {
    if (value === 'Yes') return `<span class="cert-badge yes">Yes — likely qualifies</span>`;
    if (value === 'No') return `<span class="cert-badge no">No</span>`;
    return `<span class="cert-badge unknown">Uncertain — requires assessment</span>`;
}

function confidenceLabel(value) {
    if (value === 'very_satisfied') return 'Very satisfied — sufficient information';
    if (value === 'some_evidence') return 'Some evidence — satisfied';
    return 'Minimal independent verification';
}

function examArrangementsHtml(cert) {
    if (cert.examArrangements === 'none') {
        return `<span class="cert-badge not-recommended">No — not applicable</span>`;
    }
    if (cert.examArrangements === 'all') {
        return `<span class="cert-badge recommended">Yes — for all examinations</span>`;
    }
    if (cert.examArrangements === 'time_period') {
        return `<span class="cert-badge recommended">Yes — for the following period: ${escapeHtml(val(cert.examTimePeriod) || '[period not specified]')}</span>`;
    }
    if (cert.examArrangements === 'exam_type') {
        return `<span class="cert-badge recommended">Yes — for: ${escapeHtml(val(cert.examType) || '[type not specified]')}</span>`;
    }
    return `<span class="cert-badge unknown">Not determined</span>`;
}

function renderCertificate(cert, today) {
    return `
    <div class="cert-wrapper">

        <div class="disclaimer-banner">
            ⚠️ <strong>Review before use:</strong> AI-generated content. Please verify all fields are accurate before signing. Patient name has been left blank intentionally — add it yourself.
        </div>

        <div class="cert-title">Medical Certificate for University of Oxford Students</div>
        <div class="cert-subtitle">For exam adjustments, deadline extensions, and related academic matters</div>

        <!-- STUDENT DETAILS -->
        <div class="cert-section">
            <div class="cert-section-title">Student Details</div>
            <div class="cert-row">
                <div class="cert-field">
                    <div class="cert-label">Name</div>
                    <div class="cert-value empty" style="font-style: italic; color: var(--text-secondary);">
                        [Leave blank — add manually for confidentiality]
                    </div>
                </div>
                <div class="cert-field">
                    <div class="cert-label">Date of Birth</div>
                    <div class="cert-value empty">[Add manually]</div>
                </div>
            </div>
            <div class="cert-row">
                ${fieldHtml('College', cert.college)}
                ${fieldHtml('Degree & Subject', cert.degreeSubject)}
            </div>
        </div>

        <!-- MEDICAL CONDITION -->
        <div class="cert-section">
            <div class="cert-section-title">Details of Medical Condition or Disability</div>

            <div class="cert-field">
                <div class="cert-label">Likely disability under the Equality Act 2010?</div>
                <div class="cert-value">${disabilityBadge(cert.isDisability)}</div>
            </div>

            ${fieldHtml('Diagnosis', cert.diagnosis)}

            <div class="cert-field">
                <div class="cert-label">Confidence in information available</div>
                <div class="cert-value">${confidenceLabel(cert.confidenceLevel)}</div>
            </div>

            ${fieldHtml('Duration and dates affected', cert.duration)}
        </div>

        <!-- IMPACT -->
        <div class="cert-section">
            <div class="cert-section-title">Impact on Academic Activities</div>
            <div class="impact-grid">
                ${impactHtml('Attend sessions (lectures, practicals, seminars, tutorials)', cert.impactAttend)}
                ${impactHtml('Study (access sources, read, concentrate)', cert.impactStudy)}
                ${impactHtml('Complete written work (by hand or typed, including exam submissions)', cert.impactWritten)}
                ${impactHtml('Complete practical work / fieldwork', cert.impactPractical)}
                ${impactHtml('Sit written examinations', cert.impactWrittenExams)}
                ${impactHtml('Sit oral / practical examinations', cert.impactOralExams)}
                ${impactHtml('Other', cert.impactOther)}
            </div>
        </div>

        <!-- EXAM ARRANGEMENTS -->
        <div class="cert-section">
            <div class="cert-section-title">Alternative Arrangements for Examinations</div>
            <div class="cert-field">
                <div class="cert-label">Should the University consider alternative arrangements?</div>
                <div class="cert-value">${examArrangementsHtml(cert)}</div>
            </div>
            ${val(cert.examRecommendations) ? fieldHtml('Recommended adjustments', cert.examRecommendations) : ''}
        </div>

        <!-- DOCTOR DETAILS -->
        <div class="cert-section">
            <div class="cert-section-title">Doctor's Details</div>
            <div class="doctor-block">
                Your details, declaration, and today's date (<strong>${escapeHtml(today)}</strong>) are already pre-filled on the template. Sign and date as usual.
            </div>
        </div>

    </div>`;
}

// --- GENERATE ---
generateBtn.addEventListener('click', async () => {
    const notes = notesInput.value.trim();

    if (!notes) {
        showStatus('Please paste consultation notes before generating.', 'error');
        notesInput.focus();
        return;
    }

    generateBtn.disabled = true;
    generateBtn.textContent = 'Completing certificate…';
    showStatus('Calling AI — usually takes 5–10 seconds...', 'info');
    certificateOutput.innerHTML = '<div class="placeholder-cert"><p>Generating certificate…</p></div>';

    try {
        const response = await apiFetch('/api/notes-to-certificate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes })
        });

        const data = await response.json();

        if (!response.ok) throw new Error(data.error || `Server error (${response.status})`);

        certificateOutput.innerHTML = renderCertificate(data.certificate, data.today);
        showStatus('Certificate completed. Review carefully before signing.', 'success');
        certificateOutput.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (error) {
        console.error('Certificate error:', error);
        certificateOutput.innerHTML = '<div class="placeholder-cert"><div class="placeholder-icon" aria-hidden="true"></div><p>Error generating certificate — please try again.</p></div>';
        showStatus(`Error: ${error.message}`, 'error');
    } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Complete certificate';
    }
});

// --- COPY ---
copyBtn.addEventListener('click', async () => {
    if (certificateOutput.querySelector('.placeholder-cert')) {
        showStatus('Generate a certificate first.', 'error');
        return;
    }
    try {
        await navigator.clipboard.writeText(certificateOutput.innerText);
        copyBtn.innerHTML = '<svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
        copyBtn.classList.add('is-copied');
        showStatus('Copied to clipboard.', 'success');
        setTimeout(() => {
            copyBtn.innerHTML = copyBtnDefaultHtml;
            copyBtn.classList.remove('is-copied');
        }, 2000);
    } catch {
        showStatus('Copy failed — select and copy manually.', 'error');
    }
});

// --- CLEAR ---
clearBtn.addEventListener('click', () => {
    certificateOutput.innerHTML = `
        <div class="placeholder-cert">
            <div class="placeholder-icon" aria-hidden="true"></div>
            <p>Paste consultation notes and click <strong>Complete certificate</strong>.</p>
            <p style="font-size: 0.8rem; margin-top: 8px;">All fields will be filled automatically. Add the patient name yourself before submitting.</p>
        </div>`;
    statusMsg.style.display = 'none';
});
