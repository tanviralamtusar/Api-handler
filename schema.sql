-- schema.sql
-- SQLite Database Schema containing only essential tables

CREATE TABLE IF NOT EXISTS user_configs (
    user_id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    message_credit INTEGER DEFAULT 0,
    balance REAL DEFAULT 0.0,
    service_api_key TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_usage_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    model TEXT,
    tokens INTEGER,
    cost REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES user_configs(user_id)
);

CREATE TABLE IF NOT EXISTS lite_engine_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT UNIQUE,
    status TEXT DEFAULT 'active',
    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    requests_today INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS openrouter_engine_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT UNIQUE,
    label TEXT,
    usage_limit REAL DEFAULT 0.0,
    usage_used REAL DEFAULT 0.0,
    is_active BOOLEAN DEFAULT 1,
    last_checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS openrouter_engine_config (
    config_type TEXT PRIMARY KEY,
    text_model TEXT,
    voice_model TEXT,
    image_model TEXT,
    text_model_details TEXT, -- JSON string or metadata
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    name TEXT,
    description TEXT,
    image_url TEXT,
    variants TEXT, -- JSON string
    is_active BOOLEAN DEFAULT 1,
    price REAL,
    currency TEXT DEFAULT 'BDT',
    allowed_page_ids TEXT, -- JSON string
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES user_configs(user_id)
);
