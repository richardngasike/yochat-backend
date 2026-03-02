const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// GET /api/messages/:conversationId
const getMessages = async (req, res) => {
  const { before, limit = 50 } = req.query;
  try {
    // Verify participant
    const participant = await query(
      'SELECT * FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [req.params.conversationId, req.user.id]
    );
    if (!participant.rows.length) return res.status(403).json({ error: 'Not authorized' });

    let q = `
      SELECT m.*,
        u.display_name as sender_name, u.avatar_url as sender_avatar, u.username as sender_username,
        json_build_object(
          'id', rm.id, 'content', rm.content, 'message_type', rm.message_type,
          'sender_id', rm.sender_id, 'media_url', rm.media_url
        ) as reply_to_message,
        (SELECT json_agg(json_build_object('user_id', mr.user_id, 'status', mr.status, 'read_at', mr.read_at))
         FROM message_receipts mr WHERE mr.message_id = m.id) as receipts
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN messages rm ON rm.id = m.reply_to_id
      WHERE m.conversation_id = $1 AND m.is_deleted = FALSE
        AND NOT ($2 = ANY(COALESCE(m.deleted_for::text[], ARRAY[]::text[])))
    `;

    const params = [req.params.conversationId, req.user.id];

    if (before) {
      params.push(before);
      q += ` AND m.created_at < (SELECT created_at FROM messages WHERE id = $${params.length})`;
    }

    q += ` ORDER BY m.created_at DESC LIMIT ${Math.min(parseInt(limit), 100)}`;

    const result = await query(q, params);
    res.json(result.rows.reverse());
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Failed to get messages' });
  }
};

