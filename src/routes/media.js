const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getStorageInfo } = require('../controllers/mediaController');

router.get('/storage', authenticate, getStorageInfo);

module.exports = router;
