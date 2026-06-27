// File: /api/summarize.js
// OpenRouter AI endpoint for generating clinical summaries

import { requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
    console.log('=== Summarize API Called ===');
    console.log('Method:', req.method);

    if (req.method !== 'POST') {
        console.log('Error: Method not allowed');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!requireAuth(req, res)) return;

    try {
        const { transcript, type } = req.body;
        console.log('Request body received');
        console.log('Summary type:', type || 'clinical');
        console.log('Transcript length:', transcript?.length || 0);

        if (!transcript || transcript.trim() === '') {
            console.log('Error: No transcript provided');
            return res.status(400).json({ error: 'Transcript is required' });
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        
        if (!apiKey) {
            console.error('Error: OpenRouter API key not configured');
            return res.status(500).json({ error: 'OpenRouter API key not configured. Please add OPENROUTER_API_KEY to Vercel environment variables.' });
        }

        console.log('OpenRouter API key found');

        // Determine which type of summary to generate
        let systemPrompt;
        let userPrompt;

        if (type === 'referral') {
            // Referral Letter
            systemPrompt = `You are an expert UK GP writing a professional referral letter to a specialist colleague.

CRITICAL: This MUST be formatted as a LETTER, NOT as a clinical summary with bullet points.

FORMAT AS A PROPER LETTER:

[Today's date in UK format: DD Month YYYY]

[Specialist Department or Name]
[Hospital/Clinic Address if known, otherwise omit]

Dear Dr [Specialist Name if known, otherwise "Dear Colleague"],

Re: [Patient Full Name], DoB: DD/MM/YYYY, NHS No: [if known]

I would be grateful if you could see this patient regarding [main reason for referral].

[Write 2-3 paragraphs in prose format covering:]

Paragraph 1 - Presenting complaint and history:
Describe the current problem, when it started, how it has progressed, key symptoms, severity, and impact on the patient's life. Write in full sentences, NOT bullet points.

Paragraph 2 - Background and relevant history:
Include relevant past medical history, current medications, allergies (or state "NKDA" if no known drug allergies), and relevant social history. Write in full sentences as a narrative paragraph.

Paragraph 3 - Examination and investigations (if performed):
Describe examination findings and any investigations already done. If none, state "Clinical examination was unremarkable" or describe what was found. Write in full sentences.

Paragraph 4 - Request:
Clearly state what you are asking the specialist to do (e.g., "I would be grateful for your assessment and management recommendations" or "Please could you assess for [specific condition] and advise on further management").

Thank you for seeing this patient.

Yours sincerely,

[Doctor's name to be added]
[Practice name to be added]

IMPORTANT RULES:
- Write in paragraph/prose format, NOT bullet points
- Use full sentences throughout
- NO sections with colons like "Presenting Complaint:" or "History of Presenting Complaint:"
- Format as a formal letter from one doctor to another
- Use British English spelling
- Be professional but conversational in tone
- If information is not provided in the transcript, omit it rather than making it up
- Include "NKDA" if no allergies mentioned

EXAMPLE OF CORRECT FORMAT:

6 January 2026

Orthopaedic Department
Royal Hospital

Dear Colleague,

Re: Mrs Jane Smith, DoB: 15/03/1960, NHS No: 123 456 7890

please could you review this 66 year old lady regarding her chronic right knee pain.

Mrs Smith has been experiencing progressive right knee pain for the past six months. The pain is worse on weight-bearing and after prolonged sitting, and she reports hearing clicking sounds when walking. She has tried paracetamol and ibuprofen with minimal benefit, and the pain is now significantly impacting her ability to work as a teacher.

Her past medical history includes hypertension, well-controlled on ramipril 5mg once daily. She has no known drug allergies. She is a non-smoker and drinks 6 units of alcohol per week. She is active and fully independent and mobile. 

Examination revealed mild joint effusion and tenderness over the medial joint line. There is reduced range of movement with flexion limited to 110 degrees. Her X-ray shows moderate degenerative changes with joint space narrowing.

I would be grateful for your assessment and management recommendations, including consideration for physiotherapy or surgical intervention.

Yours sincerely,

[Doctor's name]
[Practice name]`;

            userPrompt = `Create a referral letter from this consultation. Remember: Format as a proper letter with paragraphs, NOT as a clinical summary with bullet points.\n\n${transcript}`;

        } else if (type === 'patient') {
            // Patient Summary
            systemPrompt = `You are a UK GP creating a patient-friendly summary.

Convert the medical consultation into clear, simple language that a patient can understand.

GUIDELINES:
- Use plain English, avoid medical jargon
- Explain any medical terms you must use
- Be warm and reassuring in tone
- Use short paragraphs
- Include what was discussed, what was found, and what the plan is
- Format as a letter: "Dear [Patient Name]"

STRUCTURE:
1. Greeting
2. What we discussed today
3. What I found on examination (if relevant)
4. The diagnosis or working diagnosis
5. The treatment plan
6. What happens next
7. When to seek help / red flags
8. Closing with invitation to contact if questions`;

            userPrompt = `Create a patient-friendly summary from this consultation:\n\n${transcript}`;

        } else {
            // Clinical Summary (default)
            systemPrompt = `You are an expert UK GP creating structured clinical documentation for the medical record.

Convert the consultation transcript into a professional clinical summary suitable for the patient's medical notes.

IMPORTANT FORMATTING RULES:
- Use Title Case for section headings (e.g., "History of Presenting Complaint" NOT "HISTORY OF PRESENTING COMPLAINT")
- DO NOT use markdown bold (**) for section headings - use plain text
- Use British English spelling throughout
- Be concise but comprehensive
- Include relevant clinical details
- Use appropriate medical terminology
- Format for direct copy-paste into EMIS/SystmOne

CRITICAL: DO NOT USE HYPHENS OR BULLET POINT SYMBOLS (-, •, *, etc.) anywhere in the output. The History of Presenting Complaint section should have one clinical point per line with no symbol at the start of each line. All other sections must be written in prose format with full sentences.

REQUIRED SECTIONS (in this order):
1. Presenting Complaint
2. History of Presenting Complaint
3. Past Medical History
4. Medications
5. Allergies
6. Social History (if relevant)
7. Examination Findings (if documented)
8. Assessment
9. Plan

SECTION FORMATTING:
- Each section heading should be in Title Case, plain text, with a colon (e.g., "Presenting Complaint:")
- DO NOT use ** or any markdown formatting
- Write content in PROSE FORMAT with full sentences
- DO NOT use hyphens (-) or bullet points
- If a section wasn't covered in the consultation, write "Not documented" or omit the section

SPECIFIC SECTION GUIDANCE:

Presenting Complaint:
- Keep this brief (1-2 lines)
- Just the main symptom/problem
- Example: "3-day history of productive cough and fever"

History of Presenting Complaint:
- THIS SECTION SHOULD BE DETAILED AND COMPREHENSIVE
- Write ONE clinical point per line with NO symbol (no hyphen, no bullet, no dash) at the start
- Each line should be a concise but complete clinical statement
- Each consecutive line should not start with the same word
- Include ALL relevant details from the consultation
- Include timeline (when it started, how it progressed)
- Include character of symptoms (sharp/dull pain, colour of sputum, etc.)
- Include severity and frequency
- Include aggravating and relieving factors
- Include what the patient has tried already
- Include associated symptoms
- Include impact on daily activities/work/sleep
- Be thorough - this is the most important clinical section

Other sections:
- Past Medical History: List conditions as prose (e.g., "The patient has a history of asthma and hypertension")
- Medications: Write as sentences (e.g., "Current medications include ramipril 5mg once daily and salbutamol inhaler as needed")
- Allergies: Write as prose (e.g., "No known drug allergies" or "Allergic to penicillin with rash reaction")
- Social History: Write relevant details in sentences
- Examination Findings: Describe what was examined and found in prose
- Assessment: Clinical impression/diagnosis in prose
- Plan: Describe what was decided in prose

IMPORTANT - FLAG UNCERTAINTY:
- Do not make up or assume clinical details not present in the transcript
- If any clinically important details were ambiguous or not captured (e.g. allergies not mentioned, medications not listed, examination not performed), add a brief note at the very end of the summary under a plain-text heading "Recording Notes:" listing what could not be captured
- Only include "Recording Notes:" if there is something genuinely worth flagging — do not add it if the transcript was complete

DO NOT INCLUDE:
- QOF outcomes section
- Coding suggestions
- Read codes
- Quality improvement metrics
- Administrative notes
- Markdown formatting (**bold**, *italic*, etc.)
- Hyphens or bullet points

OUTPUT FORMAT:
Return ONLY the formatted clinical summary. Do not include any preamble, explanation, or meta-commentary.
Use plain text format suitable for direct copy-paste into medical records systems.

EXAMPLE FORMAT (NO HYPHENS OR BULLETS):

Presenting Complaint:
3-day history of productive cough and fever

History of Presenting Complaint:
Symptoms began 3 days ago with rhinorrhoea and sore throat, progressing to productive cough within 24 hours
Cough productive of green sputum, worse at night and disrupting sleep
Fever documented up to 38.5°C, particularly in the evenings
Mild shortness of breath on exertion when climbing stairs
No chest pain, no haemoptysis
Tried paracetamol and increased fluids with minimal improvement
Unable to attend work for the past 2 days due to fatigue
No recent travel, no sick contacts identified

Past Medical History:
The patient has a history of asthma which is well-controlled, and hypertension.

Medications:
Current medications include salbutamol inhaler 100mcg as needed for asthma, and amlodipine 5mg once daily for hypertension.

Allergies:
No known drug allergies.

Social History:
Non-smoker. Drinks alcohol socially. Works as a teacher.

Examination Findings:
Temperature 37.8°C. Respiratory rate 18 per minute. Oxygen saturations 96% on room air. Chest examination revealed coarse crackles in the right lower zone. No wheeze heard. Cardiovascular examination unremarkable.

Assessment:
Lower respiratory tract infection, likely community-acquired pneumonia affecting the right lower lobe.

Plan:
Started on oral amoxicillin 500mg three times daily for 7 days. Advised to continue regular paracetamol for fever and pain relief. Encouraged to maintain good fluid intake and rest. Safety netting advice provided regarding worsening breathlessness, chest pain, or persistent high fever. Advised to return if symptoms worsen or do not improve within 48 hours. Fit note provided for 5 days.`;

            userPrompt = `Create a structured clinical summary from this GP consultation transcript:\n\n${transcript}`;
        }

        console.log('Calling OpenRouter API...');
        console.log('Using model: deepseek/deepseek-v3.2');

        // Call OpenRouter API
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://echodoc.vercel.app',
                'X-Title': 'EchoDoc Clinical Scribe'
            },
            body: JSON.stringify({
                model: 'deepseek/deepseek-v3.2',
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    {
                        role: 'user',
                        content: userPrompt
                    }
                ],
                temperature: 0.3,
                max_tokens: 4000
            })
        });

        console.log('OpenRouter response status:', response.status);

        if (!response.ok) {
            let errorText;
            try {
                const errorData = await response.json();
                errorText = JSON.stringify(errorData);
                console.error('OpenRouter JSON error:', errorData);
            } catch (e) {
                errorText = await response.text();
                console.error('OpenRouter text error:', errorText);
            }
            return res.status(response.status).json({ 
                error: `AI summary failed (${response.status}): ${errorText.substring(0, 200)}` 
            });
        }

        const data = await response.json();
        console.log('OpenRouter response received successfully');

        // Extract summary
        const summary = data.choices?.[0]?.message?.content;

        if (!summary || summary.trim() === '') {
            console.error('Empty summary received from AI');
            return res.status(500).json({ 
                error: 'AI returned empty response' 
            });
        }

        console.log('Summary generated successfully');
        console.log('Summary length:', summary.length, 'characters');

        return res.status(200).json({ 
            summary,
            type: type || 'clinical'
        });

    } catch (error) {
        console.error('Summary generation error:', error);
        return res.status(500).json({ 
            error: error.message || 'Failed to generate summary' 
        });
    }
}

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};
