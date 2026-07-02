// File: /api/format-letter.js
// OpenRouter AI endpoint for formatting letters from the Structured Clinical Summary (SOAP)

import { requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
    console.log('=== Format Letter API Called ===');
    console.log('Method:', req.method);

    if (req.method !== 'POST') {
        console.log('Error: Method not allowed');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!requireAuth(req, res)) return;

    try {
        // Accept soapSummary as primary input, with transcript as fallback
        const { soapSummary, transcript, letterType } = req.body;
        const inputText = soapSummary || transcript;

        console.log('Request body received');
        console.log('Letter type:', letterType);
        console.log('Input source:', soapSummary ? 'SOAP summary' : 'transcript fallback');
        console.log('Input length:', inputText?.length || 0);

        if (!inputText || inputText.trim() === '') {
            console.log('Error: No input provided');
            return res.status(400).json({ error: 'A clinical summary is required. Please ensure the Structured Clinical Summary box contains content before generating a letter.' });
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        
        if (!apiKey) {
            console.error('Error: OpenRouter API key not configured');
            return res.status(500).json({ error: 'OpenRouter API key not configured. Please add OPENROUTER_API_KEY to Vercel environment variables.' });
        }

        console.log('OpenRouter API key found');
        console.log('Formatting letter type:', letterType);

        let systemPrompt;
        let userPrompt;

        if (letterType === 'voice-instruction') {
            // The dictation itself begins with a spoken instruction describing
            // what document to produce; the AI works out the rest.
            systemPrompt = `You are an expert UK GP's documentation assistant. The clinician has dictated a single recording that BEGINS with a spoken instruction describing the document they want (for example "Generate a referral letter based on the following information" or "Write a GP consultation note from the following"), followed by the clinical information itself.

YOUR TASK:
1. Identify the instruction at the start of the dictation and determine which document is being requested.
2. Generate that document using ONLY the information dictated after the instruction.
3. Do NOT include the instruction itself, or any commentary about it, in the output.

COMMON DOCUMENT TYPES (not exhaustive — always follow the spoken instruction):

Referral letter:
Formal letter to a specialist colleague. Structure: today's date (UK format DD Month YYYY), recipient ("Dear Colleague," unless a name is dictated), "Re: [Patient name, DoB, NHS number if dictated]", an opening sentence giving the reason for referral, 2-3 prose paragraphs covering history, background, examination and investigations, a closing request stating what you are asking the specialist to do, then "Yours sincerely," with a blank line for name and practice. Prose paragraphs only — no bullet points or section headers.

GP consultation note:
Structured note for the medical record, ready to paste into EMIS/SystmOne. Plain-text Title Case section headings with colons, in this order where covered: Presenting Complaint, History of Presenting Complaint, Past Medical History, Medications, Allergies, Social History, Examination Findings, Assessment, Plan. Omit sections not covered in the dictation. History of Presenting Complaint should have one clinical point per line with no bullet symbols; all other sections in prose. No markdown, no hyphens or bullet symbols.

Letter to patient:
Plain-English letter ("Dear [Patient name],"), warm but professional, explaining what was discussed, the diagnosis or working diagnosis, the plan, what happens next and when to seek help. Close with an invitation to contact the surgery, then "Yours sincerely,".

Sick note / fit note statement, "To Whom It May Concern" letter, meeting minutes, or anything else requested: use standard professional UK formats.

RULES:
- Base the document ONLY on information in the dictation — do not invent clinical details
- If a detail the document needs was not dictated, use a placeholder such as [Patient name] or [Date of birth]
- If no clear instruction can be identified at the start, format the dictation as a clean, well-structured document and begin the output with the single line: "Note: no spoken instruction detected — formatted as general text."
- Use British English spelling and conventions throughout
- Output ONLY the finished document — no preamble, explanation, or meta-commentary
- Do NOT use markdown formatting symbols (**, *, ##, etc.)`;

            userPrompt = `Here is the dictation. It begins with my spoken instruction, followed by the information to use:

${inputText}`;

        } else {
            // Build letter-specific instructions
            const letterInstructions = getLetterInstructions(letterType);

            // System prompt for letter generation from SOAP summary
            systemPrompt = `You are an expert UK GP generating professional correspondence from a structured clinical summary.

YOUR TASK:
You will be given a structured clinical summary (SOAP format) from a GP consultation, which may have been edited or annotated by the clinician. Use this as the sole source of clinical information to generate the requested document.

IMPORTANT PRINCIPLES:
- Use ONLY information present in the clinical summary — do not infer or add clinical details not stated
- The clinician may have added handwritten notes or additional context to the summary — include these
- Use British English spelling and conventions throughout
- Maintain all medical terminology exactly as written in the summary
- Output ONLY the formatted document — no preamble, explanation, or meta-commentary
- Do NOT use markdown formatting symbols (**, *, ##, etc.)

${letterInstructions}`;

            userPrompt = `Please generate the requested document using the following structured clinical summary:

${inputText}`;
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
                'X-Title': 'EchoDoc Letter Dictation'
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

        if (!response.ok) {
            let errorText = await response.text();
            return res.status(response.status).json({ 
                error: `AI formatting failed (${response.status}): ${errorText.substring(0, 200)}` 
            });
        }

        const data = await response.json();
        const letter = data.choices?.[0]?.message?.content;

        if (!letter || letter.trim() === '') {
            return res.status(500).json({ error: 'AI returned empty response' });
        }

        console.log('Letter generated successfully');
        console.log('Letter length:', letter.length, 'characters');

        return res.status(200).json({ letter });

    } catch (error) {
        console.error('Letter formatting error:', error);
        return res.status(500).json({ error: error.message || 'Failed to format letter' });
    }
}

// Get letter-specific formatting instructions
function getLetterInstructions(letterType) {
    switch (letterType) {
        case 'meeting-minutes':
            return `LETTER TYPE: Healthcare Meeting Minutes

CRITICAL FORMATTING RULES:
1. IDENTITY: Use ONLY initials for all names (e.g., "Dr J.S." or "M.P."), NEVER full names.
2. TITLES: Do NOT use markdown bolding (**). Use plain text followed by a dashed underline.
   Example:
   Meeting Details
   ---------------
3. LISTS: Use bullet points (•) for all content.
4. CONTENT: Be comprehensive and detailed. Capture specific data, statistics, and who said what (using initials).

STRUCTURE:
Meeting Details
---------------
• Date: [Extract from summary]
• Attendees: [List with initials]
• Apologies: [List with initials]
• Chair: [Initials]

Agenda Items Discussed
----------------------
[For each item include:]
• [Topic Name]
  - [Initials]: [Detailed point/contribution]
  - [Initials]: [Response/concern]
  - Outcome: [Decision or agreement]
  - Rationale: [Why it was decided]

Action Items
------------
• [Task description]
  - Responsible: [Initials]
  - Due date: [Date or TBD]

Decisions Made
--------------
• [Decision with context]
  - Rationale: [Why]

Risks and Concerns
------------------
• [Risk description] - Raised by: [Initials]
  - Mitigation: [Plan]

Next Meeting
------------
• Date/Time/Agenda if mentioned.`;

        case 'referral':
            return `LETTER TYPE: Medical Referral Letter

Generate a formal referral letter from the clinical summary provided. Write in full prose paragraphs — no bullet points or section headers.

STRUCTURE:
1. Date (UK format: DD Month YYYY)
2. Recipient details (use details from summary if present, otherwise "Dear Colleague,")
3. Re: [Patient name, DoB, NHS number if present in summary]
4. Opening paragraph: reason for referral in one sentence
5. Clinical narrative: 2-3 paragraphs covering history, background, examination findings, and investigations — drawn entirely from the summary
6. Closing request: what you are asking the specialist to do
7. Sign-off: "Yours sincerely," followed by a blank line for name and practice

RULES:
- Prose paragraphs only — no bullet points, no section headers with colons
- British English throughout
- Do not infer clinical details not present in the summary
- If patient details are incomplete, leave appropriate placeholders (e.g., "[NHS number]")`;

        case 'sick-note':
            return `LETTER TYPE: Sick Note / Fit Note

Generate a brief, professional statement of unfitness from the clinical summary. Include:
- Patient name and date of birth (if present in summary)
- The medical condition or reason for absence
- The period of unfitness
- Any recommendations for phased return or adjusted duties if mentioned
Keep it concise and factual.`;

        case 'to-whom':
            return `LETTER TYPE: To Whom It May Concern

Generate a formal, concise letter based on the clinical summary. State the purpose clearly in the opening sentence. Use formal language throughout. British English.`;

        case 'patient':
            return `LETTER TYPE: Letter to Patient

Generate a patient-friendly letter from the clinical summary. 

RULES:
- Use plain English — avoid or explain medical jargon
- Warm but professional tone
- Format as "Dear [Patient name],"
- Cover: what was discussed, any diagnosis or working diagnosis, the treatment plan, what happens next, when to seek help
- Close with an invitation to contact the surgery with any questions
- Sign off as "Yours sincerely," with a blank line for name and practice`;

        case 'free-text':
            return `LETTER TYPE: Free Text / General Document

Format the content from the clinical summary into clean, well-structured prose. Correct grammar and punctuation. No letter structure required — just produce a clean, readable document.`;

        case 'general':
        default:
            return `LETTER TYPE: General Correspondence

Generate a professional business letter based on the clinical summary content. Use standard UK business letter format with a clear opening, body, and closing.`;
    }
}

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};
        }

        console.log('OpenRouter API key found');
        console.log('Formatting letter type:', letterType);

        // Build letter-specific instructions
        const letterInstructions = getLetterInstructions(letterType);

        // System prompt for letter generation from SOAP summary
        const systemPrompt = `You are an expert UK GP generating professional correspondence from a structured clinical summary.

YOUR TASK:
You will be given a structured clinical summary (SOAP format) from a GP consultation, which may have been edited or annotated by the clinician. Use this as the sole source of clinical information to generate the requested document.

IMPORTANT PRINCIPLES:
- Use ONLY information present in the clinical summary — do not infer or add clinical details not stated
- The clinician may have added handwritten notes or additional context to the summary — include these
- Use British English spelling and conventions throughout
- Maintain all medical terminology exactly as written in the summary
- Output ONLY the formatted document — no preamble, explanation, or meta-commentary
- Do NOT use markdown formatting symbols (**, *, ##, etc.)

${letterInstructions}`;

        const userPrompt = `Please generate the requested document using the following structured clinical summary:

${inputText}`;

        console.log('Calling OpenRouter API...');
        console.log('Using model: deepseek/deepseek-v3.2');

        // Call OpenRouter API
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://echodoc.vercel.app',
                'X-Title': 'EchoDoc Letter Dictation'
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

        if (!response.ok) {
            let errorText = await response.text();
            return res.status(response.status).json({ 
                error: `AI formatting failed (${response.status}): ${errorText.substring(0, 200)}` 
            });
        }

        const data = await response.json();
        const letter = data.choices?.[0]?.message?.content;

        if (!letter || letter.trim() === '') {
            return res.status(500).json({ error: 'AI returned empty response' });
        }

        console.log('Letter generated successfully');
        console.log('Letter length:', letter.length, 'characters');

        return res.status(200).json({ letter });

    } catch (error) {
        console.error('Letter formatting error:', error);
        return res.status(500).json({ error: error.message || 'Failed to format letter' });
    }
}

