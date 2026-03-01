const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

const connectedUsers = new Map(); // userId -> Set of socketIds

const initSocket = (io) => {
  // Auth middleware for socket
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const result = await query('SELECT id, display_name, avatar_url, phone FROM users WHERE id = $1', [decoded.userId]);
      if (!result.rows.length) return next(new Error('User not found'));

      socket.user = result.rows[0];
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.user.id;
    console.log(`🔌 User ${socket.user.display_name} connected (${socket.id})`);

    // Track connected users
    if (!connectedUsers.has(userId)) connectedUsers.set(userId, new Set());
    connectedUsers.get(userId).add(socket.id);

    // Join user room
    socket.join(`user:${userId}`);

    // Update status to online
    await query('UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2', ['online', userId]);
    io.emit('user_status', { user_id: userId, status: 'online', last_seen: new Date() });

    // Join conversation rooms
    try {
      const conversations = await query(
        'SELECT conversation_id FROM conversation_participants WHERE user_id = $1',
        [userId]
      );
      conversations.rows.forEach(row => socket.join(`conversation:${row.conversation_id}`));
    } catch (err) {
      console.error('Error joining conversation rooms:', err);
    }

    // Handle joining conversation
    socket.on('join_conversation', (conversationId) => {
      socket.join(`conversation:${conversationId}`);
    });

    // Handle leaving conversation
    socket.on('leave_conversation', (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
    });

    // Handle typing indicators
    socket.on('typing_start', async ({ conversation_id }) => {
      socket.to(`conversation:${conversation_id}`).emit('user_typing', {
        user_id: userId,
        display_name: socket.user.display_name,
        conversation_id,
      });
    });

    socket.on('typing_stop', async ({ conversation_id }) => {
      socket.to(`conversation:${conversation_id}`).emit('user_stop_typing', {
        user_id: userId,
        conversation_id,
      });
    });

    // Handle message read
    socket.on('message_read', async ({ message_id, conversation_id }) => {
      try {
        await query(
          `INSERT INTO message_receipts (message_id, user_id, status, read_at)
           VALUES ($1, $2, 'read', NOW())
           ON CONFLICT (message_id, user_id) DO UPDATE SET status = 'read', read_at = NOW()`,
          [message_id, userId]
        );
        socket.to(`conversation:${conversation_id}`).emit('message_read_receipt', {
          message_id, reader_id: userId, read_at: new Date(),
        });
      } catch (err) {
        console.error('Message read error:', err);
      }
    });

    // Handle WebRTC signaling
    socket.on('call_offer', ({ to, offer, call_id, call_type }) => {
      io.to(`user:${to}`).emit('call_offer', {
        from: userId,
        from_name: socket.user.display_name,
        from_avatar: socket.user.avatar_url,
        offer, call_id, call_type,
      });
    });

    socket.on('call_answer', ({ to, answer, call_id }) => {
      io.to(`user:${to}`).emit('call_answer', { from: userId, answer, call_id });
    });

    socket.on('call_ice_candidate', ({ to, candidate, call_id }) => {
      io.to(`user:${to}`).emit('call_ice_candidate', { from: userId, candidate, call_id });
    });

    socket.on('call_end', ({ to, call_id }) => {
      io.to(`user:${to}`).emit('call_ended', { from: userId, call_id });
    });

    socket.on('call_reject', ({ to, call_id }) => {
      io.to(`user:${to}`).emit('call_rejected', { from: userId, call_id });
    });

    // Handle presence update
    socket.on('update_presence', async ({ status }) => {
      const validStatuses = ['online', 'away', 'busy'];
      if (validStatuses.includes(status)) {
        await query('UPDATE users SET status = $1 WHERE id = $2', [status, userId]);
        io.emit('user_status', { user_id: userId, status, last_seen: new Date() });
      }
    });

    // Disconnect
    socket.on('disconnect', async () => {
      console.log(`🔌 User ${socket.user.display_name} disconnected`);
      const userSockets = connectedUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          connectedUsers.delete(userId);
          // Mark offline after short delay
          setTimeout(async () => {
            if (!connectedUsers.has(userId)) {
              await query('UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2', ['offline', userId]);
              io.emit('user_status', { user_id: userId, status: 'offline', last_seen: new Date() });
            }
          }, 3000);
        }
      }
    });
  });

  return io;
};

module.exports = initSocket;
