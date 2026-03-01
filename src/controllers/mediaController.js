const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let subdir = 'images';
    const mime = file.mimetype;
    if (mime.startsWith('video/')) subdir = 'videos';
    else if (mime.startsWith('audio/')) subdir = 'audio';
    else if (!mime.startsWith('image/')) subdir = 'documents';

    if (req.path && req.path.includes('story')) subdir = 'stories';
    if (req.path && req.path.includes('avatar')) subdir = 'avatars';

    const dest = path.join(UPLOAD_DIR, subdir);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    req._uploadSubdir = subdir;
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv',
    'application/zip',
  ];

  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} not allowed`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

// GET /api/media/storage
const getStorageInfo = async (req, res) => {
  const { query } = require('../config/database');
  try {
    const result = await query(
      'SELECT COALESCE(SUM(media_size), 0) as total FROM messages WHERE sender_id = $1 AND media_url IS NOT NULL',
      [req.user.id]
    );
    res.json({ used: parseInt(result.rows[0].total), limit: 500 * 1024 * 1024 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get storage info' });
  }
};

module.exports = { upload, getStorageInfo };
