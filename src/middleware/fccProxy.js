const { createProxyMiddleware } = require('http-proxy-middleware');

// Reverse proxy that exposes the bundled `free-claude-code` (Python/FastAPI)
// service through this Node app. Everything under the mount prefix is forwarded
// to the FCC server, so its full feature set is reachable without a rewrite:
//   /fcc/v1/messages   -> Claude Code (Anthropic Messages API)
//   /fcc/v1/responses  -> Codex (OpenAI Responses API)
//   /fcc/v1/models     -> native /model picker catalog
//   /fcc/admin         -> Admin UI (loopback-only on the FCC side)
//   /fcc/health        -> health check
//
// The FCC server is a normal upstream; it must be running (see ecosystem.config.js
// / `npm run fcc`). Streaming (SSE) and tool use work because this middleware is
// mounted before express.json(), so bodies pass through unbuffered.

const FCC_TARGET_URL = process.env.FCC_TARGET_URL || 'http://127.0.0.1:8082';
const FCC_MOUNT_PATH = process.env.FCC_MOUNT_PATH || '/fcc';

const fccProxy = createProxyMiddleware({
    target: FCC_TARGET_URL,
    changeOrigin: true,
    ws: true, // forward websockets if the Admin UI uses them
    // Strip the mount prefix so upstream sees the real FCC paths.
    pathRewrite: (path) => path.replace(new RegExp('^' + FCC_MOUNT_PATH), '') || '/',
    on: {
        error: (err, req, res) => {
            console.error('[fcc-proxy] upstream error:', err.message);
            if (res && !res.headersSent && typeof res.status === 'function') {
                res.status(502).json({
                    error: 'Bad Gateway',
                    message: `free-claude-code service unreachable at ${FCC_TARGET_URL}. Is it running? (npm run fcc)`,
                });
            } else if (res && !res.writableEnded) {
                res.end();
            }
        },
    },
});

module.exports = { fccProxy, FCC_MOUNT_PATH, FCC_TARGET_URL };
