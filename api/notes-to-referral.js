// File: /api/notes-to-referral.js
// Generates a secondary care referral letter from pasted consultation notes

import { requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
    console.log('=== Notes to Referral API Called ===');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!requireAuth(req, res)) return;

    try {
        const { notes, instructions } = req.body;

        if (!notes || notes.trim() === '') {
            return res.status(400).json({ error: 'Consultation notes are required.' });
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'OpenRouter API key not configured.' });
        }

        const today = new Date().toLocaleDateString('en-GB', {
            day: 'numeric', month: 'long', year: 'numeric'
        }); // e.g. "28 April 2026"

        const systemPrompt = `You are an NHS UK General Practitioner writing a professional referral letter to a specialist in secondary care.

FORMAT AS A PROPER LETTER — not a structured summary or bullet-pointed document.

STRUCTURE:
${today}

[Specialist Department or Name — use the clinician's instructions if provided, otherwise write "Dear Colleague,"]

Re: [Patient name and DoB if present in notes, otherwise use "[Patient name]" as placeholder]

[Opening sentence: briefly state the reason for referral]

[Paragraph 1 — Presenting complaint and history:
Write in full sentences about the current problem — onset, duration, progression, key symptoms, severity, impact on daily life.]

[Paragraph 2 — Background and relevant history:
Include relevant past medical history, current medications, allergies (or NKDA if no known drug allergies), and relevant social history (developmental history if a child). Write as a narrative paragraph.]

[Paragraph 3 — Examination and investigations (if mentioned in the notes):
Describe any findings or tests already done. If none are mentioned, you may omit this paragraph.]

[Paragraph 4 — Closing request:
State clearly what you are asking the specialist to do. E.g. "I would be grateful for your assessment and further management advice."]

Thank you for seeing this patient.

Yours sincerely,

[Doctor's name — to be completed]


CRITICAL RULES:
- Write in prose paragraphs throughout — no bullet points anywhere
- British English spelling and medical conventions. Avoid waffle. 
- Do NOT use markdown formatting (no **, *, ##, etc.)
- Use ONLY clinical information present in the notes — do not invent details
- If patient identifiers are missing, use clear placeholders like [patient name] or [DoB]
- Do not use the terms "expert" or "expertise". Please remain neutral and do not suck up to the specialist. 
- Output ONLY the letter — no preamble, no meta-commentary`;

        const instructionsSection = instructions && instructions.trim()
            ? `\n\nADDITIONAL CLINICIAN INSTRUCTIONS:\n${instructions.trim()}`
            : '';

        const userPrompt = `Please write a referral letter using the following consultation notes:

${notes.trim()}${instructionsSection}`;

        console.log('Calling OpenRouter...');

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://echodoc.vercel.app',
                'X-Title': 'EchoDoc Notes to Referral'
            },
            body: JSON.stringify({
                model: 'deepseek/deepseek-v3.2',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.3,
                max_tokens: 4000
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            return res.status(response.status).json({
                error: `AI generation failed (${response.status}): ${errorText.substring(0, 200)}`
            });
        }

        const data = await response.json();
        const letter = data.choices?.[0]?.message?.content;

        if (!letter || letter.trim() === '') {
            return res.status(500).json({ error: 'AI returned an empty response.' });
        }

        console.log('Referral letter generated. Length:', letter.length);
        return res.status(200).json({ letter });

    } catch (error) {
        console.error('Notes to referral error:', error);
        return res.status(500).json({ error: error.message || 'Failed to generate referral letter.' });
    }
}

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '2mb',
        },
    },
};
