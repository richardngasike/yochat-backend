const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { upload } = require('../controllers/mediaController');
const { getMessages, sendMessage, editMessage, deleteMessage, starMessage, reactToMessage, pinMessage, searchMessages } = require('../controllers/messagesController');

router.get('/:conversationId', authenticate, getMessages);
router.get('/:conversationId/search', authenticate, searchMessages);
router.post('/', authenticate, upload.single('media'), sendMessage);
router.patch('/:id', authenticate, editMessage);
router.delete('/:id', authenticate, deleteMessage);
router.post('/:id/react', authenticate, reactToMessage);
router.post('/:id/pin', authenticate, pinMessage);

module.exports = router;
