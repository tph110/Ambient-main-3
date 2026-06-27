// File: /api/notes-to-certificate.js
// Generates a completed Oxford University medical certificate from consultation notes

import { requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
    console.log('=== Notes to Certificate API Called ===');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!requireAuth(req, res)) return;

    try {
        const { notes } = req.body;

        if (!notes || notes.trim() === '') {
            return res.status(400).json({ error: 'Consultation notes are required.' });
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'OpenRouter API key not configured.' });
        }

        const today = new Date().toLocaleDateString('en-GB', {
            day: 'numeric', month: 'long', year: 'numeric'
        });

        const systemPrompt = `You are an expert UK GP completing the University of Oxford Medical Certificate for exam adjustments and deadline extensions on behalf of Dr Tom Hutchinson.

Today's date is ${today}.

Your task is to read the consultation notes and return a JSON object with EXACTLY the following fields. Do not include any other text — just the raw JSON object.

{
  "college": "College name if mentioned, otherwise empty string",
  "degreeSubject": "Degree and subject if mentioned, otherwise empty string",
  "isDisability": "Yes" or "No" or "Unknown" — whether condition likely qualifies under Equality Act 2010,
  "diagnosis": "Clear diagnosis in plain English. Use technical terms only if you also explain them in layperson terms. Be specific and clinically accurate.",
  "confidenceLevel": "very_satisfied" or "some_evidence" or "minimal" — based on how well-documented the condition is from the notes,
  "duration": "Description of duration of illness and dates affected, or state long-term condition. Be specific about dates if mentioned.",
  "impactAttend": "Impact on attending sessions (lectures, practicals, seminars, tutorials). Write 'None' if no impact.",
  "impactStudy": "Impact on ability to study, access sources, read, concentrate. Write 'None' if no impact.",
  "impactWritten": "Impact on completing written work by hand or typed, including exam submissions. Write 'None' if no impact.",
  "impactPractical": "Impact on practical work or fieldwork. Write 'None' if no impact.",
  "impactWrittenExams": "Impact on sitting written examinations. Write 'None' if no impact.",
  "impactOralExams": "Impact on sitting oral or practical examinations. Write 'None' if no impact.",
  "impactOther": "Any other impacts not covered above. Write 'None' if no other impacts.",
  "examArrangements": "none" or "all" or "time_period" or "exam_type" — whether alternative arrangements or deadline extensions are needed. Use "time_period" if the notes mention a deadline extension or specific time period of difficulty. Use "all" if arrangements are needed for all assessments. Use "exam_type" for specific types only. Use "none" only if no arrangements or extensions are mentioned.",
  "examTimePeriod": "If time_period selected: specify the extension or period clearly, e.g. '3-week extension to Trinity term essay deadline from 2 May 2026'. Otherwise empty string.",
  "examType": "If exam_type selected: specify which types. Otherwise empty string.",
  "examRecommendations": "Specific recommendations for adjustments or extensions, clinically justified. Include any deadline extensions mentioned in the notes with exact dates if given. Write empty string if none."
}

RULES:
- Base ALL answers strictly on the consultation notes provided. Do not invent clinical details.
- For impact fields: describe the degree of difficulty (mild/moderate/severe) and whether it is consistent or fluctuating.
- For diagnosis: write clearly for a University administrator who is not medically trained.
- IMPORTANT: If the notes mention a deadline extension, essay extension, or any specific accommodation request, always set examArrangements to "time_period" or "exam_type" as appropriate — never "none".
- Return ONLY the JSON object — no markdown, no preamble, no explanation.`;

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://echodoc.vercel.app',
                'X-Title': 'EchoDoc Certificate Generator'
            },
            body: JSON.stringify({
                model: 'deepseek/deepseek-v3.2',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Consultation notes:\n\n${notes.trim()}` }
                ],
                temperature: 0.2,
                max_tokens: 2000
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            return res.status(response.status).json({
                error: `AI generation failed (${response.status}): ${errorText.substring(0, 200)}`
            });
        }

        const data = await response.json();
        const raw = data.choices?.[0]?.message?.content;

        if (!raw || raw.trim() === '') {
            return res.status(500).json({ error: 'AI returned an empty response.' });
        }

        // Strip any accidental markdown fences
        const clean = raw.replace(/```json|```/g, '').trim();

        let certificate;
        try {
            certificate = JSON.parse(clean);
        } catch (e) {
            console.error('JSON parse error:', e, 'Raw:', clean);
            return res.status(500).json({ error: 'AI returned malformed data. Please try again.' });
        }

        return res.status(200).json({ certificate, today });

    } catch (error) {
        console.error('Certificate generation error:', error);
        return res.status(500).json({ error: error.message || 'Failed to generate certificate.' });
    }
}

export const config = {
    api: { bodyParser: { sizeLimit: '1mb' } }
};
