const { query } = require('../config/database');
const path = require('path');
const fs = require('fs');

// GET /api/users/me
const getMe = async (req, res) => {
  try {
    const result = await query(
      `SELECT u.*, s.read_receipts, s.last_seen_visibility, s.profile_photo_visibility, s.about_visibility, s.groups_invite
       FROM users u
       LEFT JOIN user_settings s ON s.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];
    delete user.password_hash;
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// PATCH /api/users/me
const updateProfile = async (req, res) => {
  const { display_name, username, bio, theme_preference, notification_sound, disappearing_messages } = req.body;
  try {
    // Check username uniqueness
    if (username) {
      const existing = await query('SELECT id FROM users WHERE username = $1 AND id != $2', [username, req.user.id]);
      if (existing.rows.length) return res.status(400).json({ error: 'Username already taken' });
    }

    const result = await query(
      `UPDATE users SET
        display_name = COALESCE($1, display_name),
        username = COALESCE($2, username),
        bio = COALESCE($3, bio),
        theme_preference = COALESCE($4, theme_preference),
        notification_sound = COALESCE($5, notification_sound),
        disappearing_messages = COALESCE($6, disappearing_messages),
        updated_at = NOW()
       WHERE id = $7
       RETURNING id, display_name, username, bio, avatar_url, phone, status, theme_preference, notification_sound, disappearing_messages`,
      [display_name, username, bio, theme_preference, notification_sound, disappearing_messages, req.user.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
};

// POST /api/users/avatar
const uploadAvatar = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;

    // Delete old avatar
    const oldResult = await query('SELECT avatar_url FROM users WHERE id = $1', [req.user.id]);
    if (oldResult.rows[0]?.avatar_url && oldResult.rows[0].avatar_url.startsWith('/uploads/')) {
      const oldPath = path.join(__dirname, '../../', oldResult.rows[0].avatar_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    await query('UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2', [avatarUrl, req.user.id]);
    res.json({ avatar_url: avatarUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
};

// GET /api/users/search?q=query
const searchUsers = async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);

  try {
    const result = await query(
      `SELECT id, display_name, username, phone, avatar_url, status, last_seen
       FROM users
       WHERE id != $1 AND (
         display_name ILIKE $2 OR
         username ILIKE $2 OR
         phone ILIKE $2
       ) AND is_verified = TRUE
       LIMIT 20`,
      [req.user.id, `%${q}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed' });
  }
};

// GET /api/users/:id
const getUserById = async (req, res) => {
  try {
    const result = await query(
      `SELECT id, display_name, username, phone, avatar_url, bio, status, last_seen, created_at
       FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/users/contacts
const getContacts = async (req, res) => {
  try {
    const result = await query(
      `SELECT c.id, c.nickname, c.is_blocked, c.is_favorite, c.created_at,
              u.id as user_id, u.display_name, u.username, u.phone, u.avatar_url, u.status, u.last_seen, u.bio
       FROM contacts c
       JOIN users u ON u.id = c.contact_id
       WHERE c.user_id = $1 AND c.is_blocked = FALSE
       ORDER BY u.display_name ASC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get contacts' });
  }
};

// POST /api/users/contacts
const addContact = async (req, res) => {
  const { phone, nickname } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  try {
    const userResult = await query('SELECT id, display_name, username, avatar_url, phone FROM users WHERE phone = $1', [phone]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found with that phone number' });

    const contact = userResult.rows[0];
    if (contact.id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });

    await query(
      'INSERT INTO contacts (user_id, contact_id, nickname) VALUES ($1, $2, $3) ON CONFLICT (user_id, contact_id) DO UPDATE SET nickname = $3',
      [req.user.id, contact.id, nickname || contact.display_name]
    );

    res.json({ success: true, contact });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add contact' });
  }
};

// PATCH /api/users/contacts/:id/block
const blockContact = async (req, res) => {
  const { block } = req.body;
  try {
    await query(
      'UPDATE contacts SET is_blocked = $1 WHERE user_id = $2 AND contact_id = $3',
      [block !== false, req.user.id, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update block status' });
  }
};

// PATCH /api/users/settings
const updateSettings = async (req, res) => {
  const { read_receipts, last_seen_visibility, profile_photo_visibility, about_visibility, groups_invite } = req.body;
  try {
    await query(
      `INSERT INTO user_settings (user_id, read_receipts, last_seen_visibility, profile_photo_visibility, about_visibility, groups_invite)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         read_receipts = COALESCE($2, user_settings.read_receipts),
         last_seen_visibility = COALESCE($3, user_settings.last_seen_visibility),
         profile_photo_visibility = COALESCE($4, user_settings.profile_photo_visibility),
         about_visibility = COALESCE($5, user_settings.about_visibility),
         groups_invite = COALESCE($6, user_settings.groups_invite),
         updated_at = NOW()`,
      [req.user.id, read_receipts, last_seen_visibility, profile_photo_visibility, about_visibility, groups_invite]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
};

// PATCH /api/users/status
const updateStatus = async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['online', 'offline', 'away', 'busy'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    await query('UPDATE users SET status = $1, last_seen = NOW(), updated_at = NOW() WHERE id = $2', [status, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
};

module.exports = { getMe, updateProfile, uploadAvatar, searchUsers, getUserById, getContacts, addContact, blockContact, updateSettings, updateStatus };
