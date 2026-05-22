const express = require('express');
const router = express.Router();
const externalApiController = require('../controllers/externalApiController');
const authMiddleware = require('../middleware/authMiddleware');

// Public API Endpoint (Protected by Bearer Token in Header)
router.post('/v1/chat/completions', externalApiController.handleChatCompletion);
router.get('/v1/models', externalApiController.listModels);

// Management Endpoints (Protected by User Auth)
router.get('/key', authMiddleware, externalApiController.getApiKey);
router.post('/key/regenerate', authMiddleware, externalApiController.regenerateApiKey);
router.get('/usage', authMiddleware, externalApiController.getUsageStats);

module.exports = router;