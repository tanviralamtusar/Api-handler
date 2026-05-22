const keyService = require('./keyService');
const dbService = require('./dbService'); // Added for Product Search Tool
const commandApiService = require('./commandApiService'); // Command API Table Strategy
const axios = require('axios');
const OpenAI = require('openai');
const FormData = require('form-data');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- DYNAMIC FREE MODEL OPTIMIZER (OpenRouter) ---
// User Request: Dynamically fetch best free models using Gemini (Cheap Engine) to analyze the list.
let bestFreeModels = {
    text: 'meta-llama/llama-3.1-8b-instruct:free', // Default fallback
    vision: 'qwen/qwen-2.5-vl-7b-instruct:free', 
    voice: 'meta-llama/llama-3.1-8b-instruct:free' 
};

async function updateBestFreeModels() {
    try {
        console.log('[AI Optimizer] Fetching latest free models from OpenRouter...');
        const response = await axios.get('https://openrouter.ai/api/v1/models');
        const models = response.data.data;
        
        if (!models || !Array.isArray(models)) throw new Error("Invalid response format");

        // Filter for Strictly Free Models (Prompt & Completion = 0)
        // User Update: EXCLUDE Gemini 2.0 models from Cheap Engine
        const freeModels = models.filter(m => 
            m.pricing && 
            (m.pricing.prompt === "0" || m.pricing.prompt === 0) && 
            (m.pricing.completion === "0" || m.pricing.completion === 0) &&
            !m.id.includes('gemini-2.0') 
        );

        if (freeModels.length === 0) {
            console.warn('[AI Optimizer] No free models found. Keeping defaults.');
            return;
        }

        // Limit to Top 50 to capture new high-potential models like stepfun/upstage
        freeModels.sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
        // User Update: Analyze ALL free models, not just top 50.
        const candidates = freeModels.map(m => ({
            id: m.id,
            name: m.name,
            context: m.context_length,
            modality: m.architecture?.modality || 'text',
            description: m.description // Help AI understand model capabilities
        }));

        // --- GEMINI SELECTION LOGIC (Cheap Engine) ---
        // We use Gemini 2.5 Flash to pick the best models from the list
        try {
            console.log(`[AI Optimizer] Asking Gemini to select best models from ${candidates.length} candidates...`);
            // Update: Use 'gemini-2.5-flash' key as requested by user
            const keyData = await keyService.getSmartKey('google', 'gemini-2.5-flash');
            
            if (keyData && keyData.key) {
                const prompt = `
You are an expert AI Engineer. Analyze this COMPLETE list of FREE OpenRouter models and pick the ABSOLUTE BEST ones for a production chatbot.

Candidates: ${JSON.stringify(candidates)}

Requirements:
1. TEXT: Select the BEST General Chat Model. 
   - Look for high intelligence, reasoning, and instruction following.
   - Do NOT just pick 'Google' or 'Meta' brands. Look for 'Pro', 'Max', 'Ultra' or 'Reasoning' variants even from lesser known providers like 'Upstage', 'Stepfun', 'Mistral', 'Qwen' etc.
   - High context is good, but smartness is priority.
2. VISION: Best Multimodal Model. Must support images (Gemini, Qwen VL, Llama 3.2 Vision).
3. VOICE: Fastest model for text generation (Flash/Lite/Instant variants).

Return ONLY valid JSON:
{
  "text": "model_id",
  "vision": "model_id",
  "voice": "model_id"
}`;
                const openai = new OpenAI({ 
                    apiKey: keyData.key, 
                    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' 
                });

                const completion = await openai.chat.completions.create({
                    // Use Gemini 2.5 Flash for the request
                    model: 'gemini-2.5-flash', 
                    messages: [{ role: 'user', content: prompt }],
                    response_format: { type: "json_object" }
                });

                const result = JSON.parse(completion.choices[0].message.content);
                
                if (result.text && result.vision && result.voice) {
                    bestFreeModels = result;
                    console.log('[AI Optimizer] Gemini Selected Models:', bestFreeModels);
                } else {
                    throw new Error("Invalid JSON structure from Gemini");
                }
            } else {
                throw new Error("No Gemini keys available for optimizer.");
            }
        } catch (geminiError) {
            console.warn('[AI Optimizer] Gemini Selection Failed:', geminiError.message);
            console.log('[AI Optimizer] Falling back to rule-based selection.');
            
            // Fallback: Rule-based (Previous Logic)
             const reliableProviders = /gemini|llama-3|mistral|qwen/i;
             let bestText = freeModels.find(m => reliableProviders.test(m.id) && !m.id.includes('vision')) || freeModels[0];
             // Prioritize Gemini 2.5 equivalent for Vision
             let bestVision = freeModels.find(m => m.id.includes('gemini-2.5') || m.id.includes('qwen-2.5')) || freeModels[0];
             let bestVoice = freeModels.find(m => m.id.includes('flash') && m.id.includes('gemini')) || bestText;

             bestFreeModels = { text: bestText.id, vision: bestVision.id, voice: bestVoice.id };
             console.log('[AI Optimizer] Rule-based Selected Models:', bestFreeModels);
        }

    } catch (e) {
        console.warn('[AI Optimizer] Failed to update free models:', e.message);
    }
}

// Schedule: Run every 2 hours
setInterval(updateBestFreeModels, 2 * 60 * 60 * 1000);
// Run immediately on startup
updateBestFreeModels();
// -----------------------------------------------------

