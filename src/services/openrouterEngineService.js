const axios = require('axios');
const dbService = require('./dbService');
const keyService = require('./keyService'); // Added for AI Judge
const OpenAI = require('openai');

// --- CONSTANTS ---
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 Hours
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

// MODELS TO EXCLUDE (Low Rate Limits or Poor Quality)
const EXCLUDED_MODELS = [
    'qwen/qwen3-next-80b-a3b-instruct', // Known 2 RPM limit
    'nousresearch/hermes-3-llama-3.1-405b:free', // User verified: Strict limits / Unstable
    // Add more here...
];

class OpenRouterEngineService {
    constructor() {
        this.configCache = null; // { text, voice, image, keys: [] }
        this.lastUpdate = 0;
        
        // Start Auto-Updater
        this.initAutoUpdate();
    }

    async initAutoUpdate() {
        console.log('[OpenRouterEngine] Starting Auto-Update Service...');
        
        // Load initial config from DB (Fast Start)
        await this.loadConfigFromDB();

        // If no config found, run first cycle
        if (!this.configCache) {
            await this.performUpdateCycle();
        }
        
        setInterval(() => {
            this.performUpdateCycle();
        }, UPDATE_INTERVAL_MS);
    }

    /**
     * Load Config from DB
     */
    async loadConfigFromDB() {
        try {
            const { data } = await dbService.supabase
                .from('openrouter_engine_config')
                .select('*')
                .eq('config_type', 'best_models')
                .single();
            
            if (data) {
                // Fetch Keys too
                const validKeys = await this.updateKeyStatus();
                
                this.configCache = {
                    text: data.text_model,
                    voice: data.voice_model,
                    image: data.image_model,
                    keys: validKeys
                };
                
                // Update KeyService Limits if present
                if (data.text_model_details && keyService.setManualLimit) {
                    keyService.setManualLimit(data.text_model, data.text_model_details);
                }
                
                console.log('[OpenRouterEngine] 📂 Loaded Config from DB:', this.configCache);
            }
        } catch (error) {
            console.warn('[OpenRouterEngine] Could not load config from DB:', error.message);
        }
    }

    /**
     * CORE: 24-Hour Update Cycle
     * 1. Fetch Free Models
     * 2. Select Best 3 (Text, Voice, Image)
     * 3. Check Key Limits
     * 4. Save to DB & Cache
     */
    async performUpdateCycle() {
        try {
            console.log('[OpenRouterEngine] 🔄 Running Daily Update Cycle...');
            
            // CHECK LOCK: If config is manually locked, skip auto-selection
            const { data: currentConfig } = await dbService.supabase
                .from('openrouter_engine_config')
                .select('text_model_details')
                .eq('config_type', 'best_models')
                .single();
                
            if (currentConfig && currentConfig.text_model_details && currentConfig.text_model_details.lock_auto_update) {
                 console.log('[OpenRouterEngine] 🔒 Auto-Update Skipped (Locked by Admin)');
                 // Refresh keys only
                 await this.updateKeyStatus();
                 return;
            }

            // Step 1: Fetch Models
            const allModels = await this.fetchOpenRouterModels();
            const freeModels = allModels.filter(m => 
                m.pricing && 
                (m.pricing.prompt === "0" || m.pricing.prompt === 0) && 
                (m.pricing.completion === "0" || m.pricing.completion === 0) &&
                // Check against EXCLUDED_MODELS
                !EXCLUDED_MODELS.some(ex => m.id.includes(ex))
            );

            // Step 2: Select Best Models (Async AI Judge)
            const bestModels = await this.selectBestModels(freeModels);
            console.log('[OpenRouterEngine] ✅ Selected Models:', bestModels);

            // Step 3: Check Keys & Update Limits
            const validKeys = await this.updateKeyStatus();

            // Step 4: Save Config to DB
            await this.saveConfigToDB(bestModels);

            // Step 5: Update Cache
            this.configCache = {
                ...bestModels,
                keys: validKeys
            };
            this.lastUpdate = Date.now();

        } catch (error) {
            console.error('[OpenRouterEngine] ❌ Update Cycle Failed:', error.message);
        }
    }

