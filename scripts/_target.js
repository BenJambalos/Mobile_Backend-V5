// Shared by the helper scripts: figures out WHICH database to talk to.
//
// 1. DB_URL (any mysql://user:pass@host:port/dbname URL) wins. Use Railway's
//    MYSQL_PUBLIC_URL here when running a script from YOUR computer.
// 2. Otherwise the same variables the server uses (DB_* from .env, or the
//    MYSQL* ones Railway injects), so these scripts also work with
//    `railway run node scripts/...`.
require('dotenv').config({ quiet: true });

function target() {
  if (process.env.DB_URL) {
    let u;
    try {
      u = new URL(process.env.DB_URL);
    } catch {
      throw new Error('DB_URL is not a valid URL. It must look like mysql://root:PASSWORD@HOST:PORT/railway');
    }
    if (u.protocol !== 'mysql:') throw new Error('DB_URL must start with mysql://');
    return {
      host: u.hostname,
      port: Number(u.port) || 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    };
  }
  return {
    host: process.env.DB_HOST || process.env.MYSQLHOST,
    port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
    user: process.env.DB_USER || process.env.MYSQLUSER,
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
    database: process.env.DB_NAME || process.env.MYSQLDATABASE,
  };
}

function describe(t) {
  return `${t.user}@${t.host}:${t.port}/${t.database}`; // never prints the password
}

function explain(err) {
  const hints = {
    ENOTFOUND: 'The host name could not be found. If it ends in .railway.internal you are using the PRIVATE address from your own computer - use the PUBLIC one (MYSQL_PUBLIC_URL).',
    ECONNREFUSED: 'Nothing is listening at that host/port. Check the port number, and that Public Networking is enabled on the MySQL service.',
    ETIMEDOUT: 'Connection timed out. Wrong host/port, a firewall/VPN/school Wi-Fi blocking the port, or the MySQL service is not running (check Railway > MySQL > Deployments).',
    ER_ACCESS_DENIED_ERROR: 'Wrong user or password. Copy MYSQL_PUBLIC_URL again from Railway > MySQL > Variables (the password is part of it).',
    ER_BAD_DB_ERROR: 'That database name does not exist. On Railway it is normally "railway" (the last part of the URL).',
    ER_NOT_SUPPORTED_AUTH_MODE: 'Auth plugin problem. Make sure you ran `npm install` inside hyqual_backend so mysql2 is up to date.',
  };
  return hints[err.code] || '';
}

module.exports = { target, describe, explain };
