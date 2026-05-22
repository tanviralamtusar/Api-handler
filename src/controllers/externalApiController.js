const dbService = require('../services/dbService');
const aiService = require('../services/aiService');
const liteEngineService = require('../services/liteEngineService');
const openrouterEngineService = require('../services/openrouterEngineService');
const vertexEngineService = require('../services/vertexEngineService');
const crypto = require('crypto');



// Helper to validate API Key and return user config
const validateApiKey = async (req) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn(`[ExternalAPI] Missing or invalid Authorization header: ${authHeader ? 'Exists but no Bearer' : 'Missing'}`);
        return { error: { status: 401, message: 'Missing or invalid Authorization header', type: 'invalid_request_error', code: 'unauthorized' } };
    }

    const apiKey = authHeader.replace('Bearer ', '').trim();

    // Check if key is actually provided after 'Bearer '
    if (!apiKey) {
        return { error: { status: 401, message: 'Invalid API Key format', type: 'invalid_request_error', code: 'invalid_api_key' } };
    }

    const { data: userConfig, error } = await dbService.supabase
        .from('user_configs')
        .select('user_id, service_api_key')
        .eq('service_api_key', apiKey)
        .maybeSingle();

    if (error) {
        console.error(`[ExternalAPI] Database Error for Key: ${apiKey.substring(0, 8)}...`, error);
        return { error: { status: 500, message: 'Internal Database Error', type: 'api_error' } };
    }

    if (!userConfig) {
        console.warn(`[ExternalAPI] Auth Failed - Key not found in DB: ${apiKey.substring(0, 8)}...`);
        return { error: { status: 401, message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } };
    }

    return { userConfig };
};

// Helper to clean AI response text (removes JSON structures if they appear)
const cleanAiText = (text) => {
    if (!text) return "";
    
    // 1. Try to parse as direct JSON
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed.reply || parsed.text || parsed.message || text;
        }
    } catch (e) {
        // Not direct JSON, continue
    }

    // 2. Look for JSON-like structure with "reply": "..."
    const replyMatch = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (replyMatch && replyMatch[1]) {
        // Unescape the captured string
        try {
            return JSON.parse(`"${replyMatch[1]}"`);
        } catch (e) {
            return replyMatch[1];
        }
    }

    // 3. Remove markdown code blocks if they wrap the whole thing
    let cleaned = text.trim();
    if (cleaned.startsWith("```") && cleaned.endsWith("```")) {
        cleaned = cleaned.replace(/^```[a-z]*\n/i, "").replace(/\n```$/i, "").trim();
        // Recurse once if we found a code block
        return cleanAiText(cleaned);
    }

    return text;
};

