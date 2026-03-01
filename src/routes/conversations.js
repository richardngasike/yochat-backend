const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { upload } = require('../controllers/mediaController');
const {
  getConversations, createDirectConversation, createGroupConversation,
  getConversation, updateConversation, uploadGroupAvatar,
  addParticipant, removeParticipant, muteConversation, archiveConversation,
  markAsRead, getPinnedMessages
} = require('../controllers/conversationsController');

router.get('/', authenticate, getConversations);
router.post('/direct', authenticate, createDirectConversation);
router.post('/group', authenticate, createGroupConversation);
router.get('/:id', authenticate, getConversation);
router.patch('/:id', authenticate, updateConversation);
router.post('/:id/avatar', authenticate, upload.single('avatar'), uploadGroupAvatar);
router.post('/:id/participants', authenticate, addParticipant);
router.delete('/:id/participants/:userId', authenticate, removeParticipant);
router.patch('/:id/mute', authenticate, muteConversation);
router.patch('/:id/archive', authenticate, archiveConversation);
router.post('/:id/read', authenticate, markAsRead);
router.get('/:id/pinned', authenticate, getPinnedMessages);

module.exports = router;
