require('dotenv').config();
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const readline = require('readline');

const dbPath = process.env.SQLITE_DB_PATH || path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Ensure the new 'name' column exists in 'user_configs' (migration safety)
try {
    db.prepare("ALTER TABLE user_configs ADD COLUMN name TEXT").run();
} catch (e) {
    // Ignore error if column already exists
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function run() {
    console.log("\n=== 👤 SQLite Create New User ===");
    
    const userId = await askQuestion("Enter User ID (e.g., john-doe): ");
    if (!userId.trim()) {
        console.error("❌ Error: User ID cannot be empty.");
        rl.close();
        return;
    }
    
    const name = await askQuestion("Enter Name (optional): ");
    const email = await askQuestion("Enter Email (optional): ");
    const creditsInput = await askQuestion("Enter Starting Credits (default: 1000): ");
    const balanceInput = await askQuestion("Enter Starting Balance (default: 50.0): ");
    
    const credits = creditsInput.trim() ? parseInt(creditsInput) : 1000;
    const balance = balanceInput.trim() ? parseFloat(balanceInput) : 50.0;
    const apiKey = 'sk-' + crypto.randomBytes(24).toString('hex');

    try {
        db.prepare(`
            INSERT INTO user_configs (user_id, name, email, service_api_key, message_credit, balance)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(userId, name.trim() || null, email.trim() || null, apiKey, credits, balance);

        console.log("\n🎉 New User Registered Successfully!");
        console.log("------------------------------------");
        console.log(`- User ID:        ${userId}`);
        console.log(`- Name:           ${name.trim() || 'N/A'}`);
        console.log(`- Email:          ${email.trim() || 'N/A'}`);
        console.log(`- API Key:        ${apiKey}`);
        console.log(`- Credits:        ${credits}`);
        console.log(`- Balance:        $${balance}`);
        console.log("------------------------------------\n");
    } catch (e) {
        console.error(`\n❌ Error: ${e.message}\n`);
    }
    
    rl.close();
}

run();
