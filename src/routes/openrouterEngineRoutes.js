const express = require('express');
const router = express.Router();
const openrouterEngineController = require('../controllers/openrouterEngineController');
// const openrouterConfigController = require('../controllers/openrouterConfigController');

router.post('/chat/completions', openrouterEngineController.handleChatCompletion);
router.post('/update', openrouterEngineController.forceUpdate); // Manual trigger for update

// --- Config & Testing Routes ---
// router.get('/config', openrouterConfigController.getConfig);
// router.post('/config', openrouterConfigController.saveConfig);
// router.post('/test-model', openrouterConfigController.testModel);

module.exports = router;
