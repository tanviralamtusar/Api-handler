const { supabase } = require('../services/sqliteMock');

module.exports = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
    }

    const apiKey = authHeader.replace('Bearer ', '').trim();
    if (!apiKey) {
        return res.status(401).json({ error: 'Unauthorized: Empty token' });
    }

    try {
        const { data: userConfig, error } = await supabase
            .from('user_configs')
            .select('user_id, email')
            .eq('service_api_key', apiKey)
            .maybeSingle();

        if (error || !userConfig) {
            return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
        }

        req.user = {
            id: userConfig.user_id,
            email: userConfig.email
        };
        next();
    } catch (err) {
        console.error('[AuthMiddleware] Error:', err);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};
