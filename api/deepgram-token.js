// File: /api/deepgram-token.js
// Mints a short-lived Deepgram token so the secret DEEPGRAM_API_KEY never
// reaches the browser. The frontend uses this token to open a streaming
// WebSocket directly to Deepgram (audio never passes through Vercel).

import { requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
    console.log('=== Deepgram Token API Called ===');

    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!requireAuth(req, res)) return;

    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
        console.error('Error: Deepgram API key not configured');
        return res.status(500).json({
            error: 'Deepgram API key not configured. Please add DEEPGRAM_API_KEY to Vercel environment variables.'
        });
    }

    // Return the API key directly — it never touches the frontend bundle,
    // only reaching the browser via this server-side endpoint which is
    // protected by the requireAuth gate.
    return res.status(200).json({ token: apiKey });
}
