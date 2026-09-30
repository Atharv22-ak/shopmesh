const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.DB_NAME,
  port: 5432,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function init(sql) {
  for (let i = 0; i < 30; i++) {
    try { await pool.query(sql); return; }
    catch (e) { console.log('waiting for postgres...', e.code || e.message); await sleep(2000); }
  }
  throw new Error('postgres unreachable');
}
module.exports = { pool, init };
