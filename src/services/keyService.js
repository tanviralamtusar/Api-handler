// keyService.js - SQLite / Env Fallback Key Service stub
const dbService = require('./dbService');

module.exports = {
    getSmartKey: async (provider, model) => {
        console.log(`[KeyService] getSmartKey called for provider=${provider}, model=${model}`);
        
        let key = null;
        if (provider === 'google') {
            key = process.env.GOOGLE_CLOUD_API_KEY;
        } else if (provider === 'groq') {
            key = process.env.GROQ_API_KEY;
        }

        // Fallback to searching database if not in env
        if (!key) {
            try {
                // Check openrouter_engine_keys as fallback
                const { data } = await dbService.supabase
                    .from('openrouter_engine_keys')
                    .select('api_key')
                    .eq('is_active', true)
                    .limit(1)
                    .maybeSingle();
                if (data) key = data.api_key;
            } catch (e) {
                console.warn('[KeyService] DB lookup failed:', e.message);
            }
        }

        return key ? { key, model } : null;
    },

    recordKeyUsage: (key, tokens) => {
        console.log(`[KeyService] recordKeyUsage: key=${key.substring(0, 8)}... used ${tokens} tokens`);
    },

    setManualLimit: (model, details) => {
        console.log(`[KeyService] setManualLimit: model=${model}`);
    },

    report429: (model) => {
        console.log(`[KeyService] report429: model=${model}`);
    },

    markKeyAsDead: (key, duration, reason) => {
        console.log(`[KeyService] markKeyAsDead: key=${key.substring(0, 8)}... duration=${duration}ms reason=${reason}`);
    },

    markKeyAsQuotaExceeded: (key) => {
        console.log(`[KeyService] markKeyAsQuotaExceeded: key=${key.substring(0, 8)}...`);
    }
};