exports.handleChatCompletion = async (req, res) => {
    try {
        // 1. Validate API Key & Fetch User Config
        const { userConfig, error: authError } = await validateApiKey(req);
        if (authError) {
            return res.status(authError.status).json({ error: { message: authError.message, type: authError.type, code: authError.code } });
        }



        // 4. Process Request (OpenAI Format)
        const { messages, model, stream } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
        }

        let systemPrompt = null;
        let history = [];
        let userMessage = "";
        let imageUrls = [];
        let audioUrls = [];

        // Parse messages
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            let contentText = "";

            // Handle Multimodal Content (Array of objects)
            if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        contentText += part.text || "";
                    } else if (part.type === 'image_url') {
                        const url = part.image_url?.url || part.image_url;
                        if (url) {
                            // If it's the active user message, add to imageUrls for processing
                            if (i === messages.length - 1 && msg.role === 'user') {
                                imageUrls.push(url);
                            } else {
                                contentText += ` [Image] `; 
                            }
                        }
                    } else if (part.type === 'audio_url') {
                        // Custom support for Audio (e.g. { type: "audio_url", audio_url: { url: "..." } })
                        const url = part.audio_url?.url || part.audio_url;
                        if (url) {
                            if (i === messages.length - 1 && msg.role === 'user') {
                                audioUrls.push(url);
                            } else {
                                contentText += ` [Audio] `;
                            }
                        }
                    }
                }
            } else {
                // Standard String Content
                contentText = msg.content || "";
            }

            if (msg.role === 'system') {
                systemPrompt = contentText;
            } else {
                // If it's the last message and it's user, it's the current prompt
                if (i === messages.length - 1 && msg.role === 'user') {
                    userMessage = contentText;
                } else {
                    history.push({ role: msg.role, content: contentText });
                }
            }
        }

        if (!userMessage) {
             return res.status(400).json({ error: { message: 'Last message must be from user', type: 'invalid_request_error' } });
        }

        // 4. ROUTING LOGIC based on Model Name
        let aiText = "";
        let aiReasoning = "";
        let totalTokens = 0;
        let responseModelName = "freeapi-pro"; // Default to Pro
        let billingLabel = "Cheap Engine API Call";

        if (model === 'freeapi-flash' || model === 'freeapi-2.0-lite') {
            // --- FLASH ENGINE (Groq) ---
            responseModelName = "freeapi-flash";
            billingLabel = "Flash Engine API Call";
            
            const result = await liteEngineService.processRequest({
                message: userMessage,
                history: history,
                images: imageUrls,
                audioUrl: audioUrls.length > 0 ? audioUrls[0] : null,
                systemPrompt: systemPrompt || "You are a helpful assistant.",
                stream: stream === true || stream === 'true'
            });

            // Handle Streaming Response
            if (stream === true || stream === 'true') {
                const responseId = `chatcmpl-${Date.now()}`;
                const created = Math.floor(Date.now() / 1000);

                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                let fullText = "";
                try {
                    for await (const chunk of result) {
                        const content = chunk.choices?.[0]?.delta?.content || "";
                        fullText += content;
                        
                        const data = {
                            id: responseId,
                            object: 'chat.completion.chunk',
                            created: created,
                            model: responseModelName,
                            choices: [
                                {
                                    index: 0,
                                    delta: { content: content },
                                    finish_reason: chunk.choices?.[0]?.finish_reason || null
                                }
                            ]
                        };
                        res.write(`data: ${JSON.stringify(data)}\n\n`);
                    }
                    
                    // Final log and deduction after stream finishes
                    const cleanFullText = cleanAiText(fullText);
                    const promptTokens = Math.ceil((userMessage.length + (systemPrompt?.length || 0)) / 3.5);
                    const completionTokens = Math.ceil(cleanFullText.length / 3.5);
                    totalTokens = promptTokens + completionTokens;

                    await dbService.logApiUsage(userConfig.user_id, responseModelName, totalTokens, 0);

                    res.write('data: [DONE]\n\n');
                    return res.end();
                } catch (streamError) {
                    console.error('[ExternalAPI] Stream Error:', streamError);
                    return res.end();
                }
            }

            aiText = cleanAiText(result);
            const promptTokens = Math.ceil((userMessage.length + (systemPrompt?.length || 0)) / 3.5);
            const completionTokens = Math.ceil(aiText.length / 3.5);
            totalTokens = promptTokens + completionTokens;

        } else if (model === 'freeapi-lite' || model === 'freeapi-2.0-pro') {
            // --- LITE ENGINE (OpenRouter) ---
            // Note: User renamed OpenRouter engine to 'freeapi-lite'
            responseModelName = "freeapi-lite";
            billingLabel = "Lite Engine API Call";

            const result = await openrouterEngineService.processRequest({
                message: userMessage,
                history: history,
                images: imageUrls,
                systemPrompt: systemPrompt || "You are a helpful assistant."
            });
            aiText = cleanAiText(result);

             const promptTokens = Math.ceil((userMessage.length + (systemPrompt?.length || 0)) / 3.5);
             const completionTokens = Math.ceil(aiText.length / 3.5);
             totalTokens = promptTokens + completionTokens;

        } else if (model === 'gemini-3.1-pro-preview') {
            // --- VERTEX ENGINE ---
            responseModelName = "gemini-3.1-pro-preview";
            billingLabel = "Vertex Engine API Call";

            const targetModel = 'gemini-3.1-pro-preview';
            
            const result = await vertexEngineService.processRequest({
                message: userMessage,
                history: history,
                systemPrompt: systemPrompt || "You are a helpful assistant.",
                model: targetModel,
                stream: stream === true || stream === 'true'
            });

            // Handle Streaming Response
            if (stream === true || stream === 'true') {
                const responseId = `chatcmpl-${Date.now()}`;
                const created = Math.floor(Date.now() / 1000);

                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                // Write the initial role chunk to satisfy strict OpenAI-compatible clients (like Roo Code)
                const initialData = {
                    id: responseId,
                    object: 'chat.completion.chunk',
                    created: created,
                    model: responseModelName,
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
                    for await (const chunk of result) {
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
                                model: responseModelName,
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
                    
                    // Final log and deduction after stream finishes
                    const cleanFullText = cleanAiText(fullText);
                    const promptTokens = Math.ceil((userMessage.length + (systemPrompt?.length || 0)) / 3.5);
                    const completionTokens = Math.ceil(cleanFullText.length / 3.5);
                    totalTokens = promptTokens + completionTokens;

                    await dbService.logApiUsage(userConfig.user_id, responseModelName, totalTokens, 0);

                    res.write('data: [DONE]\n\n');
                    return res.end();
                } catch (streamError) {
                    console.error('[ExternalAPI] Stream Error:', streamError);
                    return res.end();
                }
            }

            aiText = cleanAiText(result.text);
            aiReasoning = result.reasoning || "";
            const promptTokens = Math.ceil((userMessage.length + (systemPrompt?.length || 0)) / 3.5);
            const completionTokens = Math.ceil((aiText.length + aiReasoning.length) / 3.5);
            totalTokens = promptTokens + completionTokens;

        } else {
            // --- PRO ENGINE (Gemini / RAG / Default) ---
            // User requested 'freeapi' to be named 'freeapi-pro'
            responseModelName = "freeapi-pro";
            billingLabel = "Pro Engine API Call";

            const prompts = systemPrompt ? { text_prompt: systemPrompt } : {};

            const aiResponseObj = await aiService.generateReply(
                userMessage,
                { ai_provider: 'system', chat_model: model || 'default', is_external_api: true }, 
                prompts, 
                history,
                'API_User', 
                'API_Owner', 
                null, 
                imageUrls, 
                audioUrls, 
                0 
            );

            if (typeof aiResponseObj === 'object' && aiResponseObj !== null) {
                aiText = aiResponseObj.reply || aiResponseObj.text || JSON.stringify(aiResponseObj);
                totalTokens = aiResponseObj.token_usage || 0;
            } else {
                aiText = String(aiResponseObj);
            }

            // Clean AI Text from any JSON artifacts
            aiText = cleanAiText(aiText);

            // Fallback Token Calculation for Default Engine
            // If the underlying provider did not return usage,
            // approximate total tokens including system prompt, history and reply.
            if (totalTokens === 0) {
                const historyChars = history.reduce((acc, m) => acc + (m.content?.length || 0), 0);
                const systemChars = systemPrompt ? systemPrompt.length : 0;
                const inputChars = userMessage.length + historyChars + systemChars;
                const outputChars = aiText.length;
                totalTokens = Math.ceil((inputChars + outputChars) / 4);
            }
        }

        // 5. Log API Usage (no cost)
        await dbService.logApiUsage(userConfig.user_id, responseModelName, totalTokens, 0);

        // 6. Return Response
        const responseId = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        return res.json({
            id: responseId,
            object: 'chat.completion',
            created: created,
            model: responseModelName, // Dynamic based on engine
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: aiText,
                        ...(aiReasoning ? { reasoning_content: aiReasoning } : {})
                    },
                    finish_reason: 'stop'
                }
            ],
            usage: {
                prompt_tokens: 0, 
                completion_tokens: 0,
                total_tokens: totalTokens
            }
        });

    } catch (error) {
        console.error('[ExternalAPI] Error:', error);
        return res.status(500).json({ error: { message: 'Internal Server Error', type: 'api_error' } });
    }
};

