const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { upload } = require('../controllers/mediaController');
const {
  getMe, updateProfile, uploadAvatar, searchUsers, getUserById,
  getContacts, addContact, blockContact, updateSettings, updateStatus
} = require('../controllers/usersController');

router.get('/me', authenticate, getMe);
router.patch('/me', authenticate, updateProfile);
router.post('/me/avatar', authenticate, upload.single('avatar'), uploadAvatar);
router.patch('/me/status', authenticate, updateStatus);
router.patch('/me/settings', authenticate, updateSettings);
router.get('/search', authenticate, searchUsers);
router.get('/contacts', authenticate, getContacts);
router.post('/contacts', authenticate, addContact);
router.patch('/contacts/:id/block', authenticate, blockContact);
router.get('/:id', authenticate, getUserById);

module.exports = router;
