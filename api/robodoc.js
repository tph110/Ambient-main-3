// File: /api/robodoc.js
// Live clinical decision support for the RoboDoc page. Receives the growing
// consultation transcript plus the prompts already on screen, and returns only
// NEW high-value prompts (red flags, questions to ask, examinations,
// differentials) as strict JSON.

import { requireAuth } from '../lib/auth.js';

const SYSTEM_PROMPT = `You are RoboDoc, a real-time clinical decision support assistant listening in on a live UK GP consultation. You receive a partial, growing transcript (it may cut off mid-sentence) and must suggest prompts that help the clinician IN THE MOMENT.

YOUR JOB:
Analyse the transcript and suggest only genuinely useful, specific prompts such as:
- Red flag symptoms to actively rule out based on what has been mentioned
- Focused history questions the clinician has not yet asked
- Examinations or bedside tests worth performing
- Differentials, investigations or risk scores worth considering

EXAMPLE: if the patient reports headache and fever, prompt the clinician to screen for meningitis (neck stiffness, photophobia, non-blanching rash, drowsiness).

CATEGORIES (use exactly these values):
- "red_flag"  – urgent/serious pathology to actively exclude
- "ask"       – a specific history question worth asking now
- "examine"   – an examination or bedside measurement worth doing
- "consider"  – a differential, investigation, tool or guideline worth considering

RULES:
- Base prompts ONLY on what is actually in the transcript. Never invent symptoms.
- Follow UK practice and NICE guidance. Use British English.
- Be specific and actionable: "Ask about photophobia and neck stiffness", not "take a full history".
- Do NOT repeat or rephrase anything in the "already shown" list — return only genuinely new prompts.
- Quality over quantity: return at most 3 new prompts per call, and it is normal to return none.
- If the clinician has already asked about something in the transcript, do not prompt for it.
- Keep "title" under 60 characters and "detail" to one or two short sentences.

OUTPUT FORMAT — CRITICAL:
Respond with ONLY a valid JSON object, no markdown fences, no commentary:
{"prompts":[{"category":"ask","title":"Screen for meningitis red flags","detail":"Ask about neck stiffness, photophobia, drowsiness and any non-blanching rash."}]}
If there is nothing new worth prompting, respond with exactly: {"prompts":[]}`;

// The model is asked for bare JSON, but be tolerant of code fences or stray
// prose around the object so a slightly-off response doesn't break the page.
function extractJson(text) {
    if (!text) return null;
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
        return JSON.parse(cleaned);
    } catch (_) {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end > start) {
            try {
                return JSON.parse(cleaned.slice(start, end + 1));
            } catch (_) { /* fall through */ }
        }
    }
    return null;
}

const VALID_CATEGORIES = new Set(['red_flag', 'ask', 'examine', 'consider']);

export default async function handler(req, res) {
    console.log('=== RoboDoc API Called ===');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!requireAuth(req, res)) return;

    try {
        const { transcript, existingPrompts } = req.body;

        if (!transcript || transcript.trim() === '') {
            return res.status(400).json({ error: 'Transcript is required' });
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'OpenRouter API key not configured. Please add OPENROUTER_API_KEY to Vercel environment variables.' });
        }

        const shown = Array.isArray(existingPrompts)
            ? existingPrompts.filter(t => typeof t === 'string').slice(0, 40)
            : [];

        const userPrompt =
`LIVE CONSULTATION TRANSCRIPT SO FAR:
${transcript}

PROMPTS ALREADY SHOWN TO THE CLINICIAN (do not repeat these or close variants):
${shown.length ? shown.map(t => `- ${t}`).join('\n') : '(none yet)'}

Return new prompts as JSON now.`;

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://echodoc.vercel.app',
                'X-Title': 'EchoDoc RoboDoc'
            },
            body: JSON.stringify({
                model: 'deepseek/deepseek-v3.2',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.3,
                // Prompts are live decision support: bound the response tightly
                // and prefer the fastest upstream provider over the cheapest.
                max_tokens: 500,
                provider: { sort: 'latency' }
            })
        });

        if (!response.ok) {
            let errorText;
            try {
                errorText = JSON.stringify(await response.json());
            } catch (_) {
                errorText = await response.text();
            }
            console.error('OpenRouter error:', response.status, errorText.substring(0, 300));
            return res.status(response.status).json({
                error: `RoboDoc analysis failed (${response.status}): ${errorText.substring(0, 200)}`
            });
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        const parsed = extractJson(content);

        if (!parsed || !Array.isArray(parsed.prompts)) {
            console.error('RoboDoc: could not parse model output:', (content || '').substring(0, 300));
            // Not fatal for the live loop — return no prompts rather than an error.
            return res.status(200).json({ prompts: [] });
        }

        const prompts = parsed.prompts
            .filter(p => p && typeof p.title === 'string' && p.title.trim())
            .slice(0, 3)
            .map(p => ({
                category: VALID_CATEGORIES.has(p.category) ? p.category : 'consider',
                title: String(p.title).trim().substring(0, 120),
                detail: typeof p.detail === 'string' ? p.detail.trim().substring(0, 400) : ''
            }));

        console.log(`RoboDoc returned ${prompts.length} new prompt(s)`);
        return res.status(200).json({ prompts });

    } catch (error) {
        console.error('RoboDoc error:', error);
        return res.status(500).json({ error: error.message || 'RoboDoc analysis failed' });
    }
}

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};
