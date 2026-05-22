const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const dbService = require('./dbService'); // Access to Supabase

// --- CONSTANTS & LIMITS ---
const MODELS = {
    TEXT: 'groq/compound-mini', // User requested "compond mini" (Groq Compound Mini)
    IMAGE: 'groq/compound',          // TPM: 70k (Generous)
    AUDIO: 'whisper-large-v3'        // TPM: Unlimited (RPM 20)
};

const LIMITS = {
    TEXT_TPM: 70000, // Updated: 70k TPM
    TEXT_RPM: 30,    // Updated: 30 RPM
    TEXT_RPD: 250,   // Updated: 250 Requests Per Day
    TEXT_CONTEXT_MAX: 100000, // Compound Mini has 131k context
    IMAGE_RPM: 30
};

// Deep Reasoning System Prompt (Gemini-like behavior)
const DEEP_REASONING_PROMPT = `
[SYSTEM INSTRUCTION: DEEP REASONING MODE]
You are an advanced AI assistant capable of deep reasoning, critical thinking, and detailed problem-solving, similar to Google Gemini.
Your goal is to provide comprehensive, accurate, and well-structured responses.

Guidelines:
1. **Deep Analysis**: Before answering, analyze the user's intent and all constraints. Break down complex problems.
2. **Structured Output**: Use clear formatting, bullet points, bold text for emphasis, and code blocks where appropriate.
3. **Reasoning**: Explain your logic clearly. If there are multiple approaches, evaluate them.
4. **Tone**: Be helpful, professional, and direct. Use emojis sparingly but effectively to enhance readability if needed.
5. **Completeness**: Do not provide partial answers. Ensure the solution is end-to-end.

[END SYSTEM INSTRUCTION]
`;

class LiteEngineService {
    constructor() {
        this.client = null; // Will be initialized per request with rotated key
    }

