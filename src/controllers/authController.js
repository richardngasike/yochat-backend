const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/database');

// Generate 6-digit OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// Send OTP via Twilio (or console in dev)
const sendOTP = async (phone, code) => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`📱 OTP for ${phone}: ${code}`);
    return true;
  }
  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilio.messages.create({
      body: `Your WaveChat verification code is: ${code}. Valid for 10 minutes.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    });
    return true;
  } catch (err) {
    console.error('SMS Error:', err);
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

  // Validate phone format
  if (fullPhone.length < 7 || fullPhone.length > 16) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  try {
    // Invalidate old OTPs
    await query('UPDATE otp_codes SET verified = TRUE WHERE phone = $1 AND verified = FALSE', [fullPhone]);

    const code = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await query(
      'INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, $3)',
      [fullPhone, code, expiresAt]
    );

    await sendOTP(fullPhone, code);

    // Check if user exists
    const userResult = await query('SELECT id FROM users WHERE phone = $1', [fullPhone]);
    const isNewUser = userResult.rows.length === 0;

    res.json({ success: true, message: 'OTP sent successfully', is_new_user: isNewUser });
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

  const fullPhone = `${country_code}${phone.replace(/\D/g, '')}`;

  try {
    // Find valid OTP
    const otpResult = await query(
      'SELECT * FROM otp_codes WHERE phone = $1 AND verified = FALSE AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [fullPhone]
    );

    if (!otpResult.rows.length) {
      return res.status(400).json({ error: 'OTP expired or not found. Please request a new one.' });
    }

    const otp = otpResult.rows[0];

    if (otp.attempts >= 5) {
      await query('UPDATE otp_codes SET verified = TRUE WHERE id = $1', [otp.id]);
      return res.status(400).json({ error: 'Too many attempts. Please request a new OTP.' });
    }

    if (otp.code !== code) {
      await query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
      return res.status(400).json({ error: 'Invalid OTP code' });
    }

    // Mark OTP as used
    await query('UPDATE otp_codes SET verified = TRUE WHERE id = $1', [otp.id]);

    // Find or create user
    let userResult = await query('SELECT * FROM users WHERE phone = $1', [fullPhone]);
    let user;
    let isNewUser = false;

    if (!userResult.rows.length) {
      isNewUser = true;
      const newUserId = uuidv4();
      const defaultUsername = `user_${newUserId.slice(0, 8)}`;

      userResult = await query(
        `INSERT INTO users (id, phone, country_code, display_name, username, is_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING *`,
        [newUserId, fullPhone, country_code, display_name || 'WaveChat User', username || defaultUsername]
      );

      // Create default settings
      await query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [newUserId]);
      user = userResult.rows[0];
    } else {
      user = userResult.rows[0];
      await query('UPDATE users SET is_verified = TRUE, updated_at = NOW() WHERE id = $1', [user.id]);
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
    res.status(500).json({ error: 'Verification failed' });
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
    await query('UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2', ['offline', req.user.id]);
    res.json({ success: true });
  } catch {
    res.json({ success: true });
  }
};

module.exports = { sendOtpHandler, verifyOtpHandler, refreshToken, logout };
