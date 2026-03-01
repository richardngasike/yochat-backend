require('dotenv').config();
const { pool } = require('./database');

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) UNIQUE NOT NULL,
        country_code VARCHAR(5) NOT NULL,
        username VARCHAR(50) UNIQUE,
        email VARCHAR(255) UNIQUE,
        google_id VARCHAR(255) UNIQUE,
        display_name VARCHAR(100),
        bio TEXT DEFAULT '',
        avatar_url TEXT,
        status VARCHAR(20) DEFAULT 'offline',
        last_seen TIMESTAMP DEFAULT NOW(),
        is_verified BOOLEAN DEFAULT FALSE,
        two_factor_enabled BOOLEAN DEFAULT FALSE,
        disappearing_messages INTEGER DEFAULT 0,
        theme_preference VARCHAR(20) DEFAULT 'system',
        notification_sound VARCHAR(50) DEFAULT 'default',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // OTP table
    await client.query(`
      CREATE TABLE IF NOT EXISTS otp_codes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) NOT NULL,
        code VARCHAR(6) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        verified BOOLEAN DEFAULT FALSE,
        attempts INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Contacts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        contact_id UUID REFERENCES users(id) ON DELETE CASCADE,
        nickname VARCHAR(100),
        is_blocked BOOLEAN DEFAULT FALSE,
        is_favorite BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, contact_id)
      )
    `);

    // Conversations table
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type VARCHAR(20) DEFAULT 'direct',
        name VARCHAR(100),
        description TEXT,
        avatar_url TEXT,
        created_by UUID REFERENCES users(id),
        last_message_id UUID,
        last_activity TIMESTAMP DEFAULT NOW(),
        is_archived BOOLEAN DEFAULT FALSE,
        disappearing_messages INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Conversation participants
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversation_participants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(20) DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT NOW(),
        last_read_at TIMESTAMP DEFAULT NOW(),
        is_muted BOOLEAN DEFAULT FALSE,
        mute_until TIMESTAMP,
        notifications_enabled BOOLEAN DEFAULT TRUE,
        UNIQUE(conversation_id, user_id)
      )
    `);

    // Messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
        content TEXT,
        message_type VARCHAR(20) DEFAULT 'text',
        media_url TEXT,
        media_thumbnail TEXT,
        media_size BIGINT,
        media_name TEXT,
        media_duration INTEGER,
        reply_to_id UUID REFERENCES messages(id),
        forwarded_from_id UUID,
        is_edited BOOLEAN DEFAULT FALSE,
        is_deleted BOOLEAN DEFAULT FALSE,
        deleted_for JSONB DEFAULT '[]',
        reactions JSONB DEFAULT '{}',
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Message receipts (read receipts)
    await client.query(`
      CREATE TABLE IF NOT EXISTS message_receipts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'delivered',
        read_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(message_id, user_id)
      )
    `);

    // Stories table
    await client.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        content TEXT,
        story_type VARCHAR(20) DEFAULT 'text',
        media_url TEXT,
        media_thumbnail TEXT,
        background_color VARCHAR(20),
        font_style VARCHAR(50),
        privacy VARCHAR(20) DEFAULT 'contacts',
        view_count INTEGER DEFAULT 0,
        expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '24 hours'),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Story views
    await client.query(`
      CREATE TABLE IF NOT EXISTS story_views (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        story_id UUID REFERENCES stories(id) ON DELETE CASCADE,
        viewer_id UUID REFERENCES users(id) ON DELETE CASCADE,
        viewed_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(story_id, viewer_id)
      )
    `);

    // Calls table
    await client.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        caller_id UUID REFERENCES users(id),
        callee_id UUID REFERENCES users(id),
        conversation_id UUID REFERENCES conversations(id),
        call_type VARCHAR(20) DEFAULT 'voice',
        status VARCHAR(20) DEFAULT 'initiated',
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        duration INTEGER DEFAULT 0
      )
    `);

    // User settings
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        read_receipts BOOLEAN DEFAULT TRUE,
        last_seen_visibility VARCHAR(20) DEFAULT 'everyone',
        profile_photo_visibility VARCHAR(20) DEFAULT 'everyone',
        about_visibility VARCHAR(20) DEFAULT 'everyone',
        groups_invite VARCHAR(20) DEFAULT 'everyone',
        live_location BOOLEAN DEFAULT FALSE,
        storage_usage BIGINT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Pinned messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS pinned_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
        pinned_by UUID REFERENCES users(id),
        pinned_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(conversation_id, message_id)
      )
    `);

    // Create indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_stories_user ON stories(user_id, expires_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_participants_user ON conversation_participants(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone, expires_at)`);

    await client.query('COMMIT');
    console.log('✅ Database migration completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

migrate().catch(console.error);
