const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/database');

// Generate 6-digit OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// Send OTP via Twilio — sends real SMS when credentials are configured
const sendOTP = async (phone, code) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;

  // Always log to console so developers can see it during testing
  console.log(`\n📱 ===========================`);
  console.log(`   OTP for ${phone}: ${code}`);
  console.log(`===========================\n`);

  // Check if Twilio credentials are properly configured (not placeholder values)
  const hasRealCredentials =
    sid && authToken && from &&
    !sid.includes('xxx') &&
    sid !== 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' &&
    sid.startsWith('AC');

  if (!hasRealCredentials) {
    console.warn('⚠️  Twilio not configured — SMS skipped. OTP shown in console above.');
    console.warn('   To enable real SMS: add your Twilio credentials to backend/.env');
    return true;
  }

  // Real Twilio credentials present — send SMS
  try {
    const twilio = require('twilio')(sid, authToken);
    await twilio.messages.create({
      body: `Your WaveChat verification code is: ${code}. Valid for 10 minutes. Do not share this code.`,
      from,
      to: phone,
    });
    console.log(`✅ Real SMS sent to ${phone}`);
    return true;
  } catch (err) {
    console.error('❌ Twilio SMS failed:', err.message);
    // Don't fail the request — user can still get OTP from console in dev
    return false;
  }
};

// POST /api/auth/send-otp
const sendOtpHandler = async (req, res) => {
  const { phone, country_code } = req.body;

  if (!phone || !country_code) {
    return res.status(400).json({ error: 'Phone number and country code are required' });
  }

  const fullPhone = `${country_code}${phone.replace(/\D/g, '')}`;

  if (fullPhone.length < 7 || fullPhone.length > 16) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  try {
    // Invalidate any existing unused OTPs for this phone
    await query(
      'UPDATE otp_codes SET verified = TRUE WHERE phone = $1 AND verified = FALSE',
      [fullPhone]
    );

    const code = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

    // Store the new OTP
    await query(
      'INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, $3)',
      [fullPhone, code, expiresAt]
    );

    // Attempt to send OTP
    await sendOTP(fullPhone, code);

    const userResult = await query('SELECT id FROM users WHERE phone = $1', [fullPhone]);
    const isNewUser = userResult.rows.length === 0;

    res.json({
      success: true,
      message: 'OTP sent successfully',
      is_new_user: isNewUser,
    });
  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
};

// POST /api/auth/verify-otp
const verifyOtpHandler = async (req, res) => {
  const { phone, country_code, code, display_name, username } = req.body;

  if (!phone || !country_code || !code) {
    return res.status(400).json({ error: 'Phone, country code, and code are required' });
  }

  const trimmedCode = String(code).trim();
  const fullPhone = `${country_code}${phone.replace(/\D/g, '')}`;

  try {
    // Find the most recent valid OTP for this phone number
    const otpResult = await query(
      `SELECT * FROM otp_codes
       WHERE phone = $1
         AND verified = FALSE
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [fullPhone]
    );

    if (!otpResult.rows.length) {
      return res.status(400).json({
        error: 'OTP has expired or was not found. Please request a new code.',
      });
    }

    const otp = otpResult.rows[0];

    // Block after 5 failed attempts
    if (otp.attempts >= 5) {
      await query('UPDATE otp_codes SET verified = TRUE WHERE id = $1', [otp.id]);
      return res.status(400).json({
        error: 'Too many failed attempts. Please request a new code.',
      });
    }

    // Compare codes — both as strings, trimmed
    if (otp.code.trim() !== trimmedCode) {
      await query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
      const remaining = 5 - (otp.attempts + 1);
      return res.status(400).json({
        error: `Invalid code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
      });
    }

    // ✅ Code is correct — mark as verified
    await query('UPDATE otp_codes SET verified = TRUE WHERE id = $1', [otp.id]);

    // Find or create user
    let userResult = await query('SELECT * FROM users WHERE phone = $1', [fullPhone]);
    let user;
    let isNewUser = false;

    if (!userResult.rows.length) {
      isNewUser = true;
      const newUserId = uuidv4();
      const defaultUsername = `user_${newUserId.slice(0, 8)}`;

      const insertResult = await query(
        `INSERT INTO users (id, phone, country_code, display_name, username, is_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING *`,
        [
          newUserId,
          fullPhone,
          country_code,
          display_name || 'WaveChat User',
          username || defaultUsername,
        ]
      );

      await query(
        'INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [newUserId]
      );

      user = insertResult.rows[0];
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

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        phone: user.phone,
        country_code: user.country_code,
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        bio: user.bio,
        is_verified: true,
      },
      is_new_user: isNewUser,
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
};

// POST /api/auth/refresh
const refreshToken = async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    const result = await query('SELECT id, phone FROM users WHERE id = $1', [decoded.userId]);
    if (!result.rows.length) return res.status(401).json({ error: 'User not found' });

    const newToken = jwt.sign(
      { userId: result.rows[0].id, phone: result.rows[0].phone },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({ token: newToken });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// POST /api/auth/logout
const logout = async (req, res) => {
  try {
    await query(
      'UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2',
      ['offline', req.user.id]
    );
    res.json({ success: true });
  } catch {
    res.json({ success: true });
  }
};

module.exports = { sendOtpHandler, verifyOtpHandler, refreshToken, logout };
