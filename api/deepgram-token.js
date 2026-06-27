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

    try {
        // Ask Deepgram for a temporary, time-limited access token.
        // ttl_seconds only needs to outlive the WebSocket handshake; the live
        // stream stays open well past expiry once connected. Reconnects fetch
        // a fresh token automatically.
        const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
            method: 'POST',
            headers: {
                'Authorization': `Token ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ttl_seconds: 120 })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('Deepgram grant error:', response.status, errText.substring(0, 300));

            if (response.status === 401) {
                return res.status(401).json({
                    error: 'Invalid Deepgram API key. Please check DEEPGRAM_API_KEY in Vercel environment variables.'
                });
            }
            return res.status(response.status).json({
                error: `Failed to mint Deepgram token (${response.status}): ${errText.substring(0, 200)}`
            });
        }

        const data = await response.json();
        // Deepgram returns { access_token, expires_in }
        return res.status(200).json({
            token: data.access_token,
            expiresIn: data.expires_in
        });
    } catch (error) {
        console.error('Token generation error:', error);
        return res.status(500).json({ error: error.message || 'Token generation failed' });
    }
}
