require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const dbPath = process.env.SQLITE_DB_PATH || path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

try {
    // Ensure the new 'name' column exists in 'user_configs' (migration safety)
    try {
        db.prepare("ALTER TABLE user_configs ADD COLUMN name TEXT").run();
    } catch (e) {
        // Ignore error if column already exists
    }

    // 1. Seed user_configs
    const checkUser = db.prepare("SELECT * FROM user_configs WHERE user_id = ?").get('test-user');
    if (!checkUser) {
        db.prepare(`
            INSERT INTO user_configs (user_id, name, email, service_api_key, message_credit, balance)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run('test-user', 'Test User', 'test@example.com', 'sk-test-key-12345', 9999, 1000.0);
        console.log("Seeded database with test user config!");
        console.log("API Key: sk-test-key-12345");
    } else {
        console.log("Test user already exists in database.");
    }

    // 2. Seed lite_engine_keys (using GROQ_API_KEY if exists)
    if (process.env.GROQ_API_KEY) {
        const checkGroqKey = db.prepare("SELECT * FROM lite_engine_keys WHERE api_key = ?").get(process.env.GROQ_API_KEY);
        if (!checkGroqKey) {
            db.prepare(`
                INSERT INTO lite_engine_keys (api_key, status)
                VALUES (?, ?)
            `).run(process.env.GROQ_API_KEY, 'active');
            console.log("Seeded lite_engine_keys with GROQ_API_KEY from .env!");
        } else {
            console.log("GROQ_API_KEY already exists in lite_engine_keys.");
        }
    } else {
        console.warn("GROQ_API_KEY not found in .env; skipping lite_engine_keys seeding.");
    }

} catch (e) {
    console.error("Error seeding database:", e);
}