exports.listModels = async (req, res) => {
    try {
        const { error: authError } = await validateApiKey(req);
        if (authError) {
            return res.status(authError.status).json({ error: { message: authError.message, type: authError.type, code: authError.code } });
        }

        return res.json({
            object: "list",
            data: [
                { id: "freeapi-pro", object: "model", created: 1677610602, owned_by: "freeapi" },
                { id: "freeapi-flash", object: "model", created: 1709251200, owned_by: "freeapi" },
                { id: "freeapi-lite", object: "model", created: 1709251200, owned_by: "freeapi" },
                { id: "gemini-3.1-pro-preview", object: "model", created: 1718000000, owned_by: "google" }
            ]
        });
    } catch (error) {
        console.error('[ExternalAPI] Models Error:', error);
        return res.status(500).json({ error: { message: 'Internal Server Error', type: 'api_error' } });
    }
};

exports.getApiKey = async (req, res) => {
    try {
        const userId = req.user?.id; 
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        
        const { data, error } = await dbService.supabase
            .from('user_configs')
            .select('service_api_key')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            console.error("Fetch Key Error:", error);
            return res.status(500).json({ error: error.message });
        }
        
        res.json({ api_key: data?.service_api_key || null });
    } catch (error) {
        console.error("Fetch Key Exception:", error);
        res.status(500).json({ error: error.message });
    }
};

