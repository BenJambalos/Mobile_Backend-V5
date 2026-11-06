const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { statusLabel, getSetupState } = require('../utils/accountState');

const router = express.Router();

// POST /api/auth/login  { email, password }
// NOTE: the app's login screen collects an "email", but this schema's
// accounts table (per your ERD) authenticates by `username`. We treat
// the login screen's email field as the username — that's what the demo
// seed data uses ('farmer@hyquai.demo' as the username). If you want a
// visually different login-vs-contact email, keep user_profiles.email
// as the separate "contact email" shown on the Profile screen (the seed
// data already does this: login is farmer@hyquai.demo, profile contact
// email is jdelacruz@qumon.ph).
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const [rows] = await pool.query('SELECT * FROM accounts WHERE username = ?', [email.trim()]);
  const account = rows[0];
  if (!account) return res.status(401).json({ error: 'Invalid email or password' });

  // Password is checked BEFORE the approval status on purpose: otherwise
  // anyone could type an email and learn whether it belongs to a pending
  // or rejected account without knowing the password.
  const ok = await bcrypt.compare(password, account.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  if (account.status === 'pending') {
    return res.status(403).json({
      error: 'Your account is still pending Super Admin approval.',
      code: 'ACCOUNT_PENDING',
      accountStatus: 'PENDING',
    });
  }
  if (account.status === 'rejected') {
    return res.status(403).json({
      error: 'Your account registration was not approved. Please contact the HyQual administrator.',
      code: 'ACCOUNT_REJECTED',
      accountStatus: 'REJECTED',
    });
  }
  if (account.status !== 'active') return res.status(403).json({ error: `Account is ${account.status}` });

  const setup = await getSetupState(account.account_id);
  const farmId = setup.farmId;

  const token = signToken({ accountId: account.account_id, farmId });
  await pool.query(
    `INSERT INTO activity_logs (account_id, action_type, action_description) VALUES (?, 'login', 'Signed in from mobile app.')`,
    [account.account_id]
  );

  res.json({
    token,
    accountId: account.account_id,
    farmId,
    role: account.role,
    accountStatus: statusLabel(account.status),
    setup,
  });
});

// GET /api/auth/me  [auth] — account + setup state, so the app can decide
// which screen to show (Farm Setup / Pond Setup / Device Setup / Dashboard).
router.get('/me', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT account_id, role, status FROM accounts WHERE account_id = ?', [req.accountId]);
  const account = rows[0];
  if (!account) return res.status(401).json({ error: 'Invalid or expired token' });
  const setup = await getSetupState(account.account_id);
  res.json({
    accountId: account.account_id,
    farmId: setup.farmId,
    role: account.role,
    accountStatus: statusLabel(account.status),
    setup,
  });
});

// POST /api/auth/signup
// Creates account + user_profile with status 'pending' and NO token — the
// person cannot use the app until a Super Admin approves the account. The
// farm is created afterwards (POST /api/farm), once the account is
// approved and the person has signed in.
router.post('/signup', async (req, res) => {
  const { firstName, middleName, lastName, email, password } = req.body;

  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query('SELECT account_id FROM accounts WHERE username = ?', [email.trim()]);
    if (existing.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [accRes] = await conn.query(
      `INSERT INTO accounts (username, password_hash, role, status) VALUES (?, ?, 'farm_owner', 'pending')`,
      [email.trim(), passwordHash]
    );
    const accountId = accRes.insertId;

    await conn.query(
      `INSERT INTO user_profiles (account_id, first_name, middle_name, last_name, email, phone)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [accountId, firstName, middleName || null, lastName, email.trim()]
    );

    await conn.query(
      `INSERT INTO activity_logs (account_id, action_type, action_description) VALUES (?, 'account_created', 'Registration submitted, awaiting Super Admin approval.')`,
      [accountId]
    );

    await conn.commit();
    res.status(201).json({
      accountId,
      accountStatus: 'PENDING',
      message: 'Your account is pending Super Admin approval.',
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// POST /api/auth/forgot-password  { email }
// Always returns 200 (don't leak which emails exist). Creates a real,
// usable reset token — wiring up the actual email send is the one piece
// left as a TODO, since it needs a mail provider (SendGrid/SES/etc).
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const [rows] = await pool.query('SELECT account_id FROM accounts WHERE username = ?', [email.trim()]);
  if (rows.length) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query(
      `INSERT INTO password_resets (account_id, token, expires_at) VALUES (?, ?, ?)`,
      [rows[0].account_id, token, expiresAt]
    );
    // TODO(email): send `token` to the user's email via a real mail
    // provider, as a link like https://yourapp.com/reset?token=TOKEN.
    console.log(`[DEV ONLY] Password reset token for ${email}: ${token}`);
  }
  res.json({ message: 'If that email exists, a reset link has been sent.' });
});

// POST /api/auth/reset-password  { token, newPassword }
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword are required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const [rows] = await pool.query(
    `SELECT * FROM password_resets WHERE token = ? AND used = 0 AND expires_at > NOW()`,
    [token]
  );
  const reset = rows[0];
  if (!reset) return res.status(400).json({ error: 'Invalid or expired reset link' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE accounts SET password_hash = ? WHERE account_id = ?', [passwordHash, reset.account_id]);
  await pool.query('UPDATE password_resets SET used = 1 WHERE reset_id = ?', [reset.reset_id]);
  res.json({ message: 'Password updated. You can now sign in.' });
});

// PUT /api/auth/change-password  [auth]  { currentPassword, newPassword }
router.put('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const [rows] = await pool.query('SELECT * FROM accounts WHERE account_id = ?', [req.accountId]);
  const account = rows[0];
  const ok = await bcrypt.compare(currentPassword, account.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE accounts SET password_hash = ? WHERE account_id = ?', [passwordHash, req.accountId]);
  res.json({ message: 'Password updated.' });
});

module.exports = router;