function logDebug(msg) {
    try {
        const logDir = path.join(__dirname, '../../logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        
        fs.appendFileSync(path.join(logDir, 'ai.log'), new Date().toISOString() + ' ' + msg + '\n');
    } catch (e) {
        console.error("Failed to write debug log:", e);
    }
}

// --- IN-MEMORY CACHE FOR ZERO COST ---
// Map<hash, { reply: string, timestamp: number }>
const responseCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 Hour Cache
const CACHE_SIZE_LIMIT = 500; // Prevent memory leaks

function getCacheKey(pageId, message, senderName) {
    // Normalize message: lowercase, remove special chars
    const normalized = message.toLowerCase().replace(/[^\w\s\u0980-\u09FF]/g, '').trim();
    // LEAK FIX: Include senderName in cache key to prevent cross-user data leaks
    return `${pageId}:${senderName}:${normalized}`;
}
// -------------------------------------

// --- HELPER: Fetch OG Image from Link ---
async function fetchOgImage(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                // Add Security Headers to mimic browser
                'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            },
            timeout: 3000 // 3s Timeout to avoid blocking response
        });

        const html = response.data;
        if (typeof html !== 'string') return null;

        // Priority 1: og:image
        let match = html.match(/<meta property=["']og:image["'] content=["']([^"']+)["']/i);
        if (match) return match[1];

        // Priority 2: twitter:image
        match = html.match(/<meta name=["']twitter:image["'] content=["']([^"']+)["']/i);
        if (match) return match[1];
        
        // Priority 3: link rel="image_src"
        match = html.match(/<link rel=["']image_src["'] href=["']([^"']+)["']/i);
        if (match) return match[1];

        return null;
    } catch (error) {
        // Silent fail is fine, we just won't have an image
        return null;
    }
}

// Wrapper for Controller Consistency
async function generateResponse({ pageId, userId, userMessage, history, imageUrls, audioUrls, config, platform, extraTokenUsage = 0, senderName: explicitSenderName = null, ownerName = null }) {
    // 1. Fetch Prompts if needed
    let pagePrompts = config;
    
    // For Messenger, config might not have prompts if passed from minimal object
    // But for WhatsApp, we usually pass full config.
    // Let's ensure we have prompts.
    if (platform === 'messenger' || !pagePrompts.text_prompt) {
         const dbService = require('./dbService');
         try {
            pagePrompts = await dbService.getPagePrompts(pageId);
         } catch (e) {
            console.warn(`[AI] Failed to fetch prompts for ${pageId}:`, e.message);
         }
    }

    // 2. Resolve Sender Name
    let senderName = explicitSenderName || userId;

    // 3. Call Core Logic
    return generateReply(
        userMessage,
        config,
        pagePrompts,
        history,
        senderName,
        ownerName, // Pass ownerName
        null, // senderGender (optional)
        imageUrls,
        audioUrls,
        extraTokenUsage // Pass initial usage (e.g. from Vision API in Controller)
    );
}

function estimateTokenUsage(messages, replyText, baseUsage) {
    if (baseUsage && baseUsage > 0) return baseUsage;
    const inputChars = (messages || []).reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0);
    const outputChars = replyText ? replyText.length : 0;
    return Math.ceil((inputChars + outputChars) / 4);
}

// Helper to clean and extract JSON from AI response (handles <think> blocks and markdown)
function extractJsonFromAiResponse(rawContent) {
    try {
        // 1. Remove <think>...</think> blocks (DeepSeek/Gemini reasoning)
        let cleanContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        // 2. Remove markdown code blocks (```json ... ```)
        cleanContent = cleanContent.replace(/```json/gi, '').replace(/```/g, '').trim();

        // 3. Find the first '{' and last '}' to isolate JSON object
        const firstOpen = cleanContent.indexOf('{');
        const lastClose = cleanContent.lastIndexOf('}');

        if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
            cleanContent = cleanContent.substring(firstOpen, lastClose + 1);
        }

        return JSON.parse(cleanContent);
    } catch (e) {
        console.warn("[AI] JSON Extraction Failed, attempting raw parse...");
        return JSON.parse(rawContent); // Fallback to original
    }
}

function extractReplyFromText(text) {
    if (!text) return "";
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            if (parsed.reply && typeof parsed.reply === 'string' && parsed.reply.trim() !== '') {
                return parsed.reply;
            }
            if (parsed.text && typeof parsed.text === 'string' && parsed.text.trim() !== '') {
                return parsed.text;
            }
            if (parsed.message && typeof parsed.message === 'string' && parsed.message.trim() !== '') {
                return parsed.message;
            }

            const keys = Object.keys(parsed);
            const hasToolShape =
                (parsed.tool && typeof parsed.tool === 'string') ||
                (parsed.tools && Array.isArray(parsed.tools)) ||
                (parsed.function && typeof parsed.function === 'string') ||
                keys.includes('query');

            if (hasToolShape) {
                return "Sorry, something went wrong while processing your request.";
            }
        }
    } catch (e) {}

    const match = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (match && match[1]) {
        try {
            return JSON.parse(`"${match[1]}"`);
        } catch (e) {
            return match[1];
        }
    }

    return text;
}

// Step 2: Business Logic / AI Brain
async function generateReply(userMessage, pageConfig, pagePrompts, history = [], senderName = 'Customer', ownerName = 'Automation Hub BD', senderGender = null, imageUrls = [], audioUrls = [], extraTokenUsage = 0) {
    
    // --- MULTI-TENANCY SAFETY CHECK ---
    const pageId = pageConfig.page_id;
    
    // Check Cheap Engine Flag (Default to TRUE if undefined/null, for zero-cost)
    const useCheapEngine = pageConfig.cheap_engine !== false;

    const promptPreview = pagePrompts?.text_prompt ? pagePrompts.text_prompt.substring(0, 30) : "DEFAULT";
    console.log(`[AI Isolation Check] Generating for Page ID: ${pageId} | CheapEngine: ${useCheapEngine} | Sender: ${senderName} | Prompt: "${promptPreview}..."`);
    // ----------------------------------

    let totalTokenUsage = extraTokenUsage || 0;
    let cleanUserMessage = userMessage;

    // 0. Pre-process Media (Images/Audio) -> Text
    
    // Extract images from User Message if any
    const imageMatch = userMessage.match(/\[User sent images: (.*?)\]/);
    if (imageMatch && imageMatch[1]) {
         const extracted = imageMatch[1].split(',').map(url => url.trim());
         imageUrls = [...imageUrls, ...extracted];
         cleanUserMessage = userMessage.replace(imageMatch[0], '').trim(); 
    }

    // --- PRODUCT SEARCH INTEGRATION (Context Injection) ---
    let productContext = "";
    if (pageConfig.user_id) {
        try {
             // Search for relevant products based on user message
            const products = await dbService.searchProducts(pageConfig.user_id, cleanUserMessage, pageConfig.page_id);
            
            if (products && products.length > 0) {
                 productContext = "\n[Available Products in Store]\n";
                 products.forEach((p, i) => {
                     // Format variants cleanly
                     let variantInfo = "";
                     if (Array.isArray(p.variants) && p.variants.length > 0) {
                        variantInfo = " | Variants: " + p.variants.map(v => 
                            `${v.name} (${v.price} ${v.currency || 'BDT'})`
                        ).join(', ');
                     }
                     
                     // Row Format (Compact for AI)
                     const priceDisplay = p.price ? `${p.price} ${p.currency || 'BDT'}` : 'N/A';
                     const stockDisplay = p.stock !== undefined ? p.stock : 'N/A';
                     const descDisplay = p.description ? p.description.replace(/\n/g, ' ').substring(0, 200) : 'N/A';
                     const imgDisplay = (p.image_url && p.image_url.startsWith('http')) ? p.image_url : 'N/A';
                     
                     productContext += `Item ${i+1}: ${p.name} | Price: ${priceDisplay} | Stock: ${stockDisplay} | Image URL: ${imgDisplay} | Desc: ${descDisplay}${variantInfo}\n`;
                 });
                 productContext += "[End of Products]\n";
                 console.log(`[AI] Injected ${products.length} products into context.`);
             }
        } catch (err) {
            console.warn("[AI] Product search failed:", err.message);
        }
    }
    // ----------------------------------------------------

    let mediaContext = "";
    
    if (imageUrls && imageUrls.length > 0) {
        console.log(`[AI] Processing ${imageUrls.length} images...`);
        // Use per-page vision prompt if available
        const visionPrompt = (pagePrompts && (pagePrompts.image_prompt || pagePrompts.vision_prompt)) 
            ? (pagePrompts.image_prompt || pagePrompts.vision_prompt) 
            : "Describe this image in detail.";
        const imageResults = await Promise.all(imageUrls.map(url => processImageWithVision(url, pageConfig, { prompt: visionPrompt })));
        
        // Extract text and usage
        const imageDescriptions = imageResults.map(res => {
            if (typeof res === 'object') {
                totalTokenUsage += (res.usage || 0);
                return res.text;
            }
            return res; // Fallback string
        });

        mediaContext += "\n[System Note: User sent images. Analysis below:]\n" + imageDescriptions.map((desc, i) => `Image ${i+1}: ${desc}`).join("\n");
    }

    if (audioUrls && audioUrls.length > 0) {
        console.log(`[AI] Processing ${audioUrls.length} audio files...`);
        const audioResults = await Promise.all(audioUrls.map(async url => {
            const res = await transcribeAudio(url, pageConfig);
            if (typeof res === 'object') {
                totalTokenUsage += (res.usage || 0);
                return res.text;
            }
            return res;
        }));
        mediaContext += "\n[System Note: User sent audio messages:]\n" + audioResults.join("\n");
    }

    if (mediaContext) {
        cleanUserMessage += "\n" + mediaContext;
        console.log(`[AI] Added media context to user message. Total Tokens so far: ${totalTokenUsage}`);
    }

    // 1. Prepare Configuration
    let dynamicProvider = 'openrouter'; 
    let dynamicModel = 'arcee-ai/trinity-large-preview'; // Verified Free Model
    let fallbackModel = 'meta-llama/llama-3.1-8b-instruct:free';

    if (useCheapEngine) {
        try {
            const commandConfig = await commandApiService.getCommandConfig();
            if (commandConfig) {
                dynamicProvider = commandConfig.provider || dynamicProvider;
                dynamicModel = commandConfig.chatmodel || dynamicModel;
                fallbackModel = commandConfig.fallback_chatmodel || fallbackModel;
            }
        } catch (err) {
            console.warn("[AI] Failed to fetch Command API config, using strong defaults:", err.message);
        }
    }

    // PRIORITIZE PAGE CONFIG (User's specific choice overrides everything)
    let userModel = (pageConfig.chat_model && pageConfig.chat_model !== 'default') ? pageConfig.chat_model.trim() : null;
    
    // AUTO MODEL SELECTION (User Request: "openrouter/auto")
    if (userModel === 'openrouter/auto') {
        console.log(`[AI] Auto-Model Selected. Using best free model: ${bestFreeModels.text}`);
        userModel = bestFreeModels.text;
    }

    const userProvider = pageConfig.ai || pageConfig.operator; 

    let defaultProvider = userProvider || (useCheapEngine ? dynamicProvider : 'gemini');
    let defaultModel = userModel;

    // IF User did NOT specify a model (null), pick a smart default based on the Provider
    if (!defaultModel) {
        if (defaultProvider === 'gemini') {
            defaultModel = 'gemini-2.5-flash'; 
        } else if (defaultProvider === 'openrouter') {
            defaultModel = useCheapEngine ? dynamicModel : 'arcee-ai/trinity-large-preview';
        } else if (defaultProvider === 'groq') {
            defaultModel = 'llama-3.3-70b-versatile';
        } else if (defaultProvider === 'freeapi') {
            defaultModel = 'freeapi-pro';
        } else {
            defaultModel = useCheapEngine ? dynamicModel : 'gemini-2.5-flash'; 
        }
    }

    // Force free model for OpenRouter if using default
    if (!userModel && defaultProvider === 'openrouter' && defaultModel.includes('gemini') && !defaultModel.includes(':free')) {
        defaultModel = 'arcee-ai/trinity-large-preview';
    }

    console.log(`[AI] Final Engine Config: ${defaultProvider} / ${defaultModel}`);

    // --- MODEL NAME NORMALIZATION & ALIASES ---
    const MODEL_ALIASES = {
        'gemini-2.0-flash': 'gemini-2.5-flash', // Force 2.0 requests to use 2.5
        'gemini-1.5-flash': 'gemini-2.5-flash', // Force 1.5 requests to use 2.5
        'gemini-pro': 'gemini-2.5-flash',
        'gemini2.5-flash': 'gemini-2.5-flash', // Handle User Typo
        'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite', // Ensure self-mapping
        'groq-fast': 'llama-3.3-70b-versatile', 
        'groq-speed': 'llama-3.1-8b-instant', 
        'grok-4.1-fast': 'llama-3.3-70b-versatile',
        'freeapi-pro': 'gemini-2.5-flash',
        'freeapi-flash': 'gemini-2.5-flash',
        'freeapi-lite': 'gemini-2.5-flash-lite',
    };

    if (MODEL_ALIASES[defaultModel]) {
        defaultModel = MODEL_ALIASES[defaultModel];
    }

    // Dynamic Best Model Logic (Cache every 2 hours)
    // User Request: gemini 2.5 flash > 2.5 flash lite > openrouter free
    if (!userModel) {
        // If user didn't specify, we use our smart defaults
        // 1. Try Gemini 2.0 Flash (aka 2.5 Flash alias)
        // 2. Try Gemini 2.0 Flash Lite
        // 3. Fallback to OpenRouter Free
        
        // This is handled in Phase 2 loop below if we set the sequence right.
        // We set 'defaultModel' to the Primary Choice.
        defaultModel = 'gemini-2.5-flash';
        dynamicModel = 'gemini-2.5-flash-lite';
        fallbackModel = bestFreeModels.text || 'meta-llama/llama-3.1-8b-instruct:free'; // Dynamic Fallback
    }
    // -------------------------------------------------
    
    // --- MEDIA HANDLING COMPLETED ABOVE ---
    // (Consolidated into Pre-process Media step to ensure correct token tracking)
    // ----------------------------------------

    // --- PROMPT & MESSAGE CONSTRUCTION ---
    let messages = [];
    let responseFormat = { type: "json_object" };

    if (pageConfig.is_external_api) {
        // --- EXTERNAL API MODE (Minimal & White Label) ---
        const whiteLabelInstruction = "You are FreeApi, a helpful AI assistant. You are NOT Google Gemini, OpenAI, or any other provider. You are a proprietary AI.";
        
        const userSystemPrompt = pagePrompts?.text_prompt || "";
        const finalSystemPrompt = `${whiteLabelInstruction}\n\n${userSystemPrompt}`.trim();

        messages = [
            { role: 'system', content: finalSystemPrompt },
            ...history,
            { role: 'user', content: cleanUserMessage }
        ];
        
        // Disable strict JSON enforcement for external API (allow natural text)
        responseFormat = undefined; 
        console.log(`[AI] External API Mode: Skipping n8n System Prompt.`);

    } else {
        // --- INTERNAL BOT MODE (n8n/Messenger) ---
        let basePrompt = pagePrompts?.text_prompt || "You are a helpful assistant.";
        
        let personaInstruction = "";
        // User Request: Strong Prompt Engineering for OpenRouter Stability & Bengali
        if (defaultProvider === 'openrouter' || useCheapEngine) {
            personaInstruction = `
### SYSTEM OVERRIDE: STABILITY PROTOCOL ###
You are a sophisticated AI Assistant optimized for CUSTOMER SUPPORT.
Your primary directive is to provide STABLE, ACCURATE, and HELPFUL responses.

[MANDATORY RULES]
1. **ANSWER STABILITY**:
   - Analyze the 'Ctx' (Context) carefully.
   - If the user asks something outside the 'Ctx', politely decline.
   - Do NOT hallucinate or invent features.
   - IGNORE minor typos in user input; infer intent.
2. **FORMATTING**:
   - Keep replies SHORT and TO THE POINT.
   - No preambles like "Here is your response". Just the answer.
`;
        } else {
            personaInstruction = `Persona: Gemini 2.5 Flash. Fast, accurate, expert. Strict JSON. No fluff.`;
        }

        const n8nSystemPrompt = `Role: Bot ${pageConfig.bot_name || 'Assistant'} representing ${ownerName}.
Ctx: ${basePrompt}
${productContext}
${personaInstruction}
Rules:
1. IMAGE HANDLING: If you see [System Note] "User sent >10 images" or "video", rely on Ad Context or ask user.
2. AD CONTEXT: If '[System Note: User clicked on an AD...]' exists, use it to identify the product.
3. STRICT DOMAIN CONTROL: Answer ONLY about business/products in 'Ctx'. Ignore unrelated topics.
4. ADDRESSING: You are speaking to '${senderName}'.
5. SENDING IMAGES (MANDATORY): If the context contains 'Image URL: https://' text or any 'image_url' field for the product you are discussing (either in [Available Products in Store] or in Search Results JSON), you MUST include each of those URLs in the 'images' array of your JSON response. Format: { "url": "URL", "title": "Product Name" }. Do NOT skip this.
6. PRODUCT SEARCH TOOL (CRITICAL):
   - You have access to a Real-Time Product Database.
   - If user asks "Do you have X?", "Is X available?", "Price of X?", or sends an image and asks "Do you have this?", you MUST use the tool.
   - Return STRICT JSON: { "tool": "search_products", "query": "keyword" }
   - Example: User: "Do you have red shirt?" -> JSON: { "tool": "search_products", "query": "red shirt" }
   - Do NOT say "I will check". Just return the JSON.
7. DYNAMIC ACTIONS:
   - If user requests ADMIN/SUPPORT/CALL or specific action defined in 'Ctx', append "[ADD_LABEL: label_name]" to your reply.
   - Example: "I will connect you to admin. [ADD_LABEL: adminhandle]"
   - Supported Labels: 
     - 'adminhandle': User wants to talk to admin explicitly (human request).
     - 'ordertrack': Order is CONFIRMED (Automatic).
8. MULTI-VARIANT PRODUCT RESPONSE:
   - If product search returns multiple similar products (e.g., Mango Red, Mango White), list all variants clearly.
   - Ask the user which variant they prefer.
9. ORDER PROCESS:
   - If user wants to place an order, collect these details: Product Name, Quantity, Full Address, Price (if applicable).
   - Ask for missing details if incomplete.
   - Once ALL details are provided, confirm the order.
   - APPEND this EXACT tag to your reply: [SAVE_ORDER: {"product_name":"...","product_quantity":"...","location":"...","price":"..."}]
   - ALSO APPEND: [ADD_LABEL: ordertrack]
   - NOTE: The 'number' will be automatically captured from the sender, so just capture the other details.
10. Output RAW JSON:
{
  "reply": "Response text"|null,
  "images": [ { "url": "https://...", "title": "Product Name" } ]|null,
  "sentiment": "pos|neu|neg",
  "dm_message": "msg"|null,
  "bad_words": "words"|null,
  "order_details": { "product_name", "quantity", "address", "phone", "price" }|null
}`;

        const systemMessage = { role: 'system', content: n8nSystemPrompt };
    
        messages = [
            systemMessage,
            ...history,
            { role: 'user', content: cleanUserMessage }
        ];
    }

    // --- UNIFIED AI REQUEST LOGIC ---
    const isOurOwnProvider = defaultProvider === 'freeapi' || defaultProvider === 'system';

    // SPECIAL PATH: Use Own FreeApi API when selected
    if (!useCheapEngine && defaultProvider === 'freeapi' && pageConfig.api_key) {
        try {
            const axios = require('axios');
            const base = process.env.FREEAPI_API_BASE_URL || `http://localhost:${process.env.PORT || 3001}/api/external/v1`;
            const modelToUse = (pageConfig.chatmodel || 'freeapi-pro');
            const payload = {
                model: modelToUse,
                messages: messages,
            };
            const headers = {
                'Authorization': `Bearer ${pageConfig.api_key}`,
                'Content-Type': 'application/json'
            };
            console.log(`[AI] FreeApi Own API: Calling ${base}/chat/completions with model=${modelToUse}`);
            const resp = await axios.post(`${base}/chat/completions`, payload, { headers, timeout: 25000 });
            const data = resp.data;
            const aiText = data?.choices?.[0]?.message?.content || null;
            const tokenUsage = data?.usage?.total_tokens || 0;
            if (aiText) {
                return { reply: aiText, sentiment: 'neutral', token_usage: tokenUsage + totalTokenUsage, model: modelToUse };
            }
        } catch (error) {
            console.warn(`[AI] FreeApi Own API Error:`, error.message);
            return { 
                reply: null, 
                error: `FreeApi API Error: ${error.message}. Check your API key/model.`,
                token_usage: 0,
                model: pageConfig.chatmodel || 'freeapi-pro'
            };
        }
    }

    // PHASE 1: Try User-Provided Keys
    let userKeyAttempted = false;
    if (!useCheapEngine && !isOurOwnProvider && pageConfig.api_key && pageConfig.api_key !== 'MANAGED_SECRET_KEY') {
        userKeyAttempted = true;
        const userKeys = pageConfig.api_key.split(',').map(k => k.trim()).filter(k => k);
        // Shuffle keys
        for (let i = userKeys.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [userKeys[i], userKeys[j]] = [userKeys[j], userKeys[i]];
        }

        for (const currentKey of userKeys) {
            let currentProvider = defaultProvider;
            if (currentKey.startsWith('sk-or-v1')) currentProvider = 'openrouter';
            else if (currentKey.startsWith('AIzaSy')) currentProvider = 'google';
            else if (currentKey.startsWith('gsk_')) currentProvider = 'groq';
            else if (currentKey.startsWith('xai-')) currentProvider = 'xai';

            let baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
            if (currentProvider.includes('openrouter')) baseURL = 'https://openrouter.ai/api/v1';
            else if (currentProvider.includes('openai')) baseURL = 'https://api.openai.com/v1';
            else if (currentProvider.includes('groq')) baseURL = 'https://api.groq.com/openai/v1';
            else if (currentProvider.includes('xai')) baseURL = 'https://api.x.ai/v1';

            try {
                const openai = new OpenAI({ 
                    apiKey: currentKey, 
                    baseURL: baseURL,
                    timeout: 25000 // 25s Timeout for User Keys
                });
                // Normalize Model Name for User Keys
                // User Requirement: Use EXACTLY what user typed. No mapping.
                let modelToUse = pageConfig.chatmodel || defaultModel;

                console.log(`[AI] Phase 1: Calling User Key (${currentProvider}/${modelToUse})...`);

                const completion = await openai.chat.completions.create({
                    model: modelToUse,
                    messages: messages,
                    response_format: responseFormat
                });

                if (completion.choices && completion.choices.length > 0) {
                    const rawContent = completion.choices[0].message.content || '';
                    let tokenUsage = completion.usage ? completion.usage.total_tokens : 0;
                    tokenUsage = estimateTokenUsage(messages, rawContent, tokenUsage);
                    try {
                        keyService.recordKeyUsage(currentKey, tokenUsage);
                    } catch (e) {}
                    
                    try {
                        const parsed = extractJsonFromAiResponse(rawContent);
                        
                        // --- TOOL HANDLING (Product Search) ---
                        if (parsed.tool === 'search_products' && parsed.query) {
                            console.log(`[AI] Tool Call (Phase 1): Searching products for "${parsed.query}"...`);
                            // Fix: Pass pageId to ensure visibility rules are respected
                            const products = await dbService.searchProducts(pageConfig.user_id, parsed.query, pageConfig.page_id);
                            
                            // Add context and retry
                            messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
                            messages.push({ role: 'system', content: `[System] Search Results: ${JSON.stringify(products)}. Now answer the user in Bengali. IMPORTANT: If a product has an 'image_url', you MUST include it in the 'images' array of your JSON response.` });
                            
                            console.log(`[AI] Tool Result found. Re-generating answer with User Key...`);
                            const completion2 = await openai.chat.completions.create({
                                model: modelToUse,
                                messages: messages,
                                response_format: { type: "json_object" }
                            });
                            
                            const rawContent2 = completion2.choices[0].message.content || '';
                            let tokenUsage2 = completion2.usage ? completion2.usage.total_tokens : 0;
                            tokenUsage2 = estimateTokenUsage(messages, rawContent2, tokenUsage2);
                            try { keyService.recordKeyUsage(currentKey, tokenUsage2); } catch(e){}
                            
                            const parsed2 = extractJsonFromAiResponse(rawContent2);
                            if (!parsed2.reply) parsed2.reply = parsed2.response || parsed2.text;
                            return { ...parsed2, token_usage: tokenUsage + tokenUsage2 + totalTokenUsage, model: modelToUse };
                        }
                        // -------------------------------------

                        if (!parsed.reply) parsed.reply = parsed.response || parsed.text;
                        return { ...parsed, token_usage: tokenUsage + totalTokenUsage, model: modelToUse };
                    } catch (e) {
                        let cleanText = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                        cleanText = extractReplyFromText(cleanText);
                        return { reply: cleanText, sentiment: 'neutral', model: modelToUse, token_usage: tokenUsage + totalTokenUsage };
                    }
                }
            } catch (error) {
                console.warn(`[AI] Phase 1 Key Failed:`, error.message);
                
                // STRICT OWN API LOCK: If we are here, it means the User provided their own API key.
                // If it fails (invalid key, quota exceeded, etc.), we MUST NOT fallback to our Cloud API.
                console.error(`[AI] Strict Own API Failed. Blocking Cloud API fallback for security & isolation.`);
                return { 
                    reply: null, // Returning null ensures the controller knows the request failed strictly.
                    error: `AI Provider Error: ${error.message}. Please check your API settings in the dashboard.`,
                    token_usage: 0,
                    model: modelToUse
                };
            }
        }
    }

    // HELPER: Error Handler for Rate Limits
    const handleAiError = (error, apiKey, modelName) => {
        const status = error.status || (error.response ? error.response.status : null);
        if (status === 429 || error.message.includes('429') || error.message.includes('quota') || error.message.includes('Too Many Requests')) {
            if (error.message.toLowerCase().includes('quota')) {
                keyService.markKeyAsQuotaExceeded(apiKey);
            } else {
                keyService.markKeyAsDead(apiKey, 60 * 1000, `rate_limit_${modelName}`);
            }
        } else if (status === 401 || status === 403) {
            keyService.markKeyAsDead(apiKey, 24 * 60 * 60 * 1000, 'auth_error');
        } else if (status >= 500) {
            keyService.markKeyAsDead(apiKey, 60 * 1000, 'server_error');
        }
    };

    // Phase 2: Key-Centric Swarm (Google Flash Only)
    if (userKeyAttempted) {
        console.warn(`[AI] Phase 1 was attempted but failed or was invalid. Strict Isolation Active: Blocking Cloud API fallback.`);
        return { 
            reply: null, 
            error: "Your API Provider settings are incorrect or the key has expired. Please check your dashboard.",
            token_usage: 0,
            model: defaultModel
        };
    }

    console.log(`[AI] Phase 2: Key-Centric Swarm (Gemini 2.5 Flash Only, Google Keys)...`);

    // 1. GOOGLE SWARM LOOP (Try up to 3 different Gemini 2.5 Flash keys)
    for (let i = 0; i < 3; i++) {
        let keyData = null;
        try {
            keyData = await keyService.getSmartKey('google', 'gemini-2.5-flash');
            if (!keyData || !keyData.key || keyData.model !== 'gemini-2.5-flash') {
                console.warn(`[AI] No valid Gemini 2.5 Flash keys available for Swarm Attempt ${i+1}. Skipping Google swarm.`);
                break;
            }

            const apiKey = keyData.key;
            const baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
            
            const openai = new OpenAI({ 
                apiKey: apiKey, 
                baseURL: baseURL,
                timeout: 20000
            });

            try {
                console.log(`[AI] Google Swarm (Key ${i+1}): Testing Flash on key ${apiKey.substring(0,6)}...`);
                const completion = await openai.chat.completions.create({
                    model: 'gemini-2.5-flash',
                    messages: messages,
                    response_format: responseFormat
                });
                
                const rawContent = completion.choices[0].message.content || '';
                let tokenUsage = completion.usage ? completion.usage.total_tokens : 0;
                tokenUsage = estimateTokenUsage(messages, rawContent, tokenUsage);
                keyService.recordKeyUsage(apiKey, tokenUsage);
                
                try {
                    const parsed = extractJsonFromAiResponse(rawContent);
                    
                    if (parsed.tool === 'search_products' && parsed.query) {
                        console.log(`[AI] Tool Call: Searching products for "${parsed.query}"...`);
                        const products = await dbService.searchProducts(pageConfig.user_id, parsed.query, pageConfig.page_id);
                        
                        if (products && products.length > 0) {
                            const lines = products.map((p, idx) => {
                                const name = p.name || 'Unnamed Product';
                                const priceText = p.price ? `${p.price} ${p.currency || 'BDT'}` : 'দাম দেওয়া নেই';
                                const descText = p.description ? p.description.replace(/\s+/g, ' ').substring(0, 120) : '';
                                return `Item ${idx + 1}: ${name}. দাম: ${priceText}.${descText ? ` বিবরণ: ${descText}` : ''}`;
                            });
                            
                            const images = products
                                .filter(p => p.image_url && typeof p.image_url === 'string')
                                .map(p => ({
                                    url: p.image_url,
                                    title: p.name || 'Product Image'
                                }));
                            
                            const replyText = lines.join(' \n');
                            
                            return {
                                reply: replyText,
                                images: images,
                                sentiment: 'pos',
                                dm_message: null,
                                bad_words: null,
                                order_details: null,
                                model: 'gemini-2.5-flash',
                                token_usage: tokenUsage + totalTokenUsage
                            };
                        }
                    }

                    if (!parsed.reply) parsed.reply = parsed.response || parsed.text;
                    return { ...parsed, model: 'gemini-2.5-flash', token_usage: tokenUsage + totalTokenUsage };
                } catch (e) {
                     let cleanText = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                     cleanText = extractReplyFromText(cleanText);
                     return { reply: cleanText, sentiment: 'neutral', model: 'gemini-2.5-flash', token_usage: tokenUsage + totalTokenUsage };
                }

            } catch (flashError) {
                console.warn(`[AI] Flash Failed on Key ${i+1} (${flashError.message}).`);
                
                const status = flashError.status || (flashError.response ? flashError.response.status : null);
                handleAiError(flashError, apiKey, 'gemini-2.5-flash');
                
                if (status === 401 || status === 403) {
                    continue;
                }
            }

        } catch (setupError) {
            console.warn(`[AI] Swarm Setup Error:`, setupError.message);
        }
    }
    
    console.error("[AI] All Phase 2 attempts failed (No valid Gemini 2.5 Flash Google keys).");
    return null;
}

// --- HELPER: Process Image (Vision) with Smart Fallback ---
async function processImageWithVision(imageUrl, pageConfig = {}, customOptions = null) {
    let base64Image;
    let mimeType;
    let errors = [];

    // 0. Pre-process Image (Download/Decode)
    try {
        if (imageUrl.startsWith('data:')) {
            console.log(`[Vision] Processing Base64 Data URI...`);
            // Safer parsing than strict regex
            const parts = imageUrl.split(',');
            if (parts.length >= 2) {
                // Extract mime type from first part (data:image/jpeg;base64)
                const mimeMatch = parts[0].match(/:(.*?);/);
                mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                // Join rest as data (in case of extra commas, though unlikely in base64)
                base64Image = parts.slice(1).join(',');
                // Clean whitespace just in case
                base64Image = base64Image.replace(/\s/g, '');
            } else {
                throw new Error("Invalid Data URI format (missing comma)");
            }
        } else {
            console.log(`[Vision] Downloading image from URL: ${imageUrl.substring(0, 50)}...`);
            
            const headers = { 'User-Agent': 'Mozilla/5.0' };
            if (imageUrl.includes('graph.facebook.com') && pageConfig.page_access_token) {
                console.log('[Vision] Detected Facebook Graph URL. Injecting Access Token.');
                headers['Authorization'] = `Bearer ${pageConfig.page_access_token}`;
            }

            const response = await axios.get(imageUrl, { 
                responseType: 'arraybuffer',
                headers: headers,
                timeout: 10000 // 10s timeout
            });
            base64Image = Buffer.from(response.data).toString('base64');
            mimeType = response.headers['content-type'] || 'image/jpeg';
            logDebug(`[Vision] Image Downloaded. Mime: ${mimeType}, Size: ${base64Image.length}`);
        }
    } catch (e) {
        const errorMsg = `[Vision] Pre-processing Failed: ${e.message}`;
        console.error(errorMsg);
        logDebug(errorMsg);
        return `Image found but failed to download/decode. Reason: ${e.message}`;
    }

    // Determine System Prompt
    // UPDATE: Generic default to avoid hidden business logic (User Request)
    const systemPrompt = customOptions?.prompt || "Describe this image in detail.";

    // --- PRIORITY ATTEMPT (Custom Options) ---
    if (customOptions?.provider === 'openrouter' && customOptions?.model) {
        try {
            const provider = 'openrouter';
            const model = customOptions.model;
            console.log(`[Vision] Priority Attempt: ${model} (${provider})`);

            let keyData = await keyService.getSmartKey(provider, model);
            if (!keyData || !keyData.key) {
                 keyData = await keyService.getSmartKey(provider, 'default');
            }
            
            if (!keyData || !keyData.key) throw new Error("No Key found for OpenRouter");
            const apiKey = keyData.key;
            const url = 'https://openrouter.ai/api/v1/chat/completions';
            
            const payload = {
                model: model,
                messages: [
                    { role: "system", content: systemPrompt },
                    {
                        role: "user",
                        content: [
                            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
                        ]
                    }
                ]
            };

            const response = await axios.post(url, payload, {
                headers: { 
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://orderly-conversations.com', 
                    'X-Title': 'Orderly Conversations'
                },
                timeout: 20000 // 20s Timeout
            });

            const result = response.data?.choices?.[0]?.message?.content;
            const usage = response.data?.usage?.total_tokens || 0;

            if (!result) throw new Error("Empty response from OpenRouter");

            logDebug(`[Vision] Success with Priority ${model}: ${result.substring(0, 30)}... Usage: ${usage}`);
            return { text: result, usage: usage };

        } catch (error) {
            const errMsg = error.response?.data?.error?.message || error.message;
            console.warn(`[Vision] Priority Attempt (${customOptions.model}) Failed: ${errMsg}`);
            errors.push(`Priority OpenRouter: ${errMsg}`);
            logDebug(`[Vision] Priority Error: ${errMsg}`);
            // Continue to fallbacks...
        }
    }

    // --- FALLBACK STRATEGY ---
    // Priority 1: Gemini 2.5 Flash
    // Priority 2: Gemini 2.0 Flash Lite (Preview)
    // Priority 3: OpenRouter Best Free Vision (Qwen 2.5 VL)
    
    // ATTEMPT 1: Gemini 2.5 Flash
    try {
        const provider = 'google';
        const model = 'gemini-2.5-flash';
        console.log(`[Vision] Attempt 1: ${model} (${provider})`);
        
        const keyData = await keyService.getSmartKey(provider, model);
        if (!keyData || !keyData.key) throw new Error("No Key found for Gemini 2.5 Flash");

        const apiKey = keyData.key;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        
        // Gemini doesn't strictly separate system prompt in generateContent
        const textPrompt = systemPrompt;

        const payload = {
            contents: [{
                parts: [
                    { text: textPrompt },
                    { inline_data: { mime_type: mimeType, data: base64Image } }
                ]
            }]
        };

        const visionResponse = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 20000 // 20s Timeout
        });

        const result = visionResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const usage = visionResponse.data?.usageMetadata?.totalTokenCount || 0;

        if (!result) throw new Error("Empty response from Gemini");
        
        logDebug(`[Vision] Success with ${model}: ${result.substring(0, 30)}... Usage: ${usage}`);
        return { text: result, usage: usage };

    } catch (error) {
        const errMsg = error.response?.data?.error?.message || error.message;
        console.warn(`[Vision] Attempt 1 (${'gemini-2.5-flash'}) Failed: ${errMsg}`);
        errors.push(`Gemini 2.5 Flash: ${errMsg}`);
        logDebug(`[Vision] Error 1: ${errMsg}`);
    }

    // ATTEMPT 2: Gemini 2.5 Flash Lite
    try {
        const provider = 'google';
        const model = 'gemini-2.5-flash-lite';
        console.log(`[Vision] Attempt 2: ${model} (${provider})`);
        
        const keyData = await keyService.getSmartKey(provider, model);
        if (!keyData || !keyData.key) throw new Error("No Key found for Gemini 2.5 Flash Lite");

        const apiKey = keyData.key;
        // Use the model ID directly as requested
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        
        const textPrompt = systemPrompt; // Reuse prompt
        const payload = {
            contents: [{
                parts: [
                    { text: textPrompt },
                    { inline_data: { mime_type: mimeType, data: base64Image } }
                ]
            }]
        };

        const visionResponse = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        const result = visionResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const usage = visionResponse.data?.usageMetadata?.totalTokenCount || 0;

        if (!result) throw new Error("Empty response from Gemini Lite");

        logDebug(`[Vision] Success with ${model}: ${result.substring(0, 30)}... Usage: ${usage}`);
        return { text: result, usage: usage };

    } catch (error) {
        const errMsg = error.response?.data?.error?.message || error.message;
        console.warn(`[Vision] Attempt 2 (${'gemini-2.5-flash-lite'}) Failed: ${errMsg}`);
        errors.push(`Gemini 2.5 Flash Lite: ${errMsg}`);
        logDebug(`[Vision] Error 2: ${errMsg}`);
    }

    // ATTEMPT 3: OpenRouter (Qwen 2.5 VL - Free)
    try {
        const provider = 'openrouter';
        const model = 'qwen/qwen-2.5-vl-7b-instruct:free';
        console.log(`[Vision] Attempt 3: ${model} (${provider})`);

        let keyData = await keyService.getSmartKey(provider, model);
        if (!keyData || !keyData.key) {
             // Try generic default
             keyData = await keyService.getSmartKey(provider, 'default');
        }
        
        if (!keyData || !keyData.key) throw new Error("No Key found for OpenRouter");

        const apiKey = keyData.key;
        const url = 'https://openrouter.ai/api/v1/chat/completions';
        
        const payload = {
            model: model,
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                {
                    role: "user",
                    content: [
                        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
                    ]
                }
            ]
        };

        const response = await axios.post(url, payload, {
            headers: { 
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://orderly-conversations.com', 
                'X-Title': 'Orderly Conversations'
            }
        });

        const result = response.data?.choices?.[0]?.message?.content;
        const usage = response.data?.usage?.total_tokens || 0;

        if (!result) throw new Error("Empty response from OpenRouter");

        logDebug(`[Vision] Success with ${model}: ${result.substring(0, 30)}... Usage: ${usage}`);
        return { text: result, usage: usage };

    } catch (error) {
        const errMsg = error.response?.data?.error?.message || error.message;
        console.warn(`[Vision] Attempt 3 (${'qwen/qwen-2.5-vl-7b-instruct:free'}) Failed: ${errMsg}`);
        errors.push(`OpenRouter Qwen: ${errMsg}`);
        logDebug(`[Vision] Error 3: ${errMsg}`);
    }

    // FINAL FAILURE LOGGING
    const failureReason = `Image Analysis Failed. Reasons: ${errors.join(' | ')}`;
    console.error(`[Vision] All attempts failed. Logs: ${failureReason}`);
    logDebug(`[Vision] FATAL: ${failureReason}`);
    
    return { text: "Image found but analysis unavailable due to technical errors.", usage: 0 };
}