    /**
     * Fetch all models from OpenRouter
     */
    async fetchOpenRouterModels() {
        try {
            const response = await axios.get(`${OPENROUTER_API_BASE}/models`);
            return response.data.data;
        } catch (e) {
            console.error('[OpenRouterEngine] Model Fetch Error:', e.message);
            return [];
        }
    }

    /**
     * INTELLIGENT MODEL SELECTION LOGIC (AI Judge)
     * "Priority Zero" - No hardcoded bias. The AI Judge decides based on specs.
     */
    async selectBestModels(freeModels) {
        if (!freeModels || freeModels.length === 0) return null;

        try {
            // 1. Prepare Candidate List (Lightweight JSON)
            const candidates = freeModels.map(m => ({
                id: m.id,
                name: m.name,
                context: m.context_length,
                modality: m.architecture?.modality || 'text',
                description: m.description
            }));

            // 2. Get Gemini Key for Judgment
            const keyData = await keyService.getSmartKey('google', 'gemini-2.5-flash');
            
            if (keyData && keyData.key) {
                const prompt = `
You are an unbiased AI Judge. Review this list of FREE AI Models and select the absolute winners based on objective capability.
NO BRAND BIAS. "Priority Level Zero" comparison - purely specs and known capabilities.

Candidates: ${JSON.stringify(candidates)}

CRITERIA:
1. text: Best overall for Bengali conversation, Logical Reasoning, and Human-like output. (High Context + Reasoning capability is a plus).
2. voice: Fastest inference model suitable for real-time voice chat (Low latency is key).
3. image: Best Vision/Multimodal model.

Return ONLY valid JSON:
{
  "text": "model_id",
  "voice": "model_id",
  "image": "model_id"
}`;

                const openai = new OpenAI({ 
                    apiKey: keyData.key, 
                    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' 
                });

                const completion = await openai.chat.completions.create({
                    model: 'gemini-2.5-flash',
                    messages: [{ role: 'user', content: prompt }],
                    response_format: { type: "json_object" }
                });

                const result = JSON.parse(completion.choices[0].message.content);
                
                if (result.text && result.voice && result.image) {
                    return result;
                }
            }
        } catch (e) {
            console.warn('[OpenRouterEngine] AI Judge Failed, falling back to algorithmic sort:', e.message);
        }

        // FALLBACK: Algorithmic Sort (if AI Judge fails)
        // Sort by Context Length as a proxy for "Power", but prioritize General Purpose over Coder
        const sorted = [...freeModels].sort((a, b) => {
            const contextA = a.context_length || 0;
            const contextB = b.context_length || 0;
            return contextB - contextA;
        });

        // Smart Text Selection: Prefer 'instruct'/'chat' and exclude 'coder' if possible
        const textCandidates = sorted.filter(m => !m.id.includes('vision') && !m.id.includes('coder'));
        
        // Prioritize Llama 3 / Mistral, and specifically prefer larger models (70b, 80b, etc.)
        const bestText = textCandidates.find(m => 
            (m.id.includes('llama-3') || m.id.includes('mistral')) && 
            (m.id.includes('70b') || m.id.includes('large'))
        ) || textCandidates.find(m => m.id.includes('llama-3') || m.id.includes('mistral')) || textCandidates[0] || sorted[0];

        const bestVoice = sorted.find(m => m.id.includes('flash') || m.id.includes('instant')) || sorted[0]; // Heuristic for speed
        const bestImage = sorted.find(m => m.architecture?.modality?.includes('image') || m.id.includes('vision')) || sorted[0];

        return {
            text: bestText.id,
            voice: bestVoice.id,
            image: bestImage.id
        };
    }