// Get letter-specific formatting instructions
function getLetterInstructions(letterType) {
    switch (letterType) {
        case 'meeting-minutes':
            return `LETTER TYPE: Healthcare Meeting Minutes

CRITICAL FORMATTING RULES:
1. IDENTITY: Use ONLY initials for all names (e.g., "Dr J.S." or "M.P."), NEVER full names.
2. TITLES: Do NOT use markdown bolding (**). Use plain text followed by a dashed underline.
   Example:
   Meeting Details
   ---------------
3. LISTS: Use bullet points (•) for all content.
4. CONTENT: Be comprehensive and detailed. Capture specific data, statistics, and who said what (using initials).

STRUCTURE:
Meeting Details
---------------
• Date: [Extract from summary]
• Attendees: [List with initials]
• Apologies: [List with initials]
• Chair: [Initials]

Agenda Items Discussed
----------------------
[For each item include:]
• [Topic Name]
  - [Initials]: [Detailed point/contribution]
  - [Initials]: [Response/concern]
  - Outcome: [Decision or agreement]
  - Rationale: [Why it was decided]

Action Items
------------
• [Task description]
  - Responsible: [Initials]
  - Due date: [Date or TBD]

Decisions Made
--------------
• [Decision with context]
  - Rationale: [Why]

Risks and Concerns
------------------
• [Risk description] - Raised by: [Initials]
  - Mitigation: [Plan]

Next Meeting
------------
• Date/Time/Agenda if mentioned.`;

        case 'referral':
            return `LETTER TYPE: Medical Referral Letter

Generate a formal referral letter from the clinical summary provided. Write in full prose paragraphs — no bullet points or section headers.

STRUCTURE:
1. Date (UK format: DD Month YYYY)
2. Recipient details (use details from summary if present, otherwise "Dear Colleague,")
3. Re: [Patient name, DoB, NHS number if present in summary]
4. Opening paragraph: reason for referral in one sentence
5. Clinical narrative: 2-3 paragraphs covering history, background, examination findings, and investigations — drawn entirely from the summary
6. Closing request: what you are asking the specialist to do
7. Sign-off: "Yours sincerely," followed by a blank line for name and practice

RULES:
- Prose paragraphs only — no bullet points, no section headers with colons
- British English throughout
- Do not infer clinical details not present in the summary
- If patient details are incomplete, leave appropriate placeholders (e.g., "[NHS number]")`;

        case 'sick-note':
            return `LETTER TYPE: Sick Note / Fit Note

Generate a brief, professional statement of unfitness from the clinical summary. Include:
- Patient name and date of birth (if present in summary)
- The medical condition or reason for absence
- The period of unfitness
- Any recommendations for phased return or adjusted duties if mentioned
Keep it concise and factual.`;

        case 'to-whom':
            return `LETTER TYPE: To Whom It May Concern

Generate a formal, concise letter based on the clinical summary. State the purpose clearly in the opening sentence. Use formal language throughout. British English.`;

        case 'patient':
            return `LETTER TYPE: Letter to Patient

Generate a patient-friendly letter from the clinical summary. 

RULES:
- Use plain English — avoid or explain medical jargon
- Warm but professional tone
- Format as "Dear [Patient name],"
- Cover: what was discussed, any diagnosis or working diagnosis, the treatment plan, what happens next, when to seek help
- Close with an invitation to contact the surgery with any questions
- Sign off as "Yours sincerely," with a blank line for name and practice`;

        case 'free-text':
            return `LETTER TYPE: Free Text / General Document

Format the content from the clinical summary into clean, well-structured prose. Correct grammar and punctuation. No letter structure required — just produce a clean, readable document.`;

        case 'general':
        default:
            return `LETTER TYPE: General Correspondence

Generate a professional business letter based on the clinical summary content. Use standard UK business letter format with a clear opening, body, and closing.`;
    }
}

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};
