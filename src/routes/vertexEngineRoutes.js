const express = require('express');
const router = express.Router();
const vertexEngineController = require('../controllers/vertexEngineController');

// Standalone vertex endpoint
router.post('/chat/completions', vertexEngineController.handleChatCompletion);

module.exports = router;
