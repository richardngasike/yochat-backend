const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// GET /api/stories - Get stories from contacts
const getStories = async (req, res) => {
  try {
    const result = await query(
      `SELECT
        s.id, s.content, s.story_type, s.media_url, s.media_thumbnail, s.background_color,
        s.font_style, s.privacy, s.view_count, s.expires_at, s.created_at,
        u.id as user_id, u.display_name, u.username, u.avatar_url,
        EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id = s.id AND sv.viewer_id = $1) as is_viewed
       FROM stories s
       JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > NOW()
       AND (
         s.user_id = $1
         OR (s.privacy = 'everyone')
         OR (s.privacy = 'contacts' AND EXISTS(
           SELECT 1 FROM contacts c WHERE c.user_id = $1 AND c.contact_id = s.user_id AND c.is_blocked = FALSE
         ))
       )
       ORDER BY s.user_id = $1 DESC, u.display_name ASC, s.created_at DESC`,
      [req.user.id]
    );

    // Group by user
    const grouped = {};
    result.rows.forEach(story => {
      if (!grouped[story.user_id]) {
        grouped[story.user_id] = {
          user_id: story.user_id,
          display_name: story.display_name,
          username: story.username,
          avatar_url: story.avatar_url,
          stories: [],
          has_unseen: false,
        };
      }
      grouped[story.user_id].stories.push(story);
      if (!story.is_viewed && story.user_id !== req.user.id) {
        grouped[story.user_id].has_unseen = true;
      }
    });

    res.json(Object.values(grouped));
  } catch (err) {
    console.error('Get stories error:', err);
    res.status(500).json({ error: 'Failed to get stories' });
  }
};

// POST /api/stories
const createStory = async (req, res) => {
  const { content, story_type = 'text', background_color, font_style, privacy = 'contacts' } = req.body;

  try {
    let mediaUrl = null, mediaThumbnail = null;
    if (req.file) {
      mediaUrl = `/uploads/stories/${req.file.filename}`;
    }

    const storyId = uuidv4();
    const result = await query(
      `INSERT INTO stories (id, user_id, content, story_type, media_url, media_thumbnail, background_color, font_style, privacy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [storyId, req.user.id, content, story_type, mediaUrl, mediaThumbnail, background_color, font_style, privacy]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Create story error:', err);
    res.status(500).json({ error: 'Failed to create story' });
  }
};

// DELETE /api/stories/:id
const deleteStory = async (req, res) => {
  try {
    await query('DELETE FROM stories WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete story' });
  }
};

// POST /api/stories/:id/view
const viewStory = async (req, res) => {
  try {
    await query(
      'INSERT INTO story_views (story_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, req.user.id]
    );
    await query('UPDATE stories SET view_count = view_count + 1 WHERE id = $1 AND user_id != $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record view' });
  }
};

// GET /api/stories/:id/views
const getStoryViews = async (req, res) => {
  try {
    const result = await query(
      `SELECT sv.viewed_at, u.id, u.display_name, u.avatar_url, u.username
       FROM story_views sv
       JOIN users u ON u.id = sv.viewer_id
       JOIN stories s ON s.id = sv.story_id
       WHERE sv.story_id = $1 AND s.user_id = $2
       ORDER BY sv.viewed_at DESC`,
      [req.params.id, req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get views' });
  }
};

// GET /api/stories/my
const getMyStories = async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM stories WHERE user_id = $1 AND expires_at > NOW() ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stories' });
  }
};

module.exports = { getStories, createStory, deleteStory, viewStory, getStoryViews, getMyStories };
