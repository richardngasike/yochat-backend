const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// GET /api/conversations
const getConversations = async (req, res) => {
  try {
    const result = await query(
      `SELECT
        c.id, c.type, c.name, c.avatar_url, c.last_activity, c.is_archived, c.disappearing_messages,
        cp.is_muted, cp.last_read_at, cp.role,
        m.id as last_message_id, m.content as last_message_content, m.message_type as last_message_type,
        m.created_at as last_message_time, m.sender_id as last_message_sender_id,
        sender.display_name as last_message_sender_name,
        (SELECT COUNT(*) FROM messages msg
         WHERE msg.conversation_id = c.id
         AND msg.created_at > cp.last_read_at
         AND msg.sender_id != $1
         AND msg.is_deleted = FALSE) as unread_count,
        CASE WHEN c.type = 'direct' THEN
          (SELECT json_build_object('id', u.id, 'display_name', u.display_name, 'avatar_url', u.avatar_url, 'status', u.status, 'last_seen', u.last_seen, 'phone', u.phone)
           FROM conversation_participants cp2
           JOIN users u ON u.id = cp2.user_id
           WHERE cp2.conversation_id = c.id AND cp2.user_id != $1 LIMIT 1)
        ELSE NULL END as other_user
       FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
       LEFT JOIN messages m ON m.id = c.last_message_id
       LEFT JOIN users sender ON sender.id = m.sender_id
       WHERE c.is_archived = FALSE
       ORDER BY c.last_activity DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Get conversations error:', err);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
};

// POST /api/conversations/direct
const createDirectConversation = async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const client = await require('../config/database').getClient();
  try {
    await client.query('BEGIN');

    // Check if direct conversation already exists
    const existing = await client.query(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = $1
       JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = $2
       WHERE c.type = 'direct'
       LIMIT 1`,
      [req.user.id, user_id]
    );

    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ id: existing.rows[0].id, existing: true });
    }

    const convId = uuidv4();
    await client.query('INSERT INTO conversations (id, type, created_by) VALUES ($1, $2, $3)', [convId, 'direct', req.user.id]);
    await client.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)', [convId, req.user.id, user_id]);

    await client.query('COMMIT');
    res.json({ id: convId, existing: false });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create conversation' });
  } finally {
    client.release();
  }
};

// POST /api/conversations/group
const createGroupConversation = async (req, res) => {
  const { name, description, participant_ids } = req.body;
  if (!name) return res.status(400).json({ error: 'Group name required' });

  const client = await require('../config/database').getClient();
  try {
    await client.query('BEGIN');

    const convId = uuidv4();
    await client.query(
      'INSERT INTO conversations (id, type, name, description, created_by) VALUES ($1, $2, $3, $4, $5)',
      [convId, 'group', name, description, req.user.id]
    );

    // Add creator as admin
    await client.query(
      'INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, $3)',
      [convId, req.user.id, 'admin']
    );

    // Add other participants
    if (participant_ids && participant_ids.length > 0) {
      for (const pid of participant_ids) {
        if (pid !== req.user.id) {
          await client.query(
            'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [convId, pid]
          );
        }
      }
    }

    await client.query('COMMIT');

    const result = await query('SELECT * FROM conversations WHERE id = $1', [convId]);
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create group' });
  } finally {
    client.release();
  }
};

// GET /api/conversations/:id
const getConversation = async (req, res) => {
  try {
    // Verify user is participant
    const participant = await query(
      'SELECT * FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!participant.rows.length) return res.status(403).json({ error: 'Not a participant' });

    const result = await query(
      `SELECT c.*,
       (SELECT json_agg(json_build_object(
         'id', u.id, 'display_name', u.display_name, 'username', u.username,
         'avatar_url', u.avatar_url, 'status', u.status, 'role', cp2.role, 'phone', u.phone
       )) FROM conversation_participants cp2
       JOIN users u ON u.id = cp2.user_id
       WHERE cp2.conversation_id = c.id) as participants
       FROM conversations c WHERE c.id = $1`,
      [req.params.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Conversation not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// PATCH /api/conversations/:id
const updateConversation = async (req, res) => {
  const { name, description, disappearing_messages } = req.body;
  try {
    const participant = await query(
      'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!participant.rows.length || participant.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can update group info' });
    }

    const result = await query(
      `UPDATE conversations SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        disappearing_messages = COALESCE($3, disappearing_messages),
        updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [name, description, disappearing_messages, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update conversation' });
  }
};

// POST /api/conversations/:id/avatar
const uploadGroupAvatar = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    await query('UPDATE conversations SET avatar_url = $1, updated_at = NOW() WHERE id = $2', [avatarUrl, req.params.id]);
    res.json({ avatar_url: avatarUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
};

// POST /api/conversations/:id/participants
const addParticipant = async (req, res) => {
  const { user_id } = req.body;
  try {
    await query(
      'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, user_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add participant' });
  }
};

// DELETE /api/conversations/:id/participants/:userId
const removeParticipant = async (req, res) => {
  try {
    await query(
      'DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [req.params.id, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove participant' });
  }
};

// PATCH /api/conversations/:id/mute
const muteConversation = async (req, res) => {
  const { mute_until } = req.body;
  try {
    await query(
      'UPDATE conversation_participants SET is_muted = $1, mute_until = $2 WHERE conversation_id = $3 AND user_id = $4',
      [!!mute_until, mute_until || null, req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mute conversation' });
  }
};

// PATCH /api/conversations/:id/archive
const archiveConversation = async (req, res) => {
  const { archive } = req.body;
  try {
    await query('UPDATE conversations SET is_archived = $1 WHERE id = $2', [!!archive, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to archive conversation' });
  }
};

// POST /api/conversations/:id/read
const markAsRead = async (req, res) => {
  try {
    await query(
      'UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
};

// GET /api/conversations/:id/pinned
const getPinnedMessages = async (req, res) => {
  try {
    const result = await query(
      `SELECT pm.*, m.content, m.message_type, m.media_url, m.created_at as message_created_at,
              u.display_name as pinned_by_name, u.avatar_url as pinned_by_avatar
       FROM pinned_messages pm
       JOIN messages m ON m.id = pm.message_id
       JOIN users u ON u.id = pm.pinned_by
       WHERE pm.conversation_id = $1
       ORDER BY pm.pinned_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get pinned messages' });
  }
};

module.exports = {
  getConversations, createDirectConversation, createGroupConversation,
  getConversation, updateConversation, uploadGroupAvatar,
  addParticipant, removeParticipant, muteConversation, archiveConversation,
  markAsRead, getPinnedMessages
};