    /**
     * Validate Keys & Check Limits via OpenRouter API
     */
    async updateKeyStatus() {
        // Fetch keys from DB
        const { data: keys } = await dbService.supabase
            .from('openrouter_engine_keys')
            .select('*');

        if (!keys) return [];

        const validKeys = [];

        for (const key of keys) {
            try {
                // Check Key Limits
                const response = await axios.get(`${OPENROUTER_API_BASE}/auth/key`, {
                    headers: { 'Authorization': `Bearer ${key.api_key}` }
                });
                
                const data = response.data.data;
                const limit = data.limit || 0; // null means unlimited usually, but for free keys it might be strictly 0 credit
                const usage = data.usage || 0;

                // Update DB
                await dbService.supabase
                    .from('openrouter_engine_keys')
                    .update({
                        usage_limit: limit,
                        usage_used: usage,
                        is_active: true,
                        last_checked_at: new Date()
                    })
                    .eq('id', key.id);

                validKeys.push(key.api_key);

            } catch (e) {
                console.warn(`[OpenRouterEngine] Invalid Key (${key.label}):`, e.message);
                // Mark inactive
                await dbService.supabase
                    .from('openrouter_engine_keys')
                    .update({ is_active: false })
                    .eq('id', key.id);
            }
        }
        return validKeys;
    }

    async saveConfigToDB(config) {
        if (!config) return;
        
        // Upsert Config
        await dbService.supabase
            .from('openrouter_engine_config')
            .upsert({
                config_type: 'best_models',
                text_model: config.text,
                voice_model: config.voice,
                image_model: config.image,
                updated_at: new Date()
            }, { onConflict: 'config_type' });
    }

    /**
     * PUBLIC API: Process Request
     */
    async processRequest({ message, history, images = [], systemPrompt = '' }) {
        // Use Cached Config
        if (!this.configCache) {
            await this.performUpdateCycle();
        }

        const { text, image, keys } = this.configCache;
        
        if (!keys || keys.length === 0) {
            throw new Error("No Active OpenRouter Keys Available.");
        }

        // Rotate Keys
        const apiKey = keys[Math.floor(Math.random() * keys.length)];
        
        const client = new OpenAI({
            apiKey: apiKey,
            baseURL: OPENROUTER_API_BASE,
            defaultHeaders: {
                "HTTP-Referer": "https://freeapi.online",
                "X-Title": "FreeApi"
            }
        });

        // Determine Model
        let model = text;
        if (images.length > 0) model = image;

        // Construct Messages
        const msgs = [
            { role: 'system', content: systemPrompt },
            ...history
        ];

        // Add User Message
        const userContent = [{ type: 'text', text: message }];
        images.forEach(img => {
            userContent.push({ type: 'image_url', image_url: { url: img } });
        });
        msgs.push({ role: 'user', content: userContent });

        // API Call
        try {
            const completion = await client.chat.completions.create({
                model: model,
                messages: msgs,
                // response_format: { type: "json_object" } // REMOVED: User wants plain text
            });
            
            let content = completion.choices[0].message.content;
            
            // CLEANUP: If model returns JSON string despite request, parse it
            if (content.trim().startsWith('{') && content.trim().endsWith('}')) {
                try {
                    const parsed = JSON.parse(content);
                    // Extract message or content field if exists
                    if (parsed.message) content = parsed.message;
                    else if (parsed.content) content = parsed.content;
                    else if (parsed.response) content = parsed.response;
                    // Else keep original JSON string if no clear text field
                } catch (e) {
                    // Not valid JSON, ignore
                }
            }

            return content;
        } catch (error) {
            // Report Invalid Key
            if (error.status === 401 || error.message.includes('API key')) {
                console.warn(`[OpenRouterEngine] Invalid API Key detected. Marking as inactive.`);
                await dbService.supabase
                    .from('openrouter_engine_keys')
                    .update({ is_active: false })
                    .eq('api_key', apiKey);
            }

            // Report Rate Limit to KeyService
            if (error.status === 429) {
                console.warn(`[OpenRouterEngine] Rate Limit Hit for ${model}. Reporting...`);
                // Using new strict 2m -> 24h lock mechanism
                keyService.report429(model); 
            }

            // Fallback Logic?
            console.error("[OpenRouterEngine] Request Failed:", error.message);
            throw error;
        }
    }
}

module.exports = new OpenRouterEngineService();