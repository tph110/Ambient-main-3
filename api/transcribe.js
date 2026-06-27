// File: /api/transcribe.js
// Deepgram Speech-to-Text API endpoint - V5 - Enhanced error handling

import { requireAuth } from '../lib/auth.js';

export const config = {
    api: {
        bodyParser: false, // Disable body parser to handle raw body
        responseLimit: '8mb', // Allow larger responses
    },
};

export default async function handler(req, res) {
    console.log('=== Transcribe API Called (Deepgram) ===');
    console.log('Method:', req.method);
    console.log('Request headers:', req.headers);

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!requireAuth(req, res)) return;

    try {
        // Check API key
        const apiKey = process.env.DEEPGRAM_API_KEY;
        if (!apiKey) {
            console.error('Error: Deepgram API key not configured');
            return res.status(500).json({ 
                error: 'Deepgram API key not configured. Please add DEEPGRAM_API_KEY to Vercel environment variables.' 
            });
        }

        // Read raw body with size limit
        const chunks = [];
        let totalSize = 0;
        const MAX_SIZE = 8 * 1024 * 1024; // 8MB hard limit

        for await (const chunk of req) {
            totalSize += chunk.length;
            if (totalSize > MAX_SIZE) {
                console.error('Request body too large:', totalSize);
                return res.status(413).json({ 
                    error: 'Audio file too large. Maximum size is 8MB. Please record a shorter consultation.',
                    size: totalSize,
                    limit: MAX_SIZE
                });
            }
            chunks.push(chunk);
        }

        const rawBody = Buffer.concat(chunks);
        console.log('Raw body size:', rawBody.length, 'bytes');
        console.log('Raw body size:', (rawBody.length / 1024).toFixed(2), 'KB');

        // Parse JSON
        let body;
        try {
            body = JSON.parse(rawBody.toString('utf-8'));
        } catch (parseError) {
            console.error('JSON parse error:', parseError);
            return res.status(400).json({ 
                error: 'Invalid JSON in request body',
                details: parseError.message
            });
        }

        console.log('JSON body parsed successfully');
        console.log('Body keys:', Object.keys(body));

        // IMPORTANT: Frontend sends "audioBlob" not "audio"
        const base64Audio = body.audioBlob || body.audio || body.file || body.data;
        
        if (!base64Audio) {
            console.error('No audio data found. Keys received:', Object.keys(body));
            return res.status(400).json({ 
                error: 'Audio data is required. Expected field: audioBlob, audio, file, or data',
                receivedFields: Object.keys(body)
            });
        }

        console.log('Base64 audio data found, length:', base64Audio.length);
        console.log('Converting from base64...');

        let audioBuffer;
        try {
            audioBuffer = Buffer.from(base64Audio, 'base64');
        } catch (base64Error) {
            console.error('Base64 decode error:', base64Error);
            return res.status(400).json({ 
                error: 'Invalid base64 audio data',
                details: base64Error.message
            });
        }

        const audioSizeMB = audioBuffer.length / (1024 * 1024);
        console.log('Audio buffer size:', audioBuffer.length, 'bytes');
        console.log('Audio buffer size:', audioSizeMB.toFixed(2), 'MB');

        // Final size check
        if (audioBuffer.length > 5 * 1024 * 1024) {
            console.error('Audio file too large after decoding:', audioSizeMB.toFixed(2), 'MB');
            return res.status(413).json({ 
                error: `Audio file too large (${audioSizeMB.toFixed(1)}MB). Maximum size is 5MB. Please record shorter consultations.`,
                size: audioBuffer.length,
                sizeMB: audioSizeMB.toFixed(2)
            });
        }

        // Build Deepgram API URL with medical model
        const deepgramUrl = new URL('https://api.deepgram.com/v1/listen');
        deepgramUrl.searchParams.append('model', 'nova-3-medical'); // Medical-specific model (upgraded from nova-2-medical)
        deepgramUrl.searchParams.append('language', 'en-GB'); // British English
        deepgramUrl.searchParams.append('punctuate', 'true'); // Auto-punctuation
        deepgramUrl.searchParams.append('paragraphs', 'true'); // Paragraph breaks
        deepgramUrl.searchParams.append('smart_format', 'true'); // Smart formatting
        deepgramUrl.searchParams.append('diarize', 'false'); // Single speaker for now

        console.log('Sending to Deepgram API...');
        console.log('Model: nova-3-medical (upgraded - improved medical terminology accuracy)');
        console.log('Language: en-GB (British English)');
        console.log('Audio size:', audioSizeMB.toFixed(2), 'MB');

        // Send to Deepgram
        const response = await fetch(deepgramUrl.toString(), {
            method: 'POST',
            headers: {
                'Authorization': `Token ${apiKey}`,
                'Content-Type': 'audio/webm',
            },
            body: audioBuffer,
        });

        console.log('Deepgram response status:', response.status);

        if (!response.ok) {
            let errorText;
            try {
                const errorData = await response.json();
                errorText = JSON.stringify(errorData);
                console.error('Deepgram JSON error:', errorData);
            } catch (e) {
                errorText = await response.text();
                console.error('Deepgram text error:', errorText);
            }
            
            if (response.status === 401) {
                return res.status(401).json({ 
                    error: 'Invalid Deepgram API key. Please check DEEPGRAM_API_KEY in Vercel environment variables.' 
                });
            } else if (response.status === 429) {
                return res.status(429).json({ 
                    error: 'Rate limit exceeded. Please wait a moment and try again.' 
                });
            } else if (response.status === 413) {
                return res.status(413).json({ 
                    error: 'Audio file too large for Deepgram. Please record a shorter consultation.',
                    details: errorText.substring(0, 200)
                });
            }
            
            return res.status(response.status).json({ 
                error: `Deepgram API error: ${response.status}`,
                details: errorText.substring(0, 500)
            });
        }

        const result = await response.json();
        console.log('Deepgram transcription received');

        // Extract transcript from Deepgram response
        const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript;
        const confidence = result.results?.channels?.[0]?.alternatives?.[0]?.confidence;
        const words = result.results?.channels?.[0]?.alternatives?.[0]?.words?.length || 0;

        if (!transcript) {
            console.error('No transcript in response');
            console.error('Response structure:', JSON.stringify(result, null, 2).substring(0, 500));
            return res.status(500).json({ 
                error: 'Failed to extract transcript from Deepgram response',
                details: 'No transcript field found in API response'
            });
        }

        console.log('SUCCESS!');
        console.log('Transcript length:', transcript.length, 'characters');
        console.log('Word count:', words);
        console.log('Confidence:', confidence);
        console.log('Preview:', transcript.substring(0, 100));

        // Return in OpenAI-compatible format (so frontend doesn't need changes)
        return res.status(200).json({
            text: transcript,
            confidence: confidence,
            words: words,
            provider: 'deepgram',
            model: 'nova-3-medical'
        });

    } catch (error) {
        console.error('Transcription error:', error.message);
        console.error('Stack:', error.stack);
        
        // Send JSON error response
        return res.status(500).json({ 
            error: 'Transcription failed',
            message: error.message,
            type: error.name
        });
    }
}