// --- HELPER: Transcribe Audio (Multi-Engine Priority) ---
async function transcribeAudio(audioUrl, config) {
    console.log(`[Audio] Processing: ${audioUrl.substring(0, 50)}...`);
    let audioBuffer, mimeType;

    // 1. Download Audio
    try {
        const headers = { 'User-Agent': 'Mozilla/5.0' };
        if (audioUrl.includes('graph.facebook.com') && config.page_access_token) headers['Authorization'] = `Bearer ${config.page_access_token}`;

        const response = await axios.get(audioUrl, { responseType: 'arraybuffer', headers, validateStatus: s => s === 200 });
        audioBuffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || 'audio/ogg';
        
        // Map to Gemini-supported MIME types
        if (contentType.includes('opus') || contentType.includes('ogg')) mimeType = 'audio/ogg';
        else if (contentType.includes('mp3') || contentType.includes('mpeg')) mimeType = 'audio/mp3';
        else if (contentType.includes('wav')) mimeType = 'audio/wav';
        else if (contentType.includes('aac')) mimeType = 'audio/aac';
        else mimeType = 'audio/ogg'; // Default safe assumption
        
        logDebug(`[Audio] Downloaded. Size: ${audioBuffer.length}, Type: ${mimeType}`);

    } catch (e) {
        console.error(`[Audio] Download Failed:`, e.message);
        return "[Audio Download Failed]";
    }

    // 2. Priority Chain: Gemini 2.5 Flash -> Lite -> OpenRouter -> Groq (Fallback)
    const priorityChain = [
        { provider: 'google', model: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        { provider: 'google', model: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
        { provider: 'openrouter', model: bestFreeModels.voice, name: `OpenRouter Voice (${bestFreeModels.voice})` }
    ];

    for (const option of priorityChain) {
        try {
            if (option.provider === 'openrouter' && !option.model.includes('gemini') && !option.model.includes('claude')) {
                continue; 
            }

            console.log(`[Audio] Attempting Transcription with ${option.name}...`);
            const keyData = await keyService.getSmartKey(option.provider, option.model);
            if (!keyData || !keyData.key) continue;
            
            const apiKey = keyData.key;
            
            // GEMINI DIRECT API
            if (option.provider === 'google' || option.model.includes('google/gemini')) {
                const baseUrl = option.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://generativelanguage.googleapis.com/v1beta';
                if (option.provider === 'openrouter') continue; 

                const url = `${baseUrl}/models/${option.model}:generateContent?key=${apiKey}`;
                const payload = {
                    contents: [{
                        parts: [
                            { text: "Transcribe this audio in standard Bengali. If the audio is in Bengali script, output Bengali. If it's Banglish, output standard Bengali text. Do not translate English words, keep them in English script if spoken clearly. Output ONLY the raw transcription." },
                            { inline_data: { mime_type: mimeType, data: audioBuffer.toString('base64') } }
                        ]
                    }]
                };
                
                const res = await axios.post(url, payload);
                const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                const usage = res.data?.usageMetadata?.totalTokenCount || 0;
                
                if (text) {
                    console.log(`[Audio] Success with ${option.name}: "${text.substring(0, 30)}..." Usage: ${usage}`);
                    return { text: text.trim(), usage: usage };
                }
            }
            
        } catch (e) {
             console.warn(`[Audio] ${option.name} Failed:`, e.message);
        }
    }

    // 3. Fallback to Groq Whisper (Existing Reliable Method)
    try {
        console.log(`[Audio] Falling back to Groq Whisper...`);
        const keyData = await keyService.getSmartKey('groq', 'whisper-large-v3');
        if (!keyData || !keyData.key) return { text: "[Audio Message]", usage: 0 };
        const apiKey = keyData.key;

        const formData = new FormData();
        formData.append('file', audioBuffer, { filename: `audio.${mimeType.split('/')[1]}`, contentType: mimeType });
        formData.append('model', 'whisper-large-v3');
        formData.append('language', 'bn'); 
        formData.append('prompt', 'Transcribe exactly in standard Bengali.');
        formData.append('temperature', '0');

        const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
            headers: { ...formData.getHeaders(), 'Authorization': `Bearer ${apiKey}` },
            timeout: 10000
        });

        if (res.data.text) {
            // Estimate usage: 1 min ~ 100 tokens? Or just 0 for now as it's not token-based
            // Let's use 0 to be safe, or we can add a nominal fee if user insists.
            // User said "token ba cost consume kore". 
            // Since Groq is free (mostly) or cheap, 0 is fine.
            return { text: res.data.text, usage: 0 };
        }

    } catch (e) {
        console.error(`[Audio] Groq Fallback Failed:`, e.message);
    }

    return { text: "[Audio Message (Transcription Failed)]", usage: 0 };
}

module.exports = {
    generateReply,
    generateResponse,
    fetchOgImage,
    processImageWithVision,
    transcribeAudio
};
