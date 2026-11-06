// Creates (or fixes) the Super Admin login.
//
//   node scripts/create_super_admin.js <email> <password> [First] [Last]
//
// The password is hashed with bcrypt exactly like normal registration, so
// the normal login route accepts it. Point it at Railway with DB_URL.
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { target, describe, explain } = require('./_target');

(async () => {
  const [email, password, first = 'Super', last = 'Admin'] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node scripts/create_super_admin.js <email> <password> [First] [Last]');
    process.exit(1);
  }
  if (password.length < 8) { console.error('Use a password of at least 8 characters.'); process.exit(1); }

  const t = target();
  console.log(`Connecting to ${describe(t)} ...`);
  let conn;
  try {
    conn = await mysql.createConnection({ ...t, charset: 'utf8mb4', connectTimeout: 15000 });
    const hash = await bcrypt.hash(password, 10);

    const [existing] = await conn.query('SELECT account_id, role FROM accounts WHERE username = ?', [email.trim()]);
    if (existing.length) {
      if (existing[0].role !== 'super_admin') {
        console.error(`"${email}" already exists as a ${existing[0].role}. Use a different email for the Super Admin.`);
        process.exit(1);
      }
      await conn.query(`UPDATE accounts SET password_hash = ?, status = 'active' WHERE account_id = ?`, [hash, existing[0].account_id]);
      console.log(`Super Admin #${existing[0].account_id} already existed: password reset and status set to active.`);
    } else {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `INSERT INTO accounts (username, password_hash, role, status) VALUES (?, ?, 'super_admin', 'active')`,
        [email.trim(), hash]
      );
      await conn.query(
        `INSERT INTO user_profiles (account_id, first_name, last_name, email) VALUES (?, ?, ?, ?)`,
        [r.insertId, first, last, email.trim()]
      );
      await conn.commit();
      console.log(`Super Admin created: account #${r.insertId} (${email}).`);
    }
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch {} }
    console.error(`FAILED: ${err.code || ''} ${err.message}`);
    const hint = explain(err);
    if (hint) console.error('Hint: ' + hint);
    if (/Data truncated|Incorrect enum/i.test(err.message)) {
      console.error("Hint: the accounts table doesn't know 'super_admin' yet. Run database/schema.sql (fresh DB) or database/migrations/001_account_approval.sql (existing DB) first.");
    }
    if (err.code === 'ER_NO_SUCH_TABLE') console.error('Hint: the tables are missing. Run: node scripts/run_sql.js database/schema.sql');
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end();
  }
})();
