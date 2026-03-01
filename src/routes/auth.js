const router = require('express').Router();
const { sendOtpHandler, verifyOtpHandler, refreshToken, logout } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

router.post('/send-otp', sendOtpHandler);
router.post('/verify-otp', verifyOtpHandler);
router.post('/refresh', refreshToken);
router.post('/logout', authenticate, logout);

module.exports = router;
