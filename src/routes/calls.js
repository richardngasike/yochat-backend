const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getCallHistory, initiateCall, updateCallStatus } = require('../controllers/callsController');

router.get('/history', authenticate, getCallHistory);
router.post('/initiate', authenticate, initiateCall);
router.patch('/:id/status', authenticate, updateCallStatus);

module.exports = router;
