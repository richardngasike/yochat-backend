const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/database');

// ── Generate 6-digit OTP ──────────────────────────────────────────────────────
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// ── Send OTP via Twilio ───────────────────────────────────────────────────────
const sendSMS = async (toPhone, code) => {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken  = (process.env.TWILIO_AUTH_TOKEN  || '').trim();
  const fromPhone  = (process.env.TWILIO_PHONE_NUMBER|| '').trim();

  // Always print to server console so developers can test without Twilio
  console.log('\n┌─────────────────────────────────────┐');
  console.log(`│  📱 OTP for ${toPhone}`);
  console.log(`│  CODE: ${code}`);
  console.log('└─────────────────────────────────────┘\n');

  // Detect placeholder / missing credentials — skip Twilio gracefully
  const isConfigured =
    accountSid &&
    authToken &&
    fromPhone &&
    accountSid.startsWith('AC') &&
    accountSid.length > 20 &&
    !accountSid.includes('xxx') &&
    authToken !== 'your_twilio_auth_token' &&
    fromPhone !== '+1234567890';

  if (!isConfigured) {
    console.warn('⚠️  Twilio not configured. OTP printed to console above.');
    console.warn('   Fill in TWILIO_* values in backend/.env to send real SMS.\n');
    return { success: true, method: 'console' };
  }

  // ── Real Twilio send ──────────────────────────────────────────────────────
  try {
    const twilio = require('twilio')(accountSid, authToken);
    const message = await twilio.messages.create({
      body: `Your WaveChat verification code is: ${code}\n\nValid for 10 minutes. Do not share this code.`,
      from: fromPhone,
      to: toPhone,
    });
    console.log(`✅ SMS sent! SID: ${message.sid}`);
    return { success: true, method: 'sms', sid: message.sid };
  } catch (err) {
    // Log the full Twilio error so developer can debug
    console.error('❌ Twilio error:', err.message);
    console.error('   Code:', err.code, '| Status:', err.status);
    // Return failure — caller will return 500 to client
    return { success: false, error: err.message };
  }
};