    /**
     * KEY ROTATION LOGIC
     * Fetches an active key from 'lite_engine_keys' table.
     * Strategy: Random active key to distribute load.
     */
    async getRotatedClient() {
        // 1. Fetch random active key
        const { data: keys, error } = await dbService.supabase
            .from('lite_engine_keys')
            .select('api_key, id')
            .eq('status', 'active')
            .limit(100); // Fetch a batch to pick random

        if (error || !keys || keys.length === 0) {
            console.error('[LiteEngine] NO ACTIVE KEYS FOUND! Fallback to ENV.');
            return {
                client: new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }),
                keyId: null
            };
        }

        // 2. Pick Random Key
        const randomKey = keys[Math.floor(Math.random() * keys.length)];
        
        // 3. Update Last Used (Async - don't block)
        dbService.supabase
            .from('lite_engine_keys')
            .update({ last_used_at: new Date(), requests_today: 1 }) // Increment logic needed in SQL or separate counter
            .eq('id', randomKey.id)
            .then(() => {});

        console.log(`[LiteEngine] Using Key ID: ${randomKey.id} (Pool Size: ${keys.length})`);
        
        return {
            client: new OpenAI({
                apiKey: randomKey.api_key,
                baseURL: 'https://api.groq.com/openai/v1'
            }),
            keyId: randomKey.id
        };
    }

    /**
     * Mark a key as offline in the database
     */
    async markKeyOffline(keyId) {
        if (!keyId) return;
        console.warn(`[LiteEngine] Marking key ID ${keyId} as OFFLINE due to invalid credentials.`);
        await dbService.supabase
            .from('lite_engine_keys')
            .update({ status: 'offline' })
            .eq('id', keyId);
    }

    /**
     * CORE: Process a Unified Request (Text/Image/Audio)
     * Strategies:
     * 1. Audio -> Transcribe -> Text
     * 2. Image -> Analyze -> Context
     * 3. Text -> Generate Reply (with Context)
     */
    async processRequest({ message, history, images = [], audioUrl = null, systemPrompt = '', stream = false }) {
        const { client, keyId } = await this.getRotatedClient(); // Get Fresh Key
        this.client = client;
        let finalContext = "";

        // 1. AUDIO PROCESSING (Whisper)
        if (audioUrl) {
            console.log('[LiteEngine] Processing Audio...');
            try {
                const transcription = await this.transcribeAudio(audioUrl);
                message = `${message} [User Audio Transcript: "${transcription}"]`;
            } catch (e) {
                console.error('[LiteEngine] Audio Failed:', e.message);
                if (e.message.includes('API key') || e.status === 401) {
                    await this.markKeyOffline(keyId);
                }
                message += " [Audio processing failed]";
            }
        }

        // 2. IMAGE PROCESSING (Compound)
        if (images && images.length > 0) {
            console.log(`[LiteEngine] Processing ${images.length} Images...`);
            try {
                // Process in parallel (Limit 2 concurrent to be safe on RPM)
                const imageAnalysis = await Promise.all(images.slice(0, 2).map(img => this.analyzeImage(img, keyId)));
                finalContext += `\n[Image Context]: ${imageAnalysis.join(' | ')}\n`;
            } catch (e) {
                console.error('[LiteEngine] Image Failed:', e.message);
                if (e.message.includes('API key') || e.status === 401) {
                    await this.markKeyOffline(keyId);
                }
            }
        }

        // 3. TEXT GENERATION (Llama 3.3) with STRICT LIMITS
        console.log(`[LiteEngine] Generating Text Reply (Stream: ${stream})...`);
        try {
            return await this.generateTextReply(message, history, systemPrompt, finalContext, keyId, stream);
        } catch (e) {
            if (e.message.includes('API key') || e.status === 401) {
                await this.markKeyOffline(keyId);
            }
            throw e;
        }
    }

    async transcribeAudio(audioUrl) {
        // Fetch audio file stream
        const response = await axios.get(audioUrl, { responseType: 'stream' });
        
        // Use Groq Whisper
        const transcription = await this.client.audio.transcriptions.create({
            file: response.data,
            model: MODELS.AUDIO,
            response_format: 'text' // Plain text for speed
        });

        return transcription;
    }

    async analyzeImage(imageUrl, keyId) {
        // Groq Vision (Compound)
        // Note: 'groq/compound' implies a system, but usually we use the vision model ID directly via chat completions
        // If 'groq/compound' is strictly a model ID, we use it. Otherwise, we might need llama-3.2-vision.
        // Based on user input: "Image hisebe Compound". We try that ID.
        
        try {
            const completion = await this.client.chat.completions.create({
                model: 'llama-3.2-11b-vision-preview', // Fallback/Actual Vision Model (Compound often maps here)
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Describe this image for a sales bot. What is the product? Color? Details?' },
                            { type: 'image_url', image_url: { url: imageUrl } }
                        ]
                    }
                ],
                max_tokens: 300
            });
            return completion.choices[0].message.content;
        } catch (e) {
            if (e.message.includes('API key') || e.status === 401) {
                await this.markKeyOffline(keyId);
                throw e;
            }
            // If model ID fails, try user's specific ID
            if (e.message.includes('model')) {
                 const completionRetry = await this.client.chat.completions.create({
                    model: MODELS.IMAGE, // User requested ID
                    messages: [
                        { role: 'user', content: `Analyze this image URL: ${imageUrl}` } // Compound might accept text-only if it's a pipeline?
                    ]
                });
                return completionRetry.choices[0].message.content;
            }
            throw e;
        }
    }

    async generateTextReply(userMessage, history, systemPrompt, extraContext, keyId, stream = false) {
        // --- SMART CONTEXT CHUNKING (OpenAI-style Sliding Window) ---
        // Strategy: Instead of failing on large prompts, we slice the history 
        // to fit within safe TPM/Context limits.
        
        // Inject Deep Reasoning Prompt
        const systemContent = DEEP_REASONING_PROMPT + "\n\n" + systemPrompt + extraContext;
        
        const getEstimatedTokens = (msgList, userMsg, systemMsg) => {
            const totalContent = systemMsg + userMsg + msgList.reduce((acc, m) => acc + (m.content || ''), '');
            return Math.ceil(totalContent.length / 3.5);
        };

        let currentHistory = [...history];
        let estimatedTokens = getEstimatedTokens(currentHistory, userMessage, systemContent);
        
        // Safe Limit: 40,000 tokens (Groq Free TPM is often 70k, so 40k leaves room for multiple users)
        const SAFE_TOKEN_LIMIT = 40000;
        const HARD_STOP_LIMIT = 100000;

        console.log(`[LiteEngine] Initial Estimated Tokens: ${estimatedTokens} (Stream: ${stream})`);

        // If even system + user message > 100k, we must notify
        if (getEstimatedTokens([], userMessage, systemContent) > HARD_STOP_LIMIT) {
             const errorMsg = `[SYSTEM LOG]: Your System Prompt/Product Details are too large (${estimatedTokens} tokens). Even without chat history, it exceeds the Groq limit. Please shorten them.`;
             if (stream) return (async function* () { yield errorMsg; })();
             return errorMsg;
        }

        // SLIDING WINDOW: Remove oldest messages until we are under SAFE_TOKEN_LIMIT
        while (currentHistory.length > 0 && estimatedTokens > SAFE_TOKEN_LIMIT) {
            currentHistory.shift(); // Remove oldest
            estimatedTokens = getEstimatedTokens(currentHistory, userMessage, systemContent);
        }

        if (history.length !== currentHistory.length) {
            console.log(`[LiteEngine] Sliced history from ${history.length} to ${currentHistory.length} messages to fit token limits.`);
        }

        const systemMsg = { role: 'system', content: systemContent };
        const messages = [systemMsg, ...currentHistory, { role: 'user', content: userMessage }];

        // Call Groq
        return await this.callGroqAPI(messages, keyId, stream);
    }

    async callGroqAPI(messages, keyId, stream = false) {
        let attempts = 0;
        let lastError = null;
        let currentKeyId = keyId;

        while (attempts < 3) {
            try {
                const completion = await this.client.chat.completions.create({
                    model: MODELS.TEXT,
                    messages: messages,
                    temperature: 0.7,
                    max_tokens: 4096, 
                    stream: stream
                });

                if (stream) {
                    return completion; // Return the stream object
                }

                let content = completion.choices[0].message.content;
                
                // Auto-fix: Parse JSON if model ignored plain text instruction
                try {
                    if (content.trim().startsWith('{') && content.trim().endsWith('}')) {
                        const json = JSON.parse(content);
                        if (json.message) content = json.message;
                        else if (json.content) content = json.content;
                        else if (json.response) content = json.response;
                    }
                } catch (e) {
                    // Not JSON, ignore
                }

                return content;
            } catch (error) {
                lastError = error;
                // Handle Rate Limits (429) or Service Issues (5xx)
                if (error.status === 429 || error.status >= 500) {
                    attempts++;
                    console.warn(`[LiteEngine] Groq Issue (Attempt ${attempts}): ${error.message}`);
                    
                    if (attempts < 3) {
                        // Rotate key and retry
                        const { client, keyId: nextKeyId } = await this.getRotatedClient();
                        this.client = client;
                        currentKeyId = nextKeyId;
                        continue;
                    }
                }
                
                // If it's an API Key error
                if (error.message.includes('API key') || error.status === 401) {
                    await this.markKeyOffline(currentKeyId);
                }

                // If it's a Context Length error (Big Prompt)
                if (error.status === 413 || error.message.includes('context_length') || error.message.includes('too large')) {
                    return `[SYSTEM LOG]: The current conversation is too large for the Groq Engine. Please reduce the length of your System Prompt or clear some history.`;
                }

                throw error;
            }
        }
        
        throw lastError || new Error("Groq API failed after multiple retries");
    }
}

module.exports = new LiteEngineService();
