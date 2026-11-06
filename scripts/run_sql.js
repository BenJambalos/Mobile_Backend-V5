// Runs a .sql file (or one statement) against a MySQL database, using the
// mysql2 package this project already has - so you do NOT need the `mysql`
// command line client or MySQL Workbench.
//
//   node scripts/run_sql.js database/schema.sql
//   node scripts/run_sql.js database/seed_data.sql
//   node scripts/run_sql.js -e "SHOW TABLES"
//
// Point it at Railway with DB_URL (see scripts/_target.js).
const fs = require('fs');
const mysql = require('mysql2/promise');
const { target, describe, explain } = require('./_target');

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node scripts/run_sql.js <file.sql>   or   node scripts/run_sql.js -e "SQL"');
    process.exit(1);
  }
  const inline = args[0] === '-e';
  const sql = inline ? args.slice(1).join(' ') : fs.readFileSync(args[0], 'utf8');
  if (!sql.trim()) { console.error('Nothing to run.'); process.exit(1); }

  const t = target();
  if (!t.host || !t.user || !t.database) {
    console.error('No database selected. Set DB_URL (e.g. to Railway\'s MYSQL_PUBLIC_URL) first.');
    process.exit(1);
  }
  console.log(`Connecting to ${describe(t)} ...`);

  let conn;
  try {
    conn = await mysql.createConnection({ ...t, multipleStatements: true, charset: 'utf8mb4', connectTimeout: 15000 });
    const [result] = await conn.query(sql);
    if (inline) {
      console.table(Array.isArray(result) ? result : [result]);
    } else {
      console.log(`Done: ${args[0]} ran without errors.`);
    }
  } catch (err) {
    console.error(`FAILED: ${err.code || ''} ${err.message}`);
    const hint = explain(err);
    if (hint) console.error('Hint: ' + hint);
    if (err.code === 'ER_DUP_ENTRY') {
      console.error('Hint: this data is already in the database (seed_data.sql was run before, maybe only partly). To start over: node scripts/run_sql.js database/reset_all_tables.sql, then schema.sql, then seed_data.sql again.');
    }
    if (err.code === 'ER_TABLE_EXISTS_ERROR' || /already exists/.test(err.message)) {
      console.error('Hint: tables already exist - this file was probably run before. schema.sql is safe to re-run; seed_data.sql is not (see the guide).');
    }
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end();
  }
})();
