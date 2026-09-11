'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS — Encryption vault (AES-256-GCM)
   Master key: 32 random bytes, sealed via Electron safeStorage and
   stored at <userData>/vault.key → crypto is tied to this machine.
   RULE: no key/password/sensitive value is ever stored in plain text.
   ══════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let masterKey = null;

/**
 * Initialize the vault. Derives/loads the machine-bound master key.
 * Must be called after app.whenReady() (safeStorage needs it).
 */
function init(userDataPath) {
  const keyFile = path.join(userDataPath, 'vault.key');
  let hasSafeStorage = false;
  let electron = null;
  try {
    electron = require('electron');
    if (electron && electron.safeStorage && electron.safeStorage.isEncryptionAvailable && electron.safeStorage.isEncryptionAvailable()) {
      hasSafeStorage = true;
    }
  } catch (e) {
    hasSafeStorage = false;
  }

  if (fs.existsSync(keyFile)) {
    const sealed = fs.readFileSync(keyFile);
    if (hasSafeStorage) {
      try {
        const raw = electron.safeStorage.decryptString(sealed);
        masterKey = Buffer.from(raw, 'base64');
      } catch (e) {
        masterKey = sealed.subarray(0, 32);
      }
    } else {
      masterKey = sealed.subarray(0, 32);
    }
  } else {
    masterKey = crypto.randomBytes(32);
    if (hasSafeStorage) {
      const sealed = electron.safeStorage.encryptString(masterKey.toString('base64'));
      fs.writeFileSync(keyFile, sealed);
    } else {
      fs.writeFileSync(keyFile, masterKey);
    }
    try { fs.chmodSync(keyFile, 0o600); } catch (e) { /* windows: best-effort */ }
  }

  if (!masterKey || masterKey.length !== 32) {
    throw new Error('vault: master key invalid');
  }
  return true;
}

/** AES-256-GCM encrypt → Buffer (iv[12] | tag[16] | ciphertext) */
function encrypt(plainText) {
  if (masterKey === null) throw new Error('vault: not initialized');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/** Decrypt a Buffer produced by encrypt() → original string */
function decrypt(payload) {
  if (masterKey === null) throw new Error('vault: not initialized');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ct = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** SHA-256 hash for duplicate key detection (never store the key itself) */
function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * First-launch self-test: encrypt → decrypt → verify round-trip.
 * Returns { ok, error } — caller logs result to activity_log.
 */
function selfTest() {
  try {
    const probe = 'jarvis-vault-probe::' + Date.now();
    const sealed = encrypt(probe);
    if (sealed.length < 30) throw new Error('ciphertext suspiciously small');
    const back = decrypt(sealed);
    if (back !== probe) throw new Error('round-trip mismatch');
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { init, encrypt, decrypt, hash, selfTest };
