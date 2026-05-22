const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.SQLITE_DB_PATH || path.join(__dirname, '../../database.sqlite');
const db = new Database(dbPath);

// Basic schema initialization just to ensure safety
const fs = require('fs');
const schemaPath = path.join(__dirname, '../../schema.sql');
if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schema);
}

// Ensure the new 'name' column exists in 'user_configs' (migration safety)
try {
    db.prepare("ALTER TABLE user_configs ADD COLUMN name TEXT").run();
} catch (e) {
    // Ignore error if column already exists
}

class QueryBuilder {
    constructor(table) {
        this.table = table;
        this.action = null;
        this.fields = '*';
        this.conditions = [];
        this.orderRules = [];
        this.limitCount = null;
        this.data = null;
        this.onConflict = null;
        this.countType = null;
    }

    select(fields = '*', options = {}) {
        this.action = 'select';
        this.fields = fields;
        if (options.count) {
            this.countType = options.count;
        }
        return this;
    }

    insert(data) {
        this.action = 'insert';
        this.data = data;
        return this;
    }

    update(data) {
        this.action = 'update';
        this.data = data;
        return this;
    }

    upsert(data, options = {}) {
        this.action = 'upsert';
        this.data = data;
        this.onConflict = options.onConflict;
        return this;
    }

    delete() {
        this.action = 'delete';
        return this;
    }

    eq(column, value) {
        this.conditions.push({ type: 'eq', column, value });
        return this;
    }

    neq(column, value) {
        this.conditions.push({ type: 'neq', column, value });
        return this;
    }

    gt(column, value) {
        this.conditions.push({ type: 'gt', column, value });
        return this;
    }

    gte(column, value) {
        this.conditions.push({ type: 'gte', column, value });
        return this;
    }

    lt(column, value) {
        this.conditions.push({ type: 'lt', column, value });
        return this;
    }

    lte(column, value) {
        this.conditions.push({ type: 'lte', column, value });
        return this;
    }

    in(column, values) {
        this.conditions.push({ type: 'in', column, value: values });
        return this;
    }

    ilike(column, value) {
        this.conditions.push({ type: 'ilike', column, value });
        return this;
    }

    contains(column, value) {
        this.conditions.push({ type: 'contains', column, value });
        return this;
    }

    or(filterString) {
        this.conditions.push({ type: 'or', filterString });
        return this;
    }

    order(column, options = { ascending: true }) {
        this.orderRules.push({ column, ascending: options.ascending });
        return this;
    }

    limit(count) {
        this.limitCount = count;
        return this;
    }

    range(from, to) {
        this.limitCount = to - from + 1;
        this.offsetCount = from;
        return this;
    }

    async single() {
        this.limitCount = 1;
        const result = await this.execute();
        if (!result.data || result.data.length === 0) {
            return { data: null, error: { message: 'No rows found' } };
        }
        return { data: result.data[0], error: null };
    }

    async maybeSingle() {
        this.limitCount = 1;
        const result = await this.execute();
        if (!result.data || result.data.length === 0) {
            return { data: null, error: null };
        }
        return { data: result.data[0], error: null };
    }

    async then(resolve, reject) {
        try {
            const result = await this.execute();
            resolve(result);
        } catch (e) {
            reject(e);
        }
    }

    async execute() {
        try {
            if (this.action === 'select') return this._executeSelect();
            if (this.action === 'insert') return this._executeInsert();
            if (this.action === 'update') return this._executeUpdate();
            if (this.action === 'upsert') return this._executeUpsert();
            if (this.action === 'delete') return this._executeDelete();
            throw new Error('No action specified');
        } catch (e) {
            return { data: null, error: e, count: null };
        }
    }

    _buildWhereClause() {
        let whereClauses = [];
        let params = [];

        for (const cond of this.conditions) {
            if (cond.type === 'eq') {
                whereClauses.push(`${cond.column} = ?`);
                params.push(cond.value);
            } else if (cond.type === 'neq') {
                whereClauses.push(`${cond.column} != ?`);
                params.push(cond.value);
            } else if (cond.type === 'gt') {
                whereClauses.push(`${cond.column} > ?`);
                params.push(cond.value);
            } else if (cond.type === 'gte') {
                whereClauses.push(`${cond.column} >= ?`);
                params.push(cond.value);
            } else if (cond.type === 'lt') {
                whereClauses.push(`${cond.column} < ?`);
                params.push(cond.value);
            } else if (cond.type === 'lte') {
                whereClauses.push(`${cond.column} <= ?`);
                params.push(cond.value);
            } else if (cond.type === 'in') {
                const placeholders = cond.value.map(() => '?').join(',');
                whereClauses.push(`${cond.column} IN (${placeholders})`);
                params.push(...cond.value);
            } else if (cond.type === 'ilike') {
                whereClauses.push(`${cond.column} LIKE ?`);
                params.push(cond.value.replace(/%/g, '%'));
            } else if (cond.type === 'contains') {
                // SQLite JSON contains approximation
                whereClauses.push(`${cond.column} LIKE ?`);
                params.push(`%${cond.value[0]}%`);
            } else if (cond.type === 'or') {
                // Parse simple "name.ilike.%val%,desc.ilike.%val%"
                const orParts = cond.filterString.split(',');
                let orClauses = [];
                for (const part of orParts) {
                    const match = part.match(/(.*)\.(.*)\.(.*)/);
                    if (match) {
                        const [, col, op, val] = match;
                        if (op === 'ilike' || op === 'eq') {
                            const sqlOp = op === 'ilike' ? 'LIKE' : '=';
                            orClauses.push(`${col} ${sqlOp} ?`);
                            params.push(val);
                        }
                    } else if (part.includes('eq.')) {
                        // handling simple and(sender.eq.1,rec.eq.2) formats loosely
                        const simpleMatch = part.match(/(.*)\.eq\.(.*)/);
                        if (simpleMatch) {
                            orClauses.push(`${simpleMatch[1]} = ?`);
                            params.push(simpleMatch[2]);
                        }
                    }
                }
                if (orClauses.length > 0) {
                    whereClauses.push(`(${orClauses.join(' OR ')})`);
                }
            }
        }

        let whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        return { whereString, params };
    }

