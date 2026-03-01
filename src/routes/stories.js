const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { upload } = require('../controllers/mediaController');
const { getStories, createStory, deleteStory, viewStory, getStoryViews, getMyStories } = require('../controllers/storiesController');

router.get('/', authenticate, getStories);
router.get('/my', authenticate, getMyStories);
router.post('/', authenticate, upload.single('media'), createStory);
router.delete('/:id', authenticate, deleteStory);
router.post('/:id/view', authenticate, viewStory);
router.get('/:id/views', authenticate, getStoryViews);

module.exports = router;
