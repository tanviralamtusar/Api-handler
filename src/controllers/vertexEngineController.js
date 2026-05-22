const vertexEngineService = require('../services/vertexEngineService');
const dbService = require('../services/dbService');
const crypto = require('crypto');

// Cost per Token (using similar pricing logic as others)
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
        
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: { message: 'Messages array is required', type: 'invalid_request_error' } });
        }

        // 3. Parse Input
        const lastMessageObj = messages[messages.length - 1];
        const history = messages.slice(0, messages.length - 1);
        
        let userMessage = "";

        if (Array.isArray(lastMessageObj.content)) {
            lastMessageObj.content.forEach(part => {
                if (part.type === 'text') userMessage += part.text + " ";
                // Image handling can be added here if needed in the future
            });
        } else {
            userMessage = lastMessageObj.content;
        }

        // Extract System Prompt
        const systemMsg = messages.find(m => m.role === 'system');
        const systemPrompt = systemMsg ? systemMsg.content : "You are a helpful assistant.";

        // Prepare History, removing system prompts
        const cleanHistory = history.filter(m => m.role !== 'system');

        // Target Model
        const targetModel = model || 'gemini-3.1-pro-preview';

        // 4. Process Request
        if (stream === true || stream === 'true') {
            const streamingResp = await vertexEngineService.processRequest({
                message: userMessage,
                history: cleanHistory,
                systemPrompt: systemPrompt,
                model: targetModel,
                stream: true
            });

            const responseId = `chatcmpl-${crypto.randomUUID()}`;
            const created = Math.floor(Date.now() / 1000);

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            // Write the initial role chunk to satisfy strict OpenAI-compatible clients (like Roo Code)
            const initialData = {
                id: responseId,
                object: 'chat.completion.chunk',
                created: created,
                model: targetModel,
                choices: [
                    {
                        index: 0,
                        delta: { role: 'assistant' },
                        finish_reason: null
                    }
                ]
            };
            res.write(`data: ${JSON.stringify(initialData)}\n\n`);

            let fullText = "";
            let fullReasoning = "";

            try {
                for await (const chunk of streamingResp) {
                    let content = "";
                    let reasoning = "";
                    
                    const parts = chunk.candidates?.[0]?.content?.parts || [];
                    for (const part of parts) {
                        if (typeof part.text === 'string') {
                            if (part.thought === true) {
                                reasoning += part.text;
                            } else {
                                content += part.text;
                            }
                        }
                    }
                    
                    fullText += content;
                    fullReasoning += reasoning;
                    
                    if (content || reasoning) {
                        const delta = {};
                        if (content) delta.content = content;
                        if (reasoning) delta.reasoning_content = reasoning;

                        const data = {
                            id: responseId,
                            object: 'chat.completion.chunk',
                            created: created,
                            model: targetModel,
                            choices: [
                                {
                                    index: 0,
                                    delta: delta,
                                    finish_reason: null
                                }
                            ]
                        };
                        res.write(`data: ${JSON.stringify(data)}\n\n`);
                    }
                }

                // Final chunk
                res.write(`data: ${JSON.stringify({
                    id: responseId,
                    object: 'chat.completion.chunk',
                    created: created,
                    model: targetModel,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                })}\n\n`);
                res.write('data: [DONE]\n\n');

                // Log Usage
                const promptTokens = Math.ceil((userMessage.length + systemPrompt.length) / 3.5);
                const completionTokens = Math.ceil(fullText.length / 3.5);
                const totalTokens = promptTokens + completionTokens;
                await dbService.logApiUsage(userConfig.user_id, targetModel, totalTokens, 0);
                
                return res.end();
            } catch (streamError) {
                console.error('[VertexEngine API] Stream Error:', streamError);
                return res.end();
            }

        } else {
            const result = await vertexEngineService.processRequest({
                message: userMessage,
                history: cleanHistory,
                systemPrompt: systemPrompt,
                model: targetModel,
                stream: false
            });

            const replyText = result.text;
            const reasoningText = result.reasoning;

            // 5. Calculate Usage (Approximation)
            const promptTokens = Math.ceil((userMessage.length + systemPrompt.length) / 3.5);
            const completionTokens = Math.ceil((replyText.length + reasoningText.length) / 3.5);
            const totalTokens = promptTokens + completionTokens;

            await dbService.logApiUsage(userConfig.user_id, targetModel, totalTokens, 0);

            // 7. Format Response
            const messagePayload = { role: 'assistant', content: replyText };
            if (reasoningText) {
                messagePayload.reasoning_content = reasoningText;
            }

            const response = {
                id: `chatcmpl-${crypto.randomUUID()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: targetModel, 
                choices: [{
                    index: 0,
                    message: messagePayload,
                    finish_reason: 'stop'
                }],
                usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: totalTokens
                }
            };

            return res.json(response);
        }

    } catch (error) {
        console.error('[VertexEngine API] Error:', error);
        res.status(500).json({ error: { message: error.message } });
    }
};
