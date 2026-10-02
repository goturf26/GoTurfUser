const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } =
require('multer-storage-cloudinary');
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const path = require('path');
const fs = require('fs');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const db = mongoose.connection.db;
if (!db || !mongoose.connection.readyState) {
    throw new Error('MongoDB connection not initialized. Check server.js configuration.');
}

const rzp = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});
// 🎯 CONSTANT FOR ADVANCE PAYMENT
const ADVANCE_PERCENTAGE = 0.30;
// === MODELS (Imported or Recreated for reference) ===
// Assuming these models exist globally or are imported elsewhere
const Booking = mongoose.model('Booking');
const HeldSlot = mongoose.model('HeldSlot');
const User = mongoose.model('User');
const Admin = mongoose.model('Admin');
const generateUniqueInviteCode = async () => {
    let inviteCode;
    let isUnique = false;
    while (!isUnique) {
        inviteCode = `TURF${Math.floor(1000 + Math.random() * 9000)}`;
        const existingUser = await db.collection('users').findOne({ inviteCode });
        if (!existingUser) isUnique = true;
    }
    return inviteCode;
};
const UserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true, trim: true },
    userName: {
        type: String,
        required: true,
        trim: true,
        validate: {
            validator: v => /^[a-zA-Z\s]{2,}$/.test(v),
            message: 'Invalid username: letters & spaces only, min 2 chars'
        }
    },
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
        validate: {
            validator: v => /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/.test(v),
            message: 'Invalid email'
        }
    },
    phone: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        validate: {
            validator: v => /^[6-9]\d{9}$/.test(v),
            message: 'Invalid Indian mobile number'
        },
        set: v => v.startsWith('+91') ? v.slice(3) : v
    },
    password: { type: String, trim: true },
    googleId: { type: String, trim: true, default: '' },
    firebaseUid: { type: String, trim: true, unique: true, sparse: true, default: '' },
    invite: {
        code: { type: String, trim: true, default: '' },
        count: { type: Number, default: 0 },
        cycle: { type: Number, default: 0 },
        points: { type: Number, default: 0 }
    },
    inviteCode: { type: String, trim: true, default: '' },
    upcomingBookings: { type: [Object], default: [] },
    registeredTournaments: { type: [Object], default: [] },
    profileImagePath: { type: String, trim: true, default: '' },
    createdAt: { type: Date, default: Date.now }
}, { collection: 'users' });
const TournamentRegistrationSchema = new mongoose.Schema({
    tournamentId: { type: String, required: true },
    userId: { type: String, required: true },
    teamName: { type: String, required: true },
    captainName: { type: String, required: true },
    captainPhone: { type: String, required: true },
    playerNames: { type: [String], required: true },
    paymentId: { type: String, required: true },
    holdId: { type: String, required: true },
    status: { type: String, default: 'confirmed' },
    registeredAt: { type: Date, default: Date.now }
}, { collection: 'tournamentRegistrations' });
const TournamentRegistration = mongoose.model('TournamentRegistration', TournamentRegistrationSchema);
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'goturf_profiles',

    allowed_formats: [
      'jpg',
      'jpeg',
      'png'
    ]
  }
});
const uploadProfile = multer({
  storage,
  limits: {
     fileSize: 5 * 1024 * 1024
  }
}).single('profileImage');
const handleProfileMulterError = (err, req, res, next) => {
    if (err instanceof multer.MulterError || err) {
        return res.status(400).json({ success: false, message: 'Upload error', error: err.message });
    }
    next();
};
const authenticatePayment = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Missing token' });
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        const user = await db.collection('users').findOne({ firebaseUid: decoded.uid });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        req.user = { userId: user.userId, firebaseUid: decoded.uid, email: user.email, phone: user.phone };
        next();
    } catch (firebaseError) {
        jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
            if (err) return res.status(401).json({ success: false, message: 'Invalid token' });
            const user = await db.collection('users').findOne({ userId: decoded.userId });
            if (!user) return res.status(404).json({ success: false, message: 'User not found' });
            req.user = { userId: user.userId, firebaseUid: user.firebaseUid || '', email: user.email, phone: user.phone };
            next();
        });
    }
};
const authenticateToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Missing token' });
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(401).json({ success: false, message: 'Invalid token' });
        req.user = user;
        next();
    });
};
const authenticateAdmin = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Missing token' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const adminUser = await db.collection('admins').findOne({ userId: decoded.userId });
        if (!adminUser) return res.status(403).json({ success: false, message: 'Admin access required' });
        req.admin = adminUser;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }
};
router.use(cors({
    origin: ['http://10.37.213.206:3000', 'http://10.37.213.206:5000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
// === AUTO-CREATE TURF IF NOT EXISTS ===
async function ensureTurfExists(turfId, turfName) {
    const exists = await db.collection('admins').findOne({ 'currentTurf.id': turfId });
    if (!exists) {
        await db.collection('admins').insertOne({
            name: turfName,
            email: `${turfId}@goturf.com`,
            phone: "0000000000",
            password: await bcrypt.hash("temp123", 10),
            role: "admin",
            currentTurf: {
                id: turfId,
                turfName: turfName,
                state: "Tamil Nadu",
                district: "Madurai",
                sports: ["Cricket"],
                pricePerHour: 700,
                confirmedSlots: [],
                heldSlots: [],
                heldDays: [],
                bookingCount: 0
            }
        });
         
    }
}
// === PUBLIC TURF INFO ===
router.get('/public/turf/:turfId', async (req, res) => {
    try {
        const { turfId } = req.params;
        const adminUser = await db.collection('admins').findOne({ 'currentTurf.id': turfId });
        if (!adminUser?.currentTurf) return res.status(404).json({ success: false, message: 'Turf not found' });
        const turf = adminUser.currentTurf;
        res.json({
            success: true,
            turf: {
                id: turf.id,
                turfName: turf.turfName,
                turfAddress: turf.turfAddress,
                pricePerHour: turf.pricePerHour,
                sports: turf.sports?.join(', ') || '',
                imageUrl: turf.imageUrl || '',
                operationStartTime: turf.operationStartTime || '06:00 AM',
                operationEndTime: turf.operationEndTime || '10:00 PM',
                heldSlots: turf.heldSlots || [],
                heldDays: turf.heldDays || [],
                confirmedSlots: turf.confirmedSlots || [],
                reservedSlots: turf.reservedSlots || []
            }
        });
    } catch (error) {
        console.error(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Public turf error: ${error.message}`);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/public-tournaments', async (req, res) => {
  try {
    const admins = await db.collection("admins").find().toArray();

    let tournaments = [];

    admins.forEach((admin) => {
      if (admin.currentTurf?.tournaments?.length > 0) {
        admin.currentTurf.tournaments.forEach((t) => {
          tournaments.push({
            name: t.name,
            sport: t.sport,
            imageUrl: t.imageUrl,
            entryFee: t.entryFee,
            prizePool: t.prizePool,
            status: t.status
          });
        });
      }
    });

    res.json({
      success: true,
      tournaments
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.get('/tournament/:tournamentId', authenticatePayment, async (req, res) => {
    try {
        const { tournamentId } = req.params;

        const adminDoc = await db.collection('admins').findOne({
            'currentTurf.tournaments.tournamentId': tournamentId
        });

        if (!adminDoc || !adminDoc.currentTurf?.tournaments) {
            return res.status(404).json({ success: false, message: 'Tournament not found' });
        }

        const tournament = adminDoc.currentTurf.tournaments.find(
            t => t.tournamentId === tournamentId
        );

        if (!tournament) {
            return res.status(404).json({ success: false, message: 'Tournament not found' });
        }

        const turf = adminDoc.currentTurf;
        const baseUrl = `${req.protocol}://${req.get('host')}`; // Auto-detects your server URL

        // FIX: Make imageUrl absolute
        const fullImageUrl = tournament.imageUrl
            ? tournament.imageUrl.startsWith('http')
                ? tournament.imageUrl
                : `${baseUrl}${tournament.imageUrl}`
            : null;

        res.json({
            success: true,
            tournament: {
                tournamentId: tournament.tournamentId,
                name: tournament.name || 'Unnamed Tournament',
                sport: tournament.sport || 'Cricket',
                startDate: tournament.startDate,
                endDate: tournament.endDate,
                entryFee: tournament.entryFee || 0,
                prizePool: tournament.prizePool || 0,
                maxTeams: tournament.maxTeams || 16,
                totalRegistered: tournament.totalRegistered || 0,
                registeredTeams: tournament.registeredTeams || [],
                description: tournament.description || '',
                imageUrl: fullImageUrl,  // ← FIXED: Full URL now
                venue: tournament.venue || turf.turfName || 'Unknown Venue',
                turfId: turf.id,
                turfName: turf.turfName,
                turfAddress: turf.turfAddress || '',
                status: tournament.status || 'upcoming'
            }
        });
    } catch (error) {
        console.error('Get tournament error:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});
// === UPDATE INVITE COUNT ===
router.post('/update-invite-count', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.body;
        let { inviteCode } = req.body;
        if (!userId || userId !== req.user.userId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const user = await User.findOne({ userId });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (!inviteCode || inviteCode.trim() === '') {
            inviteCode = user.invite?.code || await generateUniqueInviteCode();
        }
        let update = { $inc: { 'invite.count': 1 }, $set: { 'invite.code': inviteCode, inviteCode: inviteCode } };
        let milestoneReached = false;
        if ((user.invite?.count || 0) + 1 >= 10) {
            update = { $set: { 'invite.count': 1, 'invite.code': inviteCode, inviteCode: inviteCode }, $inc: { 'invite.cycle': 1 } };
            if ((user.invite?.cycle || 0) === 0) {
                update.$inc['invite.points'] = 5;
                milestoneReached = true;
            }
        }
        const updatedUser = await User.findOneAndUpdate({ userId }, update, { new: true });
        res.json({ success: true, user: updatedUser.invite, milestoneReached });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});
// === DELETE USER ===
router.delete('/users/delete', authenticateToken, async (req, res) => {
    try {
        const result = await db.collection('users').deleteOne({ userId: req.user.userId });
        if (result.deletedCount === 0) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, message: 'User deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});
// === UPDATE PROFILE ===
router.post('/profile', authenticatePayment, uploadProfile, handleProfileMulterError, async (req, res) => {
    try {
        const { userName } = req.body;
        const userId = req.user.userId;
        let profileImagePath = req.body.profileImagePath || '';
        if (!userName || !/^[a-zA-Z\s]{2,}$/.test(userName)) {
            return res.status(400).json({ success: false, message: 'Invalid userName' });
        }
        if (req.file) {
            profileImagePath = req.file.path
            
        }
        const result = await db.collection('users').updateOne(
            { userId },
            { $set: { userName, profileImagePath } }
        );
        if (result.matchedCount === 0) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, user: { userId, userName, profileImagePath }, message: 'Profile updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});
// === CHECK EMAIL ===
router.post('/check-email', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: 'Email required' });
        const exists = !!(await db.collection('users').findOne({ email: email.toLowerCase() }));
        res.json({ success: true, exists });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});
// === REGISTER USER ===
router.post('/register', async (req, res) => {
  try {
    let { userName, email, phone, password, firebaseToken } = req.body;

    // Input validation
    if (!userName || !email || !phone || !password || !firebaseToken) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    // Normalize inputs
    userName = userName.trim();
    email = email.trim().toLowerCase();
    phone = phone.replace('+91', '').trim();

    // Validate phone
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid Indian phone number' });
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    // Verify Firebase token
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(firebaseToken);
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid Firebase token' });
    }

    const firebaseUid = decoded.uid;

    // Check for existing user
    const db = mongoose.connection.db; // or your db reference
    const existing = await db.collection('users').findOne({
      $or: [
        { email },
        { phone },
        { firebaseUid }
      ]
    });

    if (existing) {
      let message = 'User already exists';
      if (existing.email === email) message = 'Email already registered';
      if (existing.phone === phone) message = 'Phone number already registered';
      if (existing.firebaseUid === firebaseUid) message = 'Account already linked to this Google/Fire base user';

      return res.status(409).json({ success: false, message });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate unique invite code
    const inviteCode = await generateUniqueInviteCode();

    // Use firebaseUid as userId (consistent with Google login)
    const userId = firebaseUid;

    // Insert new user
    const newUser = {
      userId,
      userName,
      email,
      phone,
      password: hashedPassword,
      firebaseUid,
      googleId: decoded.sub || '', // optional
      invite: { code: inviteCode, count: 0, cycle: 0, points: 0 },
      inviteCode,
      upcomingBookings: [],
      registeredTournaments: [],
      profileImagePath: '',
      createdAt: new Date()
    };

    await db.collection('users').insertOne(newUser);

    // Generate JWT
    const token = jwt.sign(
      { userId, firebaseUid },
      process.env.JWT_SECRET,
      { expiresIn: '7d' } // longer expiry for user app
    );

    // Success response
    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      token,
      user: {
        userId,
        userName,
        email,
        phone,
        inviteCode
      }
    });

  } catch (error) {
    console.error('Register error:', error.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
// === GOOGLE LOGIN – 100% WORKING FINAL VERSION (November 2025) ===
router.post('/google-login', async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) return res.status(400).json({ success: false, message: 'idToken required' });
        const decoded = await admin.auth().verifyIdToken(idToken);
        const firebaseUid = decoded.uid;
        const email = decoded.email?.toLowerCase();
        const displayName = decoded.name || decoded.displayName || email.split('@')[0];
        if (!email) return res.status(400).json({ success: false, message: 'Email not in token' });
        let user = await db.collection('users').findOne({ firebaseUid });
        // If not found by firebaseUid, check by email (for old users)
        if (!user && email) {
            user = await db.collection('users').findOne({ email });
            if (user) {
                // Link firebaseUid to existing account
                await db.collection('users').updateOne(
                    { _id: user._id },
                    { $set: { firebaseUid } }
                );
                 
            }
        }
        // Still no user? Create new one
        if (!user) {
            const inviteCode = await generateUniqueInviteCode();
            const userId = firebaseUid;
            user = {
                userId,
                userName: displayName.trim(),
                email,
                phone: '',
                firebaseUid,
                googleId: decoded.sub || '',
                password: '',
                invite: { code: inviteCode, count: 0, cycle: 0, points: 0 },
                inviteCode,
                upcomingBookings: [],
                registeredTournaments: [],
                profileImagePath: '',
                createdAt: new Date()
            };
            await db.collection('users').insertOne(user);
             
        }
        const jwtToken = jwt.sign(
            { userId: user.userId },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.json({
            success: true,
            token: jwtToken,
            user: {
                userId: user.userId,
                userName: user.userName,
                email: user.email,
                phone: user.phone || '',
                profileImagePath: user.profileImagePath || '',
                inviteCode: user.invite?.code || user.inviteCode || ''
            }
        });
    } catch (err) {
        console.error('[Google Login Error]:', err.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});



// === HOME DATA ===
router.get('/home', authenticatePayment, async (req, res) => {
    try {
        const user = await db.collection('users').findOne({ userId: req.user.userId });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const adminDocs = await db.collection('admins').find({}).toArray();
        const tournaments = [];
        for (const admin of adminDocs) {
            const turf = admin.currentTurf;
            if (!turf?.tournaments || !Array.isArray(turf.tournaments)) continue;
            for (const t of turf.tournaments) {
                const startDate = new Date(t.startDate);
                if (isNaN(startDate)) continue;
                if (startDate >= today && t.totalRegistered < t.maxTeams) {
                    const baseUrl = `${req.protocol}://${req.get('host')}`;

                    tournaments.push({
                        id: t._id?.toString() || '',
                        turfId: turf.id,
                        name: t.name || 'Unnamed Tournament',
                        sport: t.sport || '',
                        startDate: t.startDate,
                        endDate: t.endDate,
                        entryFee: t.entryFee || 0,
                        prizePool: t.prizePool || 0,
                        maxTeams: t.maxTeams || 16,
                        totalRegistered: t.totalRegistered || 0,
                        venue: t.venue || turf.turfName,
                        imageUrl: t.imageUrl? t.imageUrl.startsWith('http')? t.imageUrl: `${baseUrl}${t.imageUrl}`: '',
                        description: t.description || ''
                    });
                }
            }
        }
        tournaments.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
        const formattedBookings = (user.upcomingBookings || []).map(b => {
            if (b.type === 'tournament') {
                return { ...b, displayName: b.tournamentName, displayType: 'Tournament' };
            } else {
                return { ...b, displayName: b.turfName, displayType: 'Turf Booking' };
            }
        });
        res.json({
            success: true,
            user: {
                userId: user.userId,
                userName: user.userName,
                email: user.email,
                phone: user.phone,
                profileImagePath: user.profileImagePath || '',
                inviteCode: user.invite?.code || '',
                inviteCount: user.invite?.count || 0,
                cycle: user.invite?.cycle || 0,
                points: user.invite?.points || 0
            },
            upcomingBookings: formattedBookings,
            tournaments
        });
    } catch (error) {
        console.error(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Home error: ${error.message}`);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});
// === GET BOOKINGS ===
router.get('/bookings', authenticateToken, async (req, res) => {
    try {
        const user = await db.collection('users').findOne({ userId: req.user.userId }, { projection: { upcomingBookings: 1 } });
        const formattedBookings = (user?.upcomingBookings || []).map(b => {
            if (b.type === 'tournament') {
                return { ...b, displayName: b.tournamentName, displayType: 'Tournament' };
            } else {
                return { ...b, displayName: b.turfName, displayType: 'Turf Booking' };
            }
        });
        res.json({ success: true, bookings: formattedBookings });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});
// === RELEASE SLOTS ===
router.post('/turf/:turfId/release-slots', authenticatePayment, async (req, res) => {
    try {
        const { turfId } = req.params;
        const slots = req.body;
        const userId = req.user.userId;
        if (!Array.isArray(slots) || slots.length === 0) {
            return res.status(400).json({ success: false, message: 'Slots array is required' });
        }
        const result = await db.collection('admins').updateOne(
            { 'currentTurf.id': turfId },
            {
                $pull: {
    'currentTurf.heldSlots': {
        userId,
        $or: slots.map(s => ({
            date: s.date,
            slot: s.slot
        }))
    }
}
            }
        );
        if (result.modifiedCount > 0) {
            await User.updateOne(
                { userId },
                { $pull: { upcomingBookings: { date: { $in: slots.map(s => s.date) }, time: { $in: slots.map(s => s.slot) } } } }
            );
        }
        await HeldSlot.deleteMany({
   turfId,
   userId,
   date: { $in: slots.map(s => s.date) },
   slot: { $in: slots.map(s => s.slot) }
});
        res.json({ success: true, message: 'Slots released', releasedCount: result.modifiedCount });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/booking/confirm', authenticatePayment, async (req, res) => {

    try {

        const {
            paymentId,
            turfId,
            slots,
            sport,
            orderId: clientOrderId
        } = req.body;


        if (
            !paymentId ||
            !turfId ||
            !Array.isArray(slots) ||
            slots.length === 0 ||
            !sport
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid booking confirmation data'
            });
        }

        const authenticatedUserId =
            req.user.userId || req.user.uid;

        if (!authenticatedUserId) {
            return res.status(401).json({
                success: false,
                message: 'User authentication required'
            });
        }

        if (!clientOrderId) {
            return res.status(400).json({
                success: false,
                message: 'Razorpay orderId is required'
            });
        }

        let pendingBooking = await Booking.findOne({
            $or: [
                {
                    razorpayOrderId: clientOrderId
                },
                {
                    orderId: clientOrderId
                }
            ]
        });

        if (!pendingBooking) {
            return res.status(404).json({
                success: false,
                message:
                    'Pending booking not found for this payment'
            });
        }

        if (
            String(pendingBooking.userId) !==
            String(authenticatedUserId)
        ) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized booking'
            });
        }

        if (
            String(pendingBooking.turfId) !==
            String(turfId)
        ) {
            return res.status(400).json({
                success: false,
                message: 'Turf does not match booking'
            });
        }

        if (pendingBooking.status === 'confirmed') {

            return res.json({
                success: true,
                alreadyConfirmed: true,
                message: 'Booking already confirmed',
                bookingId:
                    pendingBooking.bookingId,
                paymentStatus:
                    pendingBooking.paymentStatus,
                isAdvance:
                    pendingBooking.isAdvance,
                advanceAmount:
                    pendingBooking.advanceAmount ||
                    pendingBooking.paidAmount,
                balanceAmount:
                    pendingBooking.balanceAmount || 0,
                totalAmount:
                    pendingBooking.totalAmount
            });
        }

        const totalAmount =
            Number(pendingBooking.totalAmount || 0);

        const paidAmount =
            Number(pendingBooking.paidAmount || 0);

        const isAdvance =
            pendingBooking.isAdvance === true;

        if (
            totalAmount <= 0 ||
            paidAmount <= 0
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Invalid payment information in booking'
            });
        }


        if (
            typeof rzp === 'undefined' ||
            !rzp ||
            !rzp.payments
        ) {
            return res.status(500).json({
                success: false,
                message:
                    'Payment service unavailable'
            });
        }
        const payment =
            await rzp.payments.fetch(paymentId);

        if (!payment) {
            return res.status(404).json({
                success: false,
                message:
                    'Payment not found in Razorpay'
            });
        }

        if (
            payment.order_id !== clientOrderId
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Payment does not belong to this order'
            });
        }

        if (
            payment.status !== 'captured'
        ) {
            return res.status(400).json({
                success: false,
                message:
                    `Payment is not captured. Status: ${payment.status}`
            });
        }

        const receivedAmount =
            Number(payment.amount || 0) / 100;

        if (
            Math.round(receivedAmount * 100) !==
            Math.round(paidAmount * 100)
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Payment amount mismatch'
            });
        }

        const balanceAmount =
            isAdvance
                ? Math.max(
                    totalAmount - paidAmount,
                    0
                )
                : 0;

        const advanceAmount =
            isAdvance
                ? paidAmount
                : totalAmount;

        const paymentStatus =
            isAdvance
                ? 'partial'
                : 'full';

        const updatedBooking =
            await Booking.findOneAndUpdate(
                {
                    _id: pendingBooking._id,
                    status: 'pending'
                },
                {
                    $set: {

                        paymentId:
                            paymentId,

                        razorpayPaymentId:
                            paymentId,

                        status:
                            'confirmed',

                        paidAt:
                            new Date(),

                        paymentStatus:
                            paymentStatus,

                        isFullyPaid:
                            !isAdvance,

                        balanceAmount:
                            balanceAmount,

                        advanceAmount:
                            advanceAmount
                    }
                },
                {
                    new: true
                }
            );

        if (!updatedBooking) {

            const alreadyConfirmed =
                await Booking.findById(
                    pendingBooking._id
                );

            if (
                alreadyConfirmed &&
                alreadyConfirmed.status === 'confirmed'
            ) {

                return res.json({
                    success: true,
                    alreadyConfirmed: true,
                    message:
                        'Booking already confirmed',
                    bookingId:
                        alreadyConfirmed.bookingId
                });
            }

            return res.status(409).json({
                success: false,
                message:
                    'Booking confirmation conflict'
            });
        }

        await mongoose.connection.db
            .collection('users')
            .updateOne(
                {
                    $or: [
                        {
                            firebaseUid:
                                updatedBooking.userId
                        },
                        {
                            userId:
                                updatedBooking.userId
                        }
                    ]
                },
                {
                    $addToSet: {
                        upcomingBookings: {

                            bookingId:
                                updatedBooking.bookingId,

                            turfId:
                                updatedBooking.turfId,

                            turfName:
                                updatedBooking.turfName,

                            date:
                                updatedBooking.slots?.[0]?.date ||
                                null,

                            slots:
                                updatedBooking.slots,

                            sport:
                                updatedBooking.sport,

                            totalAmount:
                                totalAmount,

                            paidAmount:
                                paidAmount,

                            balanceAmount:
                                balanceAmount,

                            isAdvance:
                                isAdvance,

                            advanceAmount:
                                advanceAmount,

                            status:
                                'confirmed',

                            paymentStatus:
                                paymentStatus,

                            paymentId:
                                paymentId,

                            bookedAt:
                                updatedBooking.bookedAt ||
                                new Date()
                        }
                    }
                }
            );

        const slotPairs =
            (updatedBooking.slots || [])
                .map(s => ({
                    date: s.date,
                    slot: s.slot
                }));

        if (slotPairs.length > 0) {

            await HeldSlot.deleteMany({
                turfId:
                    updatedBooking.turfId,

                userId:
                    updatedBooking.userId,

                $or:
                    slotPairs
            });
        }

        return res.json({

            success: true,

            message:
                'Booking confirmed successfully!',

            bookingId:
                updatedBooking.bookingId,

            isAdvance:
                isAdvance,

            advanceAmount:
                advanceAmount,

            balanceAmount:
                balanceAmount,

            totalAmount:
                totalAmount,

            paymentStatus:
                paymentStatus
        });

    } catch (error) {

        console.error(
            'Booking confirmation error:',
            error.message
        );

        return res.status(500).json({
            success: false,
            message:
                'Booking confirmation failed'
        });
    }
});
// === TOURNAMENT HOLD, RELEASE, REGISTER, ETC. ===
router.post('/tournament/hold', authenticatePayment, async (req, res) => {
  try {
    const { tournamentId } = req.body;
    const userId = req.user.userId;

    if (!tournamentId) {
      return res.status(400).json({ success: false, message: 'tournamentId required' });
    }

    // CHECK IF USER ALREADY HAS A HOLD
    const existingHold = await db.collection('tournamentHolds').findOne({
      tournamentId,
      userId,
      expiresAt: { $gt: new Date() }
    });

    if (existingHold) {
      return res.json({ success: true, holdId: existingHold.holdId });
    }

    const holdId = `hold_${Date.now()}_${userId}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await db.collection('tournamentHolds').insertOne({
      holdId,
      tournamentId,
      userId,
      expiresAt,
      createdAt: new Date()
    });

    res.json({ success: true, holdId });
  } catch (error) {
    console.error('Hold error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/tournament/release', authenticatePayment, async (req, res) => {
    try {
        const { holdId } = req.body;
        const userId = req.user.userId;
        if (!holdId) {
            return res.status(400).json({ success: false, message: 'holdId required' });
        }
        const result = await db.collection('tournamentHolds').deleteOne({
            holdId,
            userId
        });
        res.json({ success: true, deleted: result.deletedCount > 0 });
    } catch (error) {
        console.error('Release hold error:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});
// === TOURNAMENT REGISTRATION — NO HOLD SYSTEM (Clean & Final) ===
router.post('/tournament/register', authenticatePayment, async (req, res) => {
  console.log(">>> TOURNAMENT REGISTRATION — NO HOLD (FINAL CLEAN VERSION) <<<");
  try {
    console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] REGISTER PAYLOAD RECEIVED:`, req.body);

    const {
      tournamentId,
      paymentId,
      teamName,
      captainName,
      captainPhone,
      playerNames = []
    } = req.body;

    if (!tournamentId || !paymentId || !teamName || !captainName || !captainPhone) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (!Array.isArray(playerNames)) {
      return res.status(400).json({ success: false, message: 'playerNames must be an array' });
    }

    const userId = req.user.firebaseUid;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User authentication failed' });
    }

    const db = mongoose.connection.db;

    const adminDoc = await db.collection('admins').findOne({
      'currentTurf.tournaments.tournamentId': tournamentId
    });

    if (!adminDoc || !adminDoc.currentTurf?.tournaments) {
      return res.status(404).json({ success: false, message: 'Tournament not found' });
    }

    const tournament = adminDoc.currentTurf.tournaments.find(t => t.tournamentId === tournamentId);
    if (!tournament) {
      return res.status(404).json({ success: false, message: 'Tournament not found' });
    }

    // Prevent double registration
    if (tournament.registeredTeams?.some(team => team.userId === userId)) {
      return res.status(400).json({ success: false, message: 'You have already registered!' });
    }

    // Check if full
    if (tournament.totalRegistered >= tournament.maxTeams) {
      return res.status(400).json({ success: false, message: 'Tournament is full' });
    }

    // Register directly — no hold needed
    const newTeam = {
      userId,
      teamName: teamName.trim(),
      captainName: captainName.trim(),
      captainPhone: captainPhone.trim(),
      playerNames: playerNames.map(p => p.trim()).filter(p => p.length > 0),
      paymentId,
      registeredAt: new Date()
    };

    const updateResult = await db.collection('admins').updateOne(
      { 'currentTurf.tournaments.tournamentId': tournamentId },
      {
        $push: { 'currentTurf.tournaments.$[elem].registeredTeams': newTeam },
        $inc: { 'currentTurf.tournaments.$[elem].totalRegistered': 1 }
      },
      { arrayFilters: [{ 'elem.tournamentId': tournamentId }] }
    );

    if (updateResult.modifiedCount === 0) {
      return res.status(500).json({ success: false, message: 'Failed to register team' });
    }

    // Add to user's registeredTournaments
    await db.collection('users').updateOne(
      { firebaseUid: userId },
      {
        $push: {
          registeredTournaments: {
            registrationId: `TOUR_REG_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: 'tournament',
            tournamentId,
            tournamentName: tournament.name || 'Unnamed Tournament',
            venue: tournament.venue || adminDoc.currentTurf.turfName || 'Unknown Venue',
            sport: tournament.sport || 'Cricket',
            entryFee: tournament.entryFee || 0,
            paymentId,
            status: 'Confirmed',
            registeredAt: new Date(),
            teamName: newTeam.teamName,
            captainName: newTeam.captainName,
            captainPhone: newTeam.captainPhone,
            playerNames: newTeam.playerNames
          }
        }
      }
    );

     

    return res.json({
      success: true,
      message: 'Team registered successfully!',
      registration: {
        teamName: newTeam.teamName,
        tournamentName: tournament.name || 'Unnamed Tournament',
        totalRegistered: tournament.totalRegistered + 1,
        maxTeams: tournament.maxTeams
      }
    });

  } catch (error) {
    console.error('Tournament register error:', error.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});
router.get('/user/registered-tournaments', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const user = await db.collection('users').findOne(
            { userId },
            { projection: { registeredTournaments: 1, userName: 1 } }
        );
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        const registeredTournaments = user.registeredTournaments || [];
        const enrichedTournaments = await Promise.all(
            registeredTournaments.map(async (reg) => {
                const admin = await db.collection('admins').findOne({
                    'currentTurf.tournaments.tournamentId': reg.tournamentId
                });
                const tournament = admin?.currentTurf?.tournaments?.find(
                    t => t.tournamentId === reg.tournamentId
                );
                if (!tournament) return null;
                return {
                    tournament: {
                        tournamentId: tournament.tournamentId,
                        turfId: admin.currentTurf.id,
                        name: tournament.name,
                        sport: tournament.sport,
                        startDate: tournament.startDate,
                        endDate: tournament.endDate,
                        entryFee: tournament.entryFee,
                        prizePool: tournament.prizePool,
                        maxTeams: tournament.maxTeams,
                        totalRegistered: tournament.totalRegistered,
                        venue: tournament.venue || admin.currentTurf.turfName,
                        description: tournament.description || '',
                        imageUrl: tournament.imageUrl || ''
                    },
                    team: {
                        teamName: reg.teamName,
                        captainName: reg.captainName,
                        captainPhone: reg.captainPhone,
                        members: reg.playerNames || []
                    },
                    paymentId: reg.paymentId,
                    registeredAt: reg.registeredAt
                };
            })
        );
        const validTournaments = enrichedTournaments.filter(t => t !== null);
        res.json({
            success: true,
            data: validTournaments
        });
    } catch (error) {
        console.error('Get registered tournaments error:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});
router.post('/admin/fix-duplicates', authenticateAdmin, async (req, res) => {
    try {
        let fixed = 0;
        const users = await db.collection('users').find({}).toArray();
        for (const user of users) {
            const seen = new Set();
            const unique = [];
            for (const b of user.upcomingBookings) {
                const key = b.orderId || b.bookingId;
                if (key && !seen.has(key)) {
                    seen.add(key);
                    unique.push(b);
                }
            }
            if (unique.length !== user.upcomingBookings.length) {
                await db.collection('users').updateOne(
                    { _id: user._id },
                    { $set: { upcomingBookings: unique } }
                );
                fixed++;
            }
        }
        res.json({ success: true, message: `Fixed duplicates in ${fixed} users` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/public/turfs', async (req, res) => {
  try {
    const adminsWithTurf = await mongoose.connection.db.collection('admins').find({
      "currentTurf.id": { $exists: true, $ne: null }
    }).toArray();

    if (!adminsWithTurf.length) {
      return res.json({
        success: true,
        count: 0,
        turfs: []
      });
    } 

    const turfs = adminsWithTurf.map(admin => {
      const t = admin.currentTurf;

      let fullImageUrl = t.imageUrl || null;

      let latitude = 9.9252;  // Madurai default
      let longitude = 78.1198;
      if (t.gpsCoordinates) {
        const [latStr, lngStr] = t.gpsCoordinates.split(',').map(s => s.trim());
        const lat = parseFloat(latStr);
        const lng = parseFloat(lngStr);
        if (!isNaN(lat) && !isNaN(lng)) {
          latitude = lat;
          longitude = lng;
        }
      }

      return {
        turfId: t.id,
        turfName: t.turfName || "Unnamed Turf",
        turfAddress: `${t.turfAddress || ''}${t.turfAddressLine2 ? ', ' + t.turfAddressLine2 : ''}, ${t.district || ''}, ${t.state || 'Tamil Nadu'}`,
        district: t.district || '',
        contactNumber: t.contactNumber || '',
        pricePerHour: t.pricePerHour || 0,
        sports: t.sports || [],
        imageUrl: fullImageUrl, 
        amenities: [
          t.hasLighting ? 'Lighting' : null,
          t.hasWashroom ? 'Washroom' : null,
          t.hasParking ? 'Parking' : null,
          t.hasDrinkingFacilities ? 'Drinking Water' : null,
          t.playingSurface ? `Surface: ${t.playingSurface}` : null,
        ].filter(Boolean),
        latitude: latitude,
        longitude: longitude,
        operationStartTime: t.operationStartTime || "06:00 AM",
        operationEndTime: t.operationEndTime || "10:00 PM",
      };
    });

    res.json({
      success: true,
      count: turfs.length,
      turfs: turfs
    });

  } catch (error) {
    console.error('Public turfs list error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching turfs' 
    });
  }
});
router.post('/booking/reserve', authenticatePayment, async (req, res) => {
    try {
        const { turfId, slots, sport } = req.body;
        const userId = req.user.userId;

        if (
            !turfId ||
            !Array.isArray(slots) ||
            slots.length === 0 ||
            !sport
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid booking data'
            });
        }

        for (const s of slots) {
            if (!s?.date || !s?.slot) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid slot data'
                });
            }
        }

        const adminDoc = await db.collection('admins').findOne({
            'currentTurf.id': turfId
        });

        if (!adminDoc?.currentTurf) {
            return res.status(404).json({
                success: false,
                message: 'Turf not found'
            });
        }

        const turf = adminDoc.currentTurf;

        const requestedSport = String(sport).trim();

        const validSport = (turf.sports || []).some(
            s => String(s).trim().toLowerCase() ===
                 requestedSport.toLowerCase()
        );

        if (!validSport) {
            return res.status(400).json({
                success: false,
                message: 'Invalid sport for this turf'
            });
        }

        const adminHeldDays = turf.heldDays || [];

        for (const requestedSlot of slots) {

            const dayBlocked = adminHeldDays.some(day => {

                if (typeof day === 'string') {
                    return day === requestedSlot.date;
                }

                return day?.date === requestedSlot.date;
            });

            if (dayBlocked) {
                return res.status(409).json({
                    success: false,
                    message: 'The selected date is unavailable'
                });
            }
        }

        const adminHeldSlots = turf.heldSlots || [];

        for (const requestedSlot of slots) {

            const adminBlocked = adminHeldSlots.some(held => {

                return (
                    String(held.date) === String(requestedSlot.date) &&
                    String(held.slot) === String(requestedSlot.slot)
                );
            });

            if (adminBlocked) {
                return res.status(409).json({
                    success: false,
                    message: 'One or more selected slots are unavailable'
                });
            }
        }

        const activeHoldConflict = await HeldSlot.findOne({
            turfId,
            $or: slots.map(s => ({
                date: s.date,
                slot: s.slot
            })),
            expiresAt: { $gt: new Date() }
        });

        if (activeHoldConflict) {
            return res.status(409).json({
                success: false,
                message: 'One or more slots are no longer available',
                conflictingSlot: activeHoldConflict.slot
            });
        }

        const confirmedConflict = await Booking.findOne({
            turfId,
            status: 'confirmed',
            $or: slots.map(s => ({
                slots: {
                    $elemMatch: {
                        date: s.date,
                        slot: s.slot
                    }
                }
            }))
        });

        if (confirmedConflict) {
            return res.status(409).json({
                success: false,
                message: 'One or more slots are already booked'
            });
        }

        const pricePerHour = Number(turf.pricePerHour);

        if (!Number.isFinite(pricePerHour) || pricePerHour <= 0) {
            return res.status(500).json({
                success: false,
                message: 'Invalid turf pricing configuration'
            });
        }

        const totalAmount =
            pricePerHour * slots.length;

        const isAdvance = true;

        const paidAmount =
            Math.round(
                totalAmount *
                ADVANCE_PERCENTAGE *
                100
            ) / 100;

        const expiresAt =
            new Date(Date.now() + 15 * 60 * 1000);

        const holdDocs = slots.map(s => ({
            turfId,
            date: s.date,
            slot: s.slot,
            userId,
            sport: requestedSport.toUpperCase(),
            expiresAt,
            totalAmount,
            paidAmount,
            isAdvance
        }));

        try {

            await HeldSlot.insertMany(
                holdDocs,
                { ordered: true }
            );

        } catch (err) {

            if (err.code === 11000) {
                return res.status(409).json({
                    success: false,
                    message:
                        'One or more slots were taken by another user'
                });
            }

            throw err;
        }

        return res.json({
            success: true,
            message: 'Slots reserved for 15 minutes',

            expiresAt:
                expiresAt.toISOString(),

            holdCount:
                slots.length,

            pricing: {
                pricePerHour,
                totalAmount,
                paidAmount,
                balanceAmount:
                    Math.max(
                        totalAmount - paidAmount,
                        0
                    ),
                isAdvance
            }
        });

    } catch (error) {

        console.error(
            'Reserve booking error:',
            error
        );

        return res.status(500).json({
            success: false,
            message: 'Server error during reservation'
        });
    }
});

router.post('/booking/shorten-expiry', authenticatePayment, async (req, res) => {
    try {
        const { turfId, slots } = req.body;
        const userId = req.user.userId;

        if (
            !turfId ||
            !Array.isArray(slots) ||
            slots.length === 0
        ) {
            return res.status(400).json({
                success: false,
                message: 'turfId and slots are required'
            });
        }

        const validSlots = slots.filter(
            s => s?.date && s?.slot
        );

        if (validSlots.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid slots supplied'
            });
        }

        const newExpiry = new Date(
            Date.now() + 2 * 60 * 1000
        );

        const slotPairs = validSlots.map(s => ({
            date: String(s.date),
            slot: String(s.slot)
        }));

        const result = await HeldSlot.updateMany(
            {
                turfId,
                userId,
                expiresAt: { $gt: new Date() },
                $or: slotPairs
            },
            {
                $set: {
                    expiresAt: newExpiry
                }
            }
        );

        return res.json({
            success: true,
            updatedCount: result.modifiedCount,
            expiresAt: newExpiry.toISOString()
        });

    } catch (err) {
        console.error(
            'Shorten expiry error:',
            err
        );

        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

module.exports = router;  