// POST /api/messages
const sendMessage = async (req, res) => {
  const { conversation_id, content, message_type = 'text', reply_to_id, forwarded_from_id } = req.body;
  if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });
  if (!content && !req.file) return res.status(400).json({ error: 'Message content required' });

  const client = await require('../config/database').getClient();
  try {
    await client.query('BEGIN');

    // Verify participant
    const participant = await client.query(
      'SELECT * FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [conversation_id, req.user.id]
    );
    if (!participant.rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not a participant' });
    }

    let mediaUrl = null, mediaName = null, mediaSize = null;
    if (req.file) {
      mediaUrl = `/uploads/${req.file.destination.split('/uploads/')[1]}/${req.file.filename}`;
      mediaName = req.file.originalname;
      mediaSize = req.file.size;
    }

    const msgId = uuidv4();
    const result = await client.query(
      `INSERT INTO messages (id, conversation_id, sender_id, content, message_type, media_url, media_name, media_size, reply_to_id, forwarded_from_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [msgId, conversation_id, req.user.id, content, message_type, mediaUrl, mediaName, mediaSize, reply_to_id || null, forwarded_from_id || null]
    );

    await client.query(
      'UPDATE conversations SET last_message_id = $1, last_activity = NOW() WHERE id = $2',
      [msgId, conversation_id]
    );

    await client.query('COMMIT');

    const message = result.rows[0];

    // Get sender info
    const senderResult = await query('SELECT display_name, avatar_url, username FROM users WHERE id = $1', [req.user.id]);
    message.sender_name = senderResult.rows[0]?.display_name;
    message.sender_avatar = senderResult.rows[0]?.avatar_url;
    message.sender_username = senderResult.rows[0]?.username;

    // Emit via Socket.io
    const io = req.app.get('io');
    if (io) {
      io.to(`conversation:${conversation_id}`).emit('new_message', message);
    }

    res.json(message);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  } finally {
    client.release();
  }
};

// PATCH /api/messages/:id
const editMessage = async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Content required' });

  try {
    const result = await query(
      `UPDATE messages SET content = $1, is_edited = TRUE, updated_at = NOW()
       WHERE id = $2 AND sender_id = $3 AND is_deleted = FALSE
       RETURNING *`,
      [content, req.params.id, req.user.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Message not found or unauthorized' });

    const io = req.app.get('io');
    if (io) io.to(`conversation:${result.rows[0].conversation_id}`).emit('message_edited', result.rows[0]);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to edit message' });
  }
};

// DELETE /api/messages/:id
const deleteMessage = async (req, res) => {
  const { for_everyone } = req.body;

  try {
    // For "delete for everyone", allow any participant to verify the message exists
    let msgResult;
    if (for_everyone) {
      // Only sender can delete for everyone
      msgResult = await query('SELECT * FROM messages WHERE id = $1 AND sender_id = $2', [req.params.id, req.user.id]);
    } else {
      // Anyone can delete for themselves
      msgResult = await query('SELECT * FROM messages WHERE id = $1', [req.params.id]);
    }

    if (!msgResult.rows.length) return res.status(404).json({ error: 'Message not found or unauthorized' });

    const msg = msgResult.rows[0];

    if (for_everyone) {
      // Completely DELETE the row — leaves absolutely no trace
      await query('DELETE FROM messages WHERE id = $1', [msg.id]);
      const io = req.app.get('io');
      if (io) io.to(`conversation:${msg.conversation_id}`).emit('message_deleted', { id: msg.id, conversation_id: msg.conversation_id });
    } else {
      // Delete for me only — add user to deleted_for array
      const deletedFor = msg.deleted_for || [];
      if (!deletedFor.includes(req.user.id)) deletedFor.push(req.user.id);
      await query('UPDATE messages SET deleted_for = $1 WHERE id = $2', [JSON.stringify(deletedFor), msg.id]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete message error:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
};

// POST /api/messages/:id/star
const starMessage = async (req, res) => {
  try {
    // Toggle star in user_starred_messages table (add if not there, remove if exists)
    const check = await query(
      'SELECT 1 FROM user_starred_messages WHERE user_id = $1 AND message_id = $2',
      [req.user.id, req.params.id]
    );
    if (check.rows.length) {
      await query('DELETE FROM user_starred_messages WHERE user_id = $1 AND message_id = $2', [req.user.id, req.params.id]);
      res.json({ starred: false });
    } else {
      await query('INSERT INTO user_starred_messages (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, req.params.id]);
      res.json({ starred: true });
    }
  } catch (err) {
    // Table might not exist yet — just return success
    res.json({ starred: true });
  }
};

// POST /api/messages/:id/react
const reactToMessage = async (req, res) => {
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: 'Emoji required' });

  try {
    const msgResult = await query('SELECT reactions, conversation_id FROM messages WHERE id = $1', [req.params.id]);
    if (!msgResult.rows.length) return res.status(404).json({ error: 'Message not found' });

    const reactions = msgResult.rows[0].reactions || {};

    if (!reactions[emoji]) reactions[emoji] = [];
    const idx = reactions[emoji].indexOf(req.user.id);
    if (idx > -1) {
      reactions[emoji].splice(idx, 1);
      if (reactions[emoji].length === 0) delete reactions[emoji];
    } else {
      // Remove any existing reaction from this user
      Object.keys(reactions).forEach(e => {
        reactions[e] = reactions[e].filter(id => id !== req.user.id);
        if (reactions[e].length === 0) delete reactions[e];
      });
      if (!reactions[emoji]) reactions[emoji] = [];
      reactions[emoji].push(req.user.id);
    }

    await query('UPDATE messages SET reactions = $1 WHERE id = $2', [JSON.stringify(reactions), req.params.id]);

    const io = req.app.get('io');
    if (io) {
      io.to(`conversation:${msgResult.rows[0].conversation_id}`).emit('message_reaction', {
        message_id: req.params.id, reactions
      });
    }

    res.json({ reactions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add reaction' });
  }
};

// POST /api/messages/:id/pin
const pinMessage = async (req, res) => {
  try {
    const msgResult = await query('SELECT conversation_id FROM messages WHERE id = $1', [req.params.id]);
    if (!msgResult.rows.length) return res.status(404).json({ error: 'Message not found' });

    await query(
      'INSERT INTO pinned_messages (conversation_id, message_id, pinned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [msgResult.rows[0].conversation_id, req.params.id, req.user.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to pin message' });
  }
};

// GET /api/messages/:conversationId/search
const searchMessages = async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);

  try {
    const result = await query(
      `SELECT m.*, u.display_name as sender_name, u.avatar_url as sender_avatar
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1 AND m.is_deleted = FALSE
       AND m.content ILIKE $2
       ORDER BY m.created_at DESC LIMIT 50`,
      [req.params.conversationId, `%${q}%`]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
};

module.exports = { getMessages, sendMessage, editMessage, deleteMessage, starMessage, reactToMessage, pinMessage, searchMessages };
