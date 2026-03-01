const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// GET /api/calls/history
const getCallHistory = async (req, res) => {
  try {
    const result = await query(
      `SELECT c.*,
        caller.display_name as caller_name, caller.avatar_url as caller_avatar,
        callee.display_name as callee_name, callee.avatar_url as callee_avatar
       FROM calls c
       JOIN users caller ON caller.id = c.caller_id
       JOIN users callee ON callee.id = c.callee_id
       WHERE c.caller_id = $1 OR c.callee_id = $1
       ORDER BY c.started_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get call history' });
  }
};

// POST /api/calls/initiate
const initiateCall = async (req, res) => {
  const { callee_id, call_type = 'voice', conversation_id } = req.body;
  if (!callee_id) return res.status(400).json({ error: 'callee_id required' });

  try {
    const callId = uuidv4();
    const result = await query(
      'INSERT INTO calls (id, caller_id, callee_id, call_type, conversation_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [callId, req.user.id, callee_id, call_type, conversation_id]
    );

    const call = result.rows[0];
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${callee_id}`).emit('incoming_call', {
        call_id: call.id,
        caller_id: req.user.id,
        caller_name: req.user.display_name,
        caller_avatar: req.user.avatar_url,
        call_type,
      });
    }

    res.json(call);
  } catch (err) {
    res.status(500).json({ error: 'Failed to initiate call' });
  }
};

// PATCH /api/calls/:id/status
const updateCallStatus = async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['answered', 'rejected', 'ended', 'missed', 'busy'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    const updates = { status };
    if (status === 'answered') updates.started_at = new Date();
    if (['ended', 'rejected', 'missed'].includes(status)) {
      updates.ended_at = new Date();
    }

    const result = await query(
      'UPDATE calls SET status = $1, ended_at = $2 WHERE id = $3 RETURNING *',
      [status, updates.ended_at || null, req.params.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Call not found' });
    const call = result.rows[0];

    const io = req.app.get('io');
    if (io) {
      const targetId = req.user.id === call.caller_id ? call.callee_id : call.caller_id;
      io.to(`user:${targetId}`).emit('call_status_changed', { call_id: call.id, status });
    }

    res.json(call);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update call status' });
  }
};

module.exports = { getCallHistory, initiateCall, updateCallStatus };
