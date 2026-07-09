module.exports = {
  apps: [
    {
      name: 'api-handler',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        // Where the Node app reaches the free-claude-code service.
        FCC_TARGET_URL: 'http://127.0.0.1:8082'
      }
    },
    {
      // Bundled free-claude-code proxy (Python/FastAPI), run via uv.
      name: 'free-claude-code',
      script: 'uv',
      args: 'run fcc-server',
      cwd: './free-claude-code',
      interpreter: 'none', // uv is a native binary, not a node script
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        PORT: 8082,
        FCC_OPEN_BROWSER: 'false' // headless: don't try to open the Admin UI
      }
    }
  ]
};