    _executeSelect() {
        let sql = `SELECT ${this.fields === '*' ? '*' : this.fields.split(',').map(s => s.trim()).join(',')} FROM ${this.table}`;
        const { whereString, params } = this._buildWhereClause();
        sql += ` ${whereString}`;

        for (let i = 0; i < this.orderRules.length; i++) {
            sql += i === 0 ? ' ORDER BY ' : ', ';
            sql += `${this.orderRules[i].column} ${this.orderRules[i].ascending ? 'ASC' : 'DESC'}`;
        }

        if (this.limitCount) {
            sql += ` LIMIT ${this.limitCount}`;
            if (this.offsetCount) {
                sql += ` OFFSET ${this.offsetCount}`;
            }
        }

        const stmt = db.prepare(sql);
        const rows = stmt.all(...params);

        let count = null;
        if (this.countType) {
            const countSql = `SELECT COUNT(*) as c FROM ${this.table} ${whereString}`;
            const countStmt = db.prepare(countSql);
            const countResult = countStmt.get(...params);
            count = countResult.c;
        }

        return { data: rows, error: null, count };
    }

    _executeInsert() {
        const isArray = Array.isArray(this.data);
        const records = isArray ? this.data : [this.data];
        if (records.length === 0) return { data: [], error: null };

        const keys = Object.keys(records[0]);
        const placeholders = keys.map(() => '?').join(',');
        const sql = `INSERT INTO ${this.table} (${keys.join(',')}) VALUES (${placeholders})`;
        const stmt = db.prepare(sql);

        const results = [];
        db.transaction(() => {
            for (const rec of records) {
                const vals = keys.map(k => {
                    let v = rec[k];
                    if (typeof v === 'object' && v !== null) return JSON.stringify(v);
                    return v;
                });
                const info = stmt.run(...vals);
                results.push({ ...rec, id: info.lastInsertRowid });
            }
        })();

        return { data: results, error: null };
    }

    _executeUpdate() {
        const keys = Object.keys(this.data);
        const setClauses = keys.map(k => `${k} = ?`).join(',');
        
        const { whereString, params } = this._buildWhereClause();
        const sql = `UPDATE ${this.table} SET ${setClauses} ${whereString}`;
        const stmt = db.prepare(sql);

        const updateParams = keys.map(k => {
            let v = this.data[k];
            if (typeof v === 'object' && v !== null) return JSON.stringify(v);
            return v;
        });

        stmt.run(...updateParams, ...params);

        // Fetch updated rows if possible
        if (whereString) {
             const selectSql = `SELECT * FROM ${this.table} ${whereString}`;
             const updatedRows = db.prepare(selectSql).all(...params);
             return { data: updatedRows, error: null };
        }

        return { data: null, error: null };
    }

    _executeUpsert() {
        // SQLite UPSERT syntax
        const isArray = Array.isArray(this.data);
        const records = isArray ? this.data : [this.data];
        if (records.length === 0) return { data: [], error: null };

        const keys = Object.keys(records[0]);
        const placeholders = keys.map(() => '?').join(',');
        
        let conflictClause = '';
        if (this.onConflict) {
            const conflictKeys = this.onConflict.split(',').map(s => s.trim());
            const updateClauses = keys.filter(k => !conflictKeys.includes(k)).map(k => `${k} = excluded.${k}`).join(',');
            conflictClause = `ON CONFLICT(${conflictKeys.join(',')}) DO UPDATE SET ${updateClauses}`;
        } else {
            conflictClause = `ON CONFLICT DO NOTHING`; // Fallback
        }

        const sql = `INSERT INTO ${this.table} (${keys.join(',')}) VALUES (${placeholders}) ${conflictClause}`;
        const stmt = db.prepare(sql);

        const results = [];
        db.transaction(() => {
            for (const rec of records) {
                const vals = keys.map(k => {
                    let v = rec[k];
                    if (typeof v === 'object' && v !== null) return JSON.stringify(v);
                    return v;
                });
                const info = stmt.run(...vals);
                results.push({ ...rec, id: info.lastInsertRowid });
            }
        })();

        return { data: results, error: null };
    }

    _executeDelete() {
        const { whereString, params } = this._buildWhereClause();
        const sql = `DELETE FROM ${this.table} ${whereString}`;
        const stmt = db.prepare(sql);
        stmt.run(...params);
        return { data: null, error: null };
    }
}

class SupabaseMock {
    from(table) {
        return new QueryBuilder(table);
    }
    
    rpc(fnName, args) {
        return Promise.resolve({ data: false, error: { message: "RPC not supported in SQLite mock" } });
    }
}

const supabase = new SupabaseMock();

module.exports = { supabase, SupabaseMock, db };