// ── POST /api/auth/send-otp ───────────────────────────────────────────────────
const sendOtpHandler = async (req, res) => {
  try {
    const { phone, country_code } = req.body;

    if (!phone || !country_code) {
      return res.status(400).json({ error: 'Phone number and country code are required' });
    }

    // Build E.164 phone: strip everything except digits from the local part
    const localDigits = phone.replace(/\D/g, '');
    const fullPhone   = `${country_code.trim()}${localDigits}`;

    if (fullPhone.length < 8 || fullPhone.length > 16) {
      return res.status(400).json({ error: 'Invalid phone number length' });
    }

    // Invalidate any previous unused OTPs for this number
    await query(
      `UPDATE otp_codes SET verified = TRUE
       WHERE phone = $1 AND verified = FALSE`,
      [fullPhone]
    );

    const code      = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await query(
      `INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, $3)`,
      [fullPhone, code, expiresAt]
    );

    // Attempt to send — don't block registration if SMS fails in dev
    const result = await sendSMS(fullPhone, code);

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to send SMS. Check Twilio credentials in backend/.env',
      });
    }

    const userRow   = await query('SELECT id FROM users WHERE phone = $1', [fullPhone]);
    const isNewUser = userRow.rows.length === 0;

    return res.json({
      success: true,
      message: result.method === 'sms' ? 'Code sent via SMS' : 'Code printed to server console (Twilio not configured)',
      is_new_user: isNewUser,
      // Only expose delivery method in non-production so front-end can show a hint
      delivery: process.env.NODE_ENV !== 'production' ? result.method : undefined,
    });
  } catch (err) {
    console.error('send-otp error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
};

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────
const verifyOtpHandler = async (req, res) => {
  try {
    const { phone, country_code, code, display_name } = req.body;

    if (!phone || !country_code || !code) {
      return res.status(400).json({ error: 'Phone, country code, and code are required' });
    }

    const localDigits = phone.replace(/\D/g, '');
    const fullPhone   = `${country_code.trim()}${localDigits}`;
    const trimmedCode = String(code).trim();

    // Fetch the most recent valid OTP
    const otpResult = await query(
      `SELECT * FROM otp_codes
       WHERE phone     = $1
         AND verified  = FALSE
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [fullPhone]
    );

    if (!otpResult.rows.length) {
      return res.status(400).json({
        error: 'Code has expired or was not found. Please request a new one.',
      });
    }

    const otp = otpResult.rows[0];

    if (otp.attempts >= 5) {
      await query('UPDATE otp_codes SET verified = TRUE WHERE id = $1', [otp.id]);
      return res.status(400).json({
        error: 'Too many failed attempts. Please request a new code.',
      });
    }

    // ── Compare ───────────────────────────────────────────────────────────────
    if (otp.code.trim() !== trimmedCode) {
      await query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
      const left = 5 - (otp.attempts + 1);
      return res.status(400).json({
        error: `Incorrect code. ${left} attempt${left !== 1 ? 's' : ''} remaining.`,
      });
    }

    // ✅ Valid — mark as used
    await query('UPDATE otp_codes SET verified = TRUE WHERE id = $1', [otp.id]);

    // ── Find or create user ───────────────────────────────────────────────────
    let userResult = await query('SELECT * FROM users WHERE phone = $1', [fullPhone]);
    let user;
    let isNewUser = false;

    if (!userResult.rows.length) {
      isNewUser          = true;
      const newId        = uuidv4();
      const defaultUname = `user_${newId.slice(0, 8)}`;

      const ins = await query(
        `INSERT INTO users
           (id, phone, country_code, display_name, username, is_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING *`,
        [newId, fullPhone, country_code.trim(), display_name || 'WaveChat User', defaultUname]
      );

      await query(
        'INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [newId]
      );

      user = ins.rows[0];
    } else {
      user = userResult.rows[0];
      await query(
        'UPDATE users SET is_verified = TRUE, updated_at = NOW() WHERE id = $1',
        [user.id]
      );
    }

    const token = jwt.sign(
      { userId: user.id, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    return res.json({
      success: true,
      token,
      user: {
        id:           user.id,
        phone:        user.phone,
        country_code: user.country_code,
        username:     user.username,
        display_name: user.display_name,
        avatar_url:   user.avatar_url,
        bio:          user.bio,
        is_verified:  true,
      },
      is_new_user: isNewUser,
    });
  } catch (err) {
    console.error('verify-otp error:', err);
    return res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
};

// ── POST /api/auth/google ─────────────────────────────────────────────────────
const googleAuthHandler = async (req, res) => {
  try {
    const { id_token } = req.body;
    if (!id_token) return res.status(400).json({ error: 'Google id_token required' });

    // Verify Google token
    const { OAuth2Client } = require('google-auth-library');
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(500).json({ error: 'Google auth not configured on server' });

    const client  = new OAuth2Client(clientId);
    const ticket  = await client.verifyIdToken({ idToken: id_token, audience: clientId });
    const payload = ticket.getPayload();

    const { sub: googleId, email, name, picture } = payload;

    if (!email) return res.status(400).json({ error: 'Google account has no email' });

    // Find existing user by google_id or email
    let userResult = await query(
      `SELECT * FROM users WHERE google_id = $1 OR email = $2 LIMIT 1`,
      [googleId, email]
    );

    let user;
    let isNewUser = false;

    if (!userResult.rows.length) {
      isNewUser      = true;
      const newId    = uuidv4();
      const username = `user_${newId.slice(0, 8)}`;

      const ins = await query(
        `INSERT INTO users
           (id, email, google_id, display_name, username, avatar_url, is_verified, phone, country_code)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8)
         RETURNING *`,
        [newId, email, googleId, name || 'WaveChat User', username, picture || null, email, '']
      );

      await query(
        'INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [newId]
      );

      user = ins.rows[0];
    } else {
      user = userResult.rows[0];
      // Update google fields if signing in via Google for first time
      await query(
        `UPDATE users SET google_id = $1, avatar_url = COALESCE(avatar_url, $2),
         is_verified = TRUE, updated_at = NOW() WHERE id = $3`,
        [googleId, picture, user.id]
      );
    }

    const token = jwt.sign(
      { userId: user.id, phone: user.phone || user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    return res.json({
      success: true,
      token,
      user: {
        id:           user.id,
        phone:        user.phone,
        email:        user.email,
        country_code: user.country_code,
        username:     user.username,
        display_name: user.display_name,
        avatar_url:   picture || user.avatar_url,
        bio:          user.bio,
        is_verified:  true,
      },
      is_new_user: isNewUser,
    });
  } catch (err) {
    console.error('Google auth error:', err);
    return res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
  }
};

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
const refreshToken = async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    const result  = await query('SELECT id, phone FROM users WHERE id = $1', [decoded.userId]);
    if (!result.rows.length) return res.status(401).json({ error: 'User not found' });

    const newToken = jwt.sign(
      { userId: result.rows[0].id, phone: result.rows[0].phone },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    return res.json({ token: newToken });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
const logout = async (req, res) => {
  try {
    await query(
      'UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2',
      ['offline', req.user.id]
    );
  } catch {}
  return res.json({ success: true });
};

module.exports = { sendOtpHandler, verifyOtpHandler, googleAuthHandler, refreshToken, logout };
