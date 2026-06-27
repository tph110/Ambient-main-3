// File: auth-client.js
// Lightweight access-code gate shared by every page. Exposes window.apiFetch(),
// a drop-in replacement for fetch() that attaches the user's access code as the
// `x-app-secret` header and (re)prompts for it if the server returns 401.
//
// The code is entered by the user and kept in sessionStorage (cleared when the
// tab closes) — it is NOT baked into the frontend bundle.
(function () {
    const KEY = 'echodoc-access-code';

    const getCode = () => sessionStorage.getItem(KEY) || '';
    const setCode = (c) => { if (c) sessionStorage.setItem(KEY, c); };

    function promptForCode(message) {
        const code = window.prompt(message || 'Enter your EchoDoc access code to continue:');
        if (code && code.trim()) {
            setCode(code.trim());
            return code.trim();
        }
        return '';
    }

    async function apiFetch(url, options = {}) {
        const opts = Object.assign({}, options);
        opts.headers = Object.assign({}, options.headers);

        let code = getCode();
        if (code) opts.headers['x-app-secret'] = code;

        let res = await fetch(url, opts);

        // Missing or incorrect code — ask once and retry.
        if (res.status === 401) {
            sessionStorage.removeItem(KEY);
            code = promptForCode('Access code required or incorrect. Please enter your EchoDoc access code:');
            if (!code) return res; // user cancelled — let the caller handle the 401
            opts.headers['x-app-secret'] = code;
            res = await fetch(url, opts);
        }

        return res;
    }

    window.apiFetch = apiFetch;
})();
