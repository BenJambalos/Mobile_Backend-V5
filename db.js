const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const pool = mysql.createPool({
  // DB_* wins (local .env); the MYSQL* names are what Railway's MySQL
  // service provides, so a Railway deploy works without renaming anything.
  host: process.env.DB_HOST || process.env.MYSQLHOST,
  port: process.env.DB_PORT || process.env.MYSQLPORT || 3306,
  user: process.env.DB_USER || process.env.MYSQLUSER,
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
  database: process.env.DB_NAME || process.env.MYSQLDATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: false,
  // Instants are exchanged with MySQL as UTC. Without this mysql2 converts
  // using the Node process's own zone, which differs between a laptop and Railway.
  timezone: '+08:00',
  decimalNumbers: true, // return DECIMAL columns as JS numbers, not strings
  charset: 'utf8mb4',   // without this, special characters like ≥ get mangled
});

// Every pooled connection runs with a UTC session clock, so NOW(),
// FROM_UNIXTIME() and TIMESTAMP columns all agree no matter how the MySQL
// server itself is configured. (Display in Philippine time is done in
// utils/time.js, never by shifting stored data.)
pool.pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+08:00'");
});

module.exports = pool;