exports.regenerateApiKey = async (req, res) => {
    try {
        const userId = req.user?.id;
        console.log(`[KeyGen] Request received for user: ${userId}`);

        if (!userId) {
            console.warn(`[KeyGen] Unauthorized access attempt`);
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const newKey = 'sk-' + crypto.randomBytes(24).toString('hex');
        console.log(`[KeyGen] Generating new key for user: ${userId}`);

        // Use upsert to handle both insert and update safely
        const { data, error } = await dbService.supabase
            .from('user_configs')
            .upsert({ 
                user_id: userId, 
                service_api_key: newKey,
                updated_at: new Date().toISOString()
            }, { 
                onConflict: 'user_id'
            })
            .select()
            .single();

        if (error) {
            console.error(`[KeyGen] Database Error for user ${userId}:`, error);
            return res.status(500).json({ error: `Database error: ${error.message}` });
        }

        console.log(`[KeyGen] Successfully generated key for user: ${userId}`);
        res.json({ api_key: newKey });
    } catch (error) {
        console.error("[KeyGen] Unexpected Exception:", error);
        res.status(500).json({ error: `Internal server error: ${error.message}` });
    }
};

exports.getUsageStats = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const { startDate, endDate } = req.query;

        // 1. Fetch recent usage stats (last 100)
        let query = dbService.supabase
            .from('api_usage_stats')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        const { data: stats, error } = await query.limit(100);

        if (error) {
            if (error.code === '42P01') return res.json({ stats: [], summary: {} });
            throw error;
        }

        // 2. Calculate Totals
        // Total Cost & Tokens & Requests
        const { data: totalData } = await dbService.supabase
            .from('api_usage_stats')
            .select('cost,tokens')
            .eq('user_id', userId);
        
        const totalCost = (totalData || []).reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
        const totalTokens = (totalData || []).reduce((sum, item) => sum + (Number(item.tokens) || 0), 0);
        const totalRequests = (totalData || []).length;

        // Today's Cost/Tokens/Requests
        const today = new Date().toISOString().split('T')[0];
        const { data: todayData } = await dbService.supabase
            .from('api_usage_stats')
            .select('cost,tokens')
            .eq('user_id', userId)
            .gte('created_at', `${today}T00:00:00Z`);

        const todayCost = (todayData || []).reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
        const todayTokens = (todayData || []).reduce((sum, item) => sum + (Number(item.tokens) || 0), 0);
        const todayRequests = (todayData || []).length;

        // Yesterday Cost/Tokens/Requests
        const y = new Date();
        y.setDate(y.getDate() - 1);
        const yesterday = y.toISOString().split('T')[0];
        const { data: yesterdayData } = await dbService.supabase
            .from('api_usage_stats')
            .select('cost,tokens')
            .eq('user_id', userId)
            .gte('created_at', `${yesterday}T00:00:00Z`)
            .lte('created_at', `${yesterday}T23:59:59Z`);
        const yesterdayCost = (yesterdayData || []).reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
        const yesterdayTokens = (yesterdayData || []).reduce((sum, item) => sum + (Number(item.tokens) || 0), 0);
        const yesterdayRequests = (yesterdayData || []).length;

        // Custom Range Cost
        let rangeCost = 0;
        let rangeTokens = 0;
        let rangeRequests = 0;
        if (startDate && endDate) {
            const { data: rangeData } = await dbService.supabase
                .from('api_usage_stats')
                .select('cost,tokens')
                .eq('user_id', userId)
                .gte('created_at', `${startDate}T00:00:00Z`)
                .lte('created_at', `${endDate}T23:59:59Z`);
            
            rangeCost = (rangeData || []).reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
            rangeTokens = (rangeData || []).reduce((sum, item) => sum + (Number(item.tokens) || 0), 0);
            rangeRequests = (rangeData || []).length;
        }

        res.json({ 
            stats: stats,
            summary: {
                total_cost: totalCost,
                total_tokens: totalTokens,
                total_requests: totalRequests,
                today_cost: todayCost,
                today_tokens: todayTokens,
                today_requests: todayRequests,
                yesterday_cost: yesterdayCost,
                yesterday_tokens: yesterdayTokens,
                yesterday_requests: yesterdayRequests,
                range_cost: rangeCost,
                range_tokens: rangeTokens,
                range_requests: rangeRequests,
                start_date: startDate,
                end_date: endDate
            }
        });
    } catch (error) {
        console.error("[UsageStats] Error:", error);
        res.status(500).json({ error: error.message });
    }
};
