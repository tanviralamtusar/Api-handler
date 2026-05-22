const liteEngineService = require('../services/liteEngineService');
const dbService = require('../services/dbService');
const crypto = require('crypto');

// Cost per Token (Configurable, using same as external for now)
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

        const { messages, model, stream } = req.body;
        
        // 3. Parse Last Message & History
        const lastMessageObj = messages[messages.length - 1];
        const history = messages.slice(0, messages.length - 1);
        
        let userMessage = "";
        let images = [];
        let audioUrl = null;

        // 4. Extract Content (Text/Image/Audio)
        if (Array.isArray(lastMessageObj.content)) {
            // Multimodal Request
            lastMessageObj.content.forEach(part => {
                if (part.type === 'text') userMessage += part.text + " ";
                else if (part.type === 'image_url') images.push(part.image_url.url);
                else if (part.type === 'audio_url') audioUrl = part.audio_url.url; // Custom or future standard
            });
        } else {
            userMessage = lastMessageObj.content;
        }

        // 5. Extract System Prompt
        const systemMsg = messages.find(m => m.role === 'system');
        const systemPrompt = systemMsg ? systemMsg.content : "You are a helpful assistant.";

        // 6. Call Lite Engine
        const replyText = await liteEngineService.processRequest({
            message: userMessage,
            history: history,
            images: images,
            audioUrl: audioUrl,
            systemPrompt: systemPrompt
        });

        // 7. Format Response & Calculate Usage
        // Fake Usage Stats (Approximation)
        const promptTokens = Math.ceil((userMessage.length + systemPrompt.length) / 3.5);
        const completionTokens = Math.ceil(replyText.length / 3.5);
        const totalTokens = promptTokens + completionTokens;



        const response = {
            id: `chatcmpl-${crypto.randomUUID()}`, // Professional UUID
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'freeapi-flash', // BRANDED NAME
            system_fingerprint: 'fp_freeapi_flash', // Fake Fingerprint
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: replyText
                    },
                    finish_reason: 'stop',
                    logprobs: null
                }
            ],
            usage: {
                prompt_tokens: promptTokens, 
                completion_tokens: completionTokens,
                total_tokens: totalTokens
            }
        };

        res.json(response);

    } catch (error) {
        console.error('[LiteEngine API] Error:', error);
        res.status(500).json({
            error: {
                message: error.message || "Internal Server Error",
                type: error.name,
                code: error.status || 500
            }
        });
    }
};
