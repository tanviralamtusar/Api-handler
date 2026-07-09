const express = require('express');
const cors = require('cors');
// const webhookRoutes = require('./routes/webhookRoutes');
// const messengerRoutes = require('./routes/messengerRoutes');
// const authRoutes = require('./routes/authRoutes');
// const productRoutes = require('./routes/productRoutes');
const externalApiRoutes = require('./routes/externalApiRoutes');
const liteEngineRoutes = require('./routes/liteEngineRoutes'); // New Lite Engine
const openrouterEngineRoutes = require('./routes/openrouterEngineRoutes'); // New OpenRouter Engine
const vertexEngineRoutes = require('./routes/vertexEngineRoutes'); // New Vertex Engine
const { fccProxy, FCC_MOUNT_PATH } = require('./middleware/fccProxy'); // Bundled free-claude-code proxy

const app = express();


// Middleware
app.use(cors());

// free-claude-code passthrough — MUST be mounted before express.json() so that
// request bodies (and streaming SSE responses) are forwarded untouched.
app.use(FCC_MOUNT_PATH, fccProxy);

app.use(express.json());

// Routes
// We mount the webhook route at /webhook or /api/webhook based on preference
// The user's n8n.json used /webhook
// app.use('/webhook', webhookRoutes);

// Register other routes
// app.use('/messenger', messengerRoutes);
// app.use('/api/auth', authRoutes); // Matches frontend call /api/auth/facebook/exchange-token
// app.use('/api/products', productRoutes); // New Product Management Routes
app.use('/api/external', externalApiRoutes); // External "Cheap Engine" API
app.use('/api/lite', liteEngineRoutes); // New "FreeApi 2.0 Lite" API
app.use('/api/openrouter', openrouterEngineRoutes); // New OpenRouter Engine API
app.use('/api/vertex', vertexEngineRoutes); // New Vertex Engine API

// Basic health check

app.get('/', (req, res) => {
    res.send('AI Agent Backend Running');
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Unhandled Application Error:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

module.exports = app;
