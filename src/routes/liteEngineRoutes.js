const express = require('express');
const router = express.Router();
const liteEngineController = require('../controllers/liteEngineController');
const authMiddleware = require('../middleware/authMiddleware'); // Optional: Secure it

// Public or Protected Route? User said "api alada korte paro". 
// Let's keep it open or use existing key validation if needed. 
// For now, open for internal use or simple key check.

router.post('/chat/completions', liteEngineController.handleChatCompletion);

module.exports = router;
