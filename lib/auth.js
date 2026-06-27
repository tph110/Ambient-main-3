// File: /lib/auth.js
// Shared access-code gate for the API endpoints. Imported by each /api route.
//
// Set APP_SHARED_SECRET in your Vercel environment variables to enable it.
// Requests must then send the same value in the `x-app-secret` header
// (the frontend's apiFetch() does this automatically).
//
// If APP_SHARED_SECRET is NOT set, the endpoints stay open (fail-open) so an
// un-configured deploy keeps working — a warning is logged so it isn't silent.

import crypto from 'crypto';

function safeEqual(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    try {
        return crypto.timingSafeEqual(ab, bb);
    } catch (_) {
        return false;
    }
}

// Returns true if the request may proceed. If it returns false it has already
// sent a 401 response, so the caller should simply `return`.
export function requireAuth(req, res) {
    const expected = process.env.APP_SHARED_SECRET;

    if (!expected) {
        console.warn('[auth] APP_SHARED_SECRET is not set — API endpoints are UNPROTECTED. Set it in Vercel to enable the access-code gate.');
        return true;
    }

    const headerVal = req.headers['x-app-secret'];
    const provided = Array.isArray(headerVal) ? headerVal[0] : headerVal;

    if (provided && safeEqual(provided, expected)) {
        return true;
    }

    res.status(401).json({ error: 'Unauthorized: a valid access code is required.' });
    return false;
}
