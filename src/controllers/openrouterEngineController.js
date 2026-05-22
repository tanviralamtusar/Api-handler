const openrouterEngineService = require('../services/openrouterEngineService');
const dbService = require('../services/dbService');
const crypto = require('crypto');

// Cost per Token
const COST_PER_TOKEN = 0.00025;

exports.handleChatCompletion = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: { message: 'Missing or invalid Authorization header', type: 'invalid_request_error', code: 'unauthorized' } });
        }

        const apiKey = authHeader.replace('Bearer ', '').trim();

        // 1. Validate API Key
        const { data: userConfig, error } = await dbService.supabase
            .from('user_configs')
            .select('user_id, service_api_key')
            .eq('service_api_key', apiKey)
            .single();

        if (error || !userConfig) {
            return res.status(401).json({ error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } });
        }

        const { messages, stream } = req.body;
        
        // 3. Parse Input
        const lastMessageObj = messages[messages.length - 1];
        const history = messages.slice(0, messages.length - 1);
        
        let userMessage = "";
        let images = [];

        if (Array.isArray(lastMessageObj.content)) {
            lastMessageObj.content.forEach(part => {
                if (part.type === 'text') userMessage += part.text + " ";
                else if (part.type === 'image_url') images.push(part.image_url.url);
            });
        } else {
            userMessage = lastMessageObj.content;
        }

        const systemMsg = messages.find(m => m.role === 'system');
        const systemPrompt = systemMsg ? systemMsg.content : "You are a helpful assistant.";

        // 4. Process Request
        const replyText = await openrouterEngineService.processRequest({
            message: userMessage,
            history: history,
            images: images,
            systemPrompt: systemPrompt
        });

        // 5. Calculate Usage (Approximation)
        const promptTokens = Math.ceil((userMessage.length + systemPrompt.length) / 3.5);
        const completionTokens = Math.ceil(replyText.length / 3.5);
        const totalTokens = promptTokens + completionTokens;



        // 7. Format Response
        const response = {
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'freeapi-lite', 
            choices: [{
                index: 0,
                message: { role: 'assistant', content: replyText },
                finish_reason: 'stop'
            }],
            usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: totalTokens
            }
        };

        res.json(response);

    } catch (error) {
        console.error('[OpenRouter API] Error:', error);
        res.status(500).json({ error: { message: error.message } });
    }
};

exports.forceUpdate = async (req, res) => {
    try {
        await openrouterEngineService.performUpdateCycle();
        res.json({ status: 'success', message: 'Engine updated successfully.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
