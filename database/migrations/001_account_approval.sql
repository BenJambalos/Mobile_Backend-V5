-- =====================================================================
-- 001_account_approval.sql
-- Super Admin account approval for HyQual.
--
-- Run this ONCE against an EXISTING database (local or Railway MySQL).
-- It only ALTERs two columns on the existing `accounts` table — no new
-- tables, no data is deleted, and every existing account keeps working.
--
-- BEFORE YOU RUN IT, check what your live database actually has:
--
--     SHOW COLUMNS FROM accounts WHERE Field IN ('role', 'status');
--
-- This script assumes the values from database/schema.sql:
--     role   = 'admin','farm_owner'
--     status = 'active','disabled','suspended'
-- If your live columns already contain extra values (for example you
-- already added 'super_admin' by hand), put those values in the lists
-- below too — MODIFY COLUMN replaces the whole list, and MySQL will
-- refuse the change if an existing row holds a value that is missing.
--
-- What changes
--   accounts.role    + 'super_admin'          (existing roles kept)
--   accounts.status  + 'pending', 'rejected'  (existing values kept)
--   accounts.status  default is now 'pending' so a future code path
--                    can never auto-approve an account by accident.
--
-- Status mapping used by the API (so the existing 'active' value is
-- reused instead of adding a duplicate 'approved'):
--     pending  -> PENDING
--     active   -> APPROVED
--     rejected -> REJECTED
--
-- New values are appended at the END of each ENUM, so existing rows are
-- not rewritten.
-- =====================================================================

ALTER TABLE accounts
  MODIFY COLUMN role   ENUM('admin', 'farm_owner', 'super_admin') NOT NULL DEFAULT 'farm_owner',
  MODIFY COLUMN status ENUM('active', 'disabled', 'suspended', 'pending', 'rejected') NOT NULL DEFAULT 'pending';

-- Existing accounts (including the demo farmer) were created before
-- approval existed and are already 'active' = APPROVED. Nothing to do.

-- ---------------------------------------------------------------------
-- Super Admin account
-- You said you are creating the Super Admin yourself. If you create it
-- with SQL, it must be role 'super_admin' AND status 'active', e.g.:
--
--   INSERT INTO accounts (username, password_hash, role, status)
--   VALUES ('superadmin@yourdomain', '<bcrypt hash>', 'super_admin', 'active');
--   INSERT INTO user_profiles (account_id, first_name, last_name, email)
--   VALUES (LAST_INSERT_ID(), 'Super', 'Admin', 'superadmin@yourdomain');
--
-- (The password_hash must be a bcrypt hash — the login route uses
-- bcryptjs. Do not store a plain password.)
-- ---------------------------------------------------------------------
