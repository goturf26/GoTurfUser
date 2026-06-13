// server.js
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
require('dotenv').config();
const bcrypt = require('bcrypt');
const app = express();

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Created uploads directory at ${uploadsDir}`);
}

// Initialize Firebase Admin
try {
    if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
        throw new Error('Missing Firebase environment variables');
    }
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
    });
    console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Firebase Admin initialized`);
} catch (error) {
    console.error(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Firebase Admin initialization error: ${error.message}, stack: ${error.stack}`);
    process.exit(1);
}

// Initialize Razorpay
let rzp;
try {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || !process.env.RAZORPAY_WEBHOOK_SECRET) {
        throw new Error('Missing Razorpay environment variables');
    }
    rzp = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Razorpay initialized`);
} catch (error) {
    console.error(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Razorpay initialization error: ${error.message}, stack: ${error.stack}`);
    process.exit(1);
}


// AUTO-CREATE TURF IF NOT EXISTS — FINAL WORKING VERSION
async function ensureTurfExists(turfId, turfName) {
    try {
        const db = mongoose.connection.db;
        const exists = await db.collection('admins').findOne({ 'currentTurf.id': turfId });
        
        if (!exists) {
            const hashedPassword = await bcrypt.hash("temp123", 10);
            
            await db.collection('admins').insertOne({
                name: turfName || "GoTurf Admin",
                email: `${turfId.toLowerCase()}@goturf.com`,
                phone: "0000000000",
                password: hashedPassword,
                role: "admin",
                currentTurf: {
                    id: turfId,
                    turfName: turfName || "Unknown Turf",
                    state: "Tamil Nadu",
                    district: "Madurai",
                    sports: ["Cricket"],
                    pricePerHour: 800,
                    operationStartTime: "06:00 AM",
                    operationEndTime: "10:00 PM",
                    confirmedSlots: [],
                    heldSlots: [],
                    heldDays: [],
                    bookingCount: 0,
                    tournaments: []
                }
            });
            
            console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] AUTO-CREATED TURF: ${turfId} → ${turfName}`);
        }
    } catch (error) {
        console.error("ensureTurfExists error:", error.message);
        throw error;
    }
}

// Notification Helper Function 
async function sendNotificationToTopic(topic, title, body, data = {}) {
    if (!topic || !title || !body) return;
    
    const message = {
        notification: {
            title: title,
            body: body,
        },
        data: data,
        topic: topic  
    };

    try {
        await admin.messaging().send(message);
        console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Notification sent to ${topic}: ${title}`);
    } catch (error) {
        console.error(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] FCM Error: ${error.message}`);
    }
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const uploadsPath = path.join(__dirname, '..', 'admin-backend', 'uploads');

app.use('/uploads', express.static(uploadsPath));

console.log('[USER BACKEND STATIC] Serving /uploads from shared folder:', uploadsPath);
// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


// Log environment variables
console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] MONGODB_URI: ${process.env.MONGODB_URI ? 'Defined' : 'Not defined'}`);
console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] JWT_SECRET: ${process.env.JWT_SECRET ? 'Defined' : 'Not defined'}`);
console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] FIREBASE_PROJECT_ID: ${process.env.FIREBASE_PROJECT_ID ? 'Defined' : 'Not defined'}`);
console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] RAZORPAY_KEY_ID: ${process.env.RAZORPAY_KEY_ID ? 'Defined' : 'Not defined'}`);
console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] RAZORPAY_KEY_SECRET: ${process.env.RAZORPAY_KEY_SECRET ? 'Defined' : 'Not defined'}`);
console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] RAZORPAY_WEBHOOK_SECRET: ${process.env.RAZORPAY_WEBHOOK_SECRET ? 'Defined' : 'Not defined'}`);

// MongoDB Connection
if (!process.env.MONGODB_URI) {
    console.error(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Error: MONGODB_URI is not defined in .env file`);
    process.exit(1);
}

mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
        console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] MongoDB Connected`);

        // === MODEL REGISTRATION (CRITICAL FIX) ===
        // 🎯 Load models first to register schemas globally before routes run.
        try {
            // NOTE: Assuming your User model is in ./models/user.js
            require('./models/user'); 
        } catch (e) {
            console.error(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] ERROR: Failed to require model: ${e.message}`);
        }
        
        const BookingSchema = new mongoose.Schema({
    bookingId: { type: String, required: true, unique: true },
    turfId: { type: String, required: true },
    userId: { type: String, required: true },
    turfName: { type: String, required: true },
    slots: [{ date: String, slot: String }],
    sport: { type: String, required: true },

    totalAmount: { type: Number, required: true },
    paidAmount: { type: Number, required: true },
    balanceAmount: { type: Number, default: 0 },
    advanceAmount: { type: Number, default: 0 },
    isAdvance: { type: Boolean, default: false },
    isFullyPaid: { type: Boolean, default: false },

    paymentStatus: { 
        type: String, 
        enum: ['pending', 'partial', 'full'], 
        default: 'pending' 
    },

    status: { 
        type: String, 
        enum: ['pending', 'confirmed', 'cancelled'], 
        default: 'pending' 
    },

    paymentId: String,
    razorpayPaymentId: String,
    razorpayOrderId: String,    // MUST HAVE THIS
    orderId: String,            // optional legacy

    bookedAt: { type: Date, default: Date.now },
    paidAt: Date,
    expiresAt: Date,
});
        const HeldSlotSchema = new mongoose.Schema({
            turfId: { type: String, required: true },
            date: { type: String, required: true },
            slot: { type: String, required: true },
            userId: { type: String, required: true },
            expiresAt: { type: Date, required: true },
            
            totalAmount: Number,
            paidAmount: Number,
            isAdvance: Boolean,
        });
        HeldSlotSchema.index(
            { turfId: 1, date: 1, slot: 1 },
            { unique: true }
        );
        HeldSlotSchema.index(
            { expiresAt: 1 },                    
            { expireAfterSeconds: 0 }            
        );

        const AdminSchema = new mongoose.Schema({
            currentTurf: {
                id: String,
                name: String,
                sports: [String],
                confirmedSlots: [{ date: String, slot: String, userId: String, paymentId: String, totalAmount: Number, paidAmount: Number, isAdvance: Boolean, bookedAt: Date }],
                heldSlots: [{ date: String, slot: String, userId: String, expiresAt: Date }],
                heldDays: [{ date: String }],
                bookingCount: { type: Number, default: 0 },
            },
        }, { collection: 'admins' });

        const Booking = mongoose.model('Booking', BookingSchema);
        const HeldSlot = mongoose.model('HeldSlot', HeldSlotSchema);
        const Admin = mongoose.model('Admin', AdminSchema);
        // Note: The User model is already registered by requiring './models/user'

        // === TURF ROUTES (Now models are safely registered) ===
        const turfRouter = require('./routes/turf');
        const turfRoutes = turfRouter.stack
            .filter(layer => layer.route)
            .map(layer => ({
                path: layer.route.path,
                methods: Object.keys(layer.route.methods).join(', '),
            }));
        console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Turf routes loaded:`, turfRoutes);
        app.use('/api', turfRouter);

        // === LOG INCOMING REQUESTS ===
        app.use((req, res, next) => {
            console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Incoming request:`, {
                method: req.method,
                url: req.url,
                ip: req.ip,
                headers: req.headers,
                body: req.body,
            });
            next();
        });

        // === HEALTH CHECK ===
        app.get('/health', (req, res) => {
            res.status(200).json({ status: 'OK', message: 'Server is running' });
        });

        // === CHECK EMAIL EXISTS ===
        app.post('/api/check-email', async (req, res) => {
            try {
                const { email } = req.body;
                if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    return res.status(400).json({ success: false, message: 'Valid email required' });
                }

                const db = mongoose.connection.db;
                const exists = !!(await db.collection('users').findOne({ email: email.toLowerCase() }));

                res.json({ success: true, exists });
            } catch (error) {
                console.error('Check email error:', error.message);
                res.status(500).json({ success: false, message: 'Server error' });
            }
        });

        // === GOOGLE LOGIN / REGISTER ===
        app.post('/api/google-login', async (req, res) => {
            try {
                const { idToken, email, displayName, phone } = req.body;

                if (!idToken || !email || !displayName) {
                    return res.status(400).json({ success: false, message: 'idToken, email, displayName required' });
                }

                let decoded;
                try {
                    decoded = await admin.auth().verifyIdToken(idToken);
                } catch (error) {
                    return res.status(401).json({ success: false, message: 'Invalid ID token', error: error.message });
                }

                if (decoded.email !== email) {
                    return res.status(403).json({ success: false, message: 'Email mismatch' });
                }

                const userId = decoded.uid;
                const db = mongoose.connection.db;
                const usersCollection = db.collection('users');

                let user = await usersCollection.findOne({ firebaseUid: userId });
                let isNewUser = false;

                if (!user) {
                    const timestamp = Date.now();
                    const random = Math.floor(100 + Math.random() * 900);
                    const generatedUserId = `USER_${timestamp}_${random}`;

                    user = {
                        userId: generatedUserId,
                        userName: displayName.trim(),
                        email: email.toLowerCase(),
                        phone: phone || '',
                        firebaseUid: userId,
                        googleId: decoded.sub,
                        createdAt: new Date(),
                        upcomingBookings: [],
                        registeredTournaments: [],
                        profileImagePath: '',
                        invite: { code: '', count: 0, cycle: 0, points: 0 },
                        inviteCode: '',
                        streak: {
                            weeklyActivity: [false, false, false, false, false, false, false],
                            currentStreak: 0,
                            totalPoints: 0,
                            isStreakFrozen: false,
                            lastWeekChecked: null,
                            lastRecoveryDate: null,
                            activityLog: []
                        }
                    };

                    await usersCollection.insertOne(user);
                    isNewUser = true;
                    console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] New user registered: ${userId}`);
                }

                const jwtToken = jwt.sign(
                    { userId: user.userId, firebaseUid: userId },
                    process.env.JWT_SECRET,
                    { expiresIn: '7d' }
                );

                res.json({
                    success: true,
                    isNewUser,
                    token: jwtToken,
                    user: {
                        userId: user.userId,
                        userName: user.userName,
                        email: user.email,
                        phone: user.phone,
                        profileImagePath: user.profileImagePath || '',
                        inviteCode: user.inviteCode || ''
                    }
                });

            } catch (error) {
                console.error('Google login error:', error.message);
                res.status(500).json({ success: false, message: 'Server error' });
            }
        });

        // ADD THIS ROUTE
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  console.log('\nMANUAL LOGIN ATTEMPT');
  console.log('Username:', username);
  console.log('Password length:', password?.length || 0);

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password required' });
  }

  try {
    const db = mongoose.connection.db;
    const user = await db.collection('users').findOne({ userName: username.trim() });

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid username or password' });
    }

    // If user has password field (for manual signup)
    if (user.password) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(400).json({ success: false, message: 'Invalid username or password' });
      }
    } else {
      // Google-only users can't login with password
      return res.status(400).json({ success: false, message: 'This account uses Google Sign-In' });
    }

    const token = jwt.sign(
      { userId: user.userId, firebaseUid: user.firebaseUid },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        userId: user.userId,
        userName: user.userName,
        email: user.email,
        phone: user.phone,
      }
    });
  } catch (error) {
    console.error('Manual login error:', error.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/payments/create-order', async (req, res) => {
  try {
    const { 
      userId, 
      turfId, 
      amount,           
      totalAmount,      
      turfName, 
      slots, 
      isAdvance,        
      advanceAmount,
      sport                // optional but good to have
    } = req.body;

    const payAmount = parseFloat(amount);
    const total = parseFloat(totalAmount);
    const advanceAmt = parseFloat(advanceAmount || 0);

    // Force boolean conversion
    const isAdvancePayment = isAdvance === true || isAdvance === "true" || isAdvance === 'true';

    // Basic validation
    if (!userId || !turfId || !turfName || !Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ success: false, message: 'Missing required fields or invalid slots' });
    }
    if (isNaN(total) || isNaN(payAmount) || payAmount <= 0 || total <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount values' });
    }

    // Authentication
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(token);
      if (decoded.uid !== userId) {
        return res.status(403).json({ success: false, message: 'Unauthorized: user mismatch' });
      }
    } catch (err) {
      console.error('Token verification failed:', err.message);
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

    // Auto-create turf if missing
    await ensureTurfExists(turfId, turfName);

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour for payment

    // ────────────────────────────────────────────────
    // HOLD SLOTS – Allow same user to update existing hold
    // ────────────────────────────────────────────────
    for (const s of slots) {
      const existingHold = await HeldSlot.findOne({
        turfId,
        date: s.date,
        slot: s.slot,
      });

      if (existingHold) {
        if (existingHold.userId === userId) {
          // Same user → refresh expiry (allow re-order)
          await HeldSlot.updateOne(
            { _id: existingHold._id },
            { 
              $set: { 
                expiresAt,
                totalAmount: total,
                paidAmount: payAmount,
                isAdvance: isAdvancePayment
              } 
            }
          );
          console.log(`Refreshed existing hold for user ${userId} → ${s.slot} on ${s.date}`);
          continue;
        } else {
          // Held by someone else
          return res.status(409).json({
            success: false,
            message: 'Slot is already reserved by another user',
            conflictingSlot: { date: s.date, slot: s.slot }
          });
        }
      }

      // No existing hold → create new one
      await HeldSlot.create({
        turfId,
        date: s.date,
        slot: s.slot,
        userId,
        expiresAt,
        totalAmount: total,
        paidAmount: payAmount,
        isAdvance: isAdvancePayment
      });
      console.log(`New hold created for user ${userId} → ${s.slot} on ${s.date}`);
    }

    // ────────────────────────────────────────────────
    // SAVE PENDING BOOKING
    // ────────────────────────────────────────────────
    const pendingBooking = new Booking({
      bookingId: uuidv4(),
      turfId,
      userId,
      turfName,
      slots,
      sport: sport || req.body.sport || 'CRICKET',
      totalAmount: total,
      paidAmount: payAmount,
      balanceAmount: total - payAmount,
      isAdvance: isAdvancePayment,
      advanceAmount: isAdvancePayment ? payAmount : total,
      paymentStatus: isAdvancePayment ? 'partial' : 'full',
      razorpayOrderId: null,
      status: 'pending',
      expiresAt
    });

    // Create Razorpay order
    const razorpayOrder = await rzp.orders.create({
      amount: Math.round(payAmount * 100),
      currency: 'INR',
      receipt: `booking_${turfId}_${Date.now()}`,
      notes: {
        user_id: userId,
        turf_id: turfId,
        is_advance: isAdvancePayment.toString(),
        advance_amount: (isAdvancePayment ? payAmount : total).toString(),
        total_amount: total.toString(),
        slots: JSON.stringify(slots)
      }
    });

    // Update booking with Razorpay order ID
    pendingBooking.razorpayOrderId = razorpayOrder.id;
    pendingBooking.orderId = razorpayOrder.id; // backward compatibility
    await pendingBooking.save();

    console.log(
      `PENDING BOOKING SAVED | BookingID: ${pendingBooking.bookingId} | ` +
      `Advance: ${isAdvancePayment} | Pay: ₹${payAmount} | Total: ₹${total} | ` +
      `OrderID: ${razorpayOrder.id}`
    );

    // Success response
    res.json({
      success: true,
      order_id: razorpayOrder.id,
      amount: Math.round(payAmount * 100),
      key: process.env.RAZORPAY_KEY_ID,
      isAdvance: isAdvancePayment,
      advanceAmount: isAdvancePayment ? payAmount : total,
      balanceAmount: isAdvancePayment ? (total - payAmount) : 0
    });

  } catch (error) {
    console.error('Create order error:', error.stack || error.message);
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Slot conflict detected (possibly already reserved)'
      });
    }
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create order. Please try again.',
      error: error.message 
    });
  }
});
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-razorpay-signature'];
        const generated = crypto
            .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
            .update(req.body)
            .digest('hex');

        if (generated !== signature) {
            console.warn('Invalid webhook signature');
            return res.status(400).json({ success: false, message: 'Invalid signature' });
        }

        const event = JSON.parse(req.body.toString());

        if (event.event === 'payment.captured') {
            const payment = event.payload.payment.entity;
            const { payment_id, order_id } = payment;

            // SEARCH BY razorpayOrderId — BULLETPROOF VERSION
let booking = await Booking.findOne({
    $or: [
        { razorpayOrderId: order_id },
        { orderId: order_id },
        { razorpayPaymentId: order_id }  // extra safety in case someone mixed up
    ]
});



            if (!booking) {
                console.log(`[Webhook] No booking found for Razorpay order: ${order_id} → Using fallback from notes`);
                return res.status(200).json({ success: true });
            }

            const wasAdvance = booking.isAdvance === true;
            const paidNow = booking.paidAmount;
            const total = booking.totalAmount;

            await Booking.findOneAndUpdate(
                { _id: booking._id },
                {
                    $set: {
                        paymentId: payment_id,
                        razorpayPaymentId: payment_id,
                        status: 'confirmed',
                        paidAt: new Date(),

                        // FINAL CORRECT STATUS
                        paymentStatus: wasAdvance ? 'partial' : 'full',
                        isFullyPaid: !wasAdvance,
                        balanceAmount: wasAdvance ? (total - paidNow) : 0,
                        advanceAmount: wasAdvance ? paidNow : total,
                    }
                }
            );

            console.log(`Payment confirmed | Order: ${order_id} | Advance: ${wasAdvance}`);
        }

        // Always respond 200 to Razorpay
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error.message);
        res.status(500).json({ success: false });
    }
});

// MANUAL VERIFY FOR LOCAL TESTING + FULL PUSH TO USER & ADMIN
app.post('/api/payments/verify-manual', async (req, res) => {
    try {
        const { paymentId, orderId } = req.body;

        if (!paymentId || !orderId) {
            return res.status(400).json({ success: false, message: 'paymentId and orderId required' });
        }

        console.log(`\n=== MANUAL VERIFY START ===`);
        console.log(`Payment ID: ${paymentId} | Order ID: ${orderId}`);

        // Find pending booking
        let booking = await Booking.findOne({
            $or: [
                { razorpayOrderId: orderId },
                { orderId: orderId }
            ]
        });

        if (!booking) {
            console.log('[ERROR] No pending booking found for this orderId');
            return res.status(404).json({ success: false, message: 'Booking not found' });
        }

        if (booking.status === 'confirmed') {
            console.log('[INFO] Booking already confirmed - returning existing data');
            return res.json({
                success: true,
                message: 'Already confirmed',
                isAdvance: booking.isAdvance,
                advanceAmount: booking.advanceAmount || booking.paidAmount,
                balanceAmount: booking.balanceAmount || 0,
                totalAmount: booking.totalAmount
            });
        }

        // CRITICAL VALUES
        const isAdvance = booking.isAdvance === true;
        const paidNow = booking.paidAmount || 0;           // Amount paid in this transaction
        const totalAmount = booking.totalAmount || 0;
        const balance = isAdvance ? (totalAmount - paidNow) : 0;
        const advanceAmt = isAdvance ? paidNow : totalAmount;

        console.log('[DEBUG] Booking values from pending document:');
        console.log('   isAdvance      :', isAdvance);
        console.log('   paidNow        :', paidNow);
        console.log('   totalAmount    :', totalAmount);
        console.log('   calculated balance :', balance);
        console.log('   advanceAmount  :', advanceAmt);

        // Confirm in Bookings collection
        await Booking.findOneAndUpdate(
            { _id: booking._id },
            {
                $set: {
                    paymentId: paymentId,
                    razorpayPaymentId: paymentId,
                    status: 'confirmed',
                    paidAt: new Date(),
                    paymentStatus: isAdvance ? 'partial' : 'full',
                    isFullyPaid: !isAdvance,
                    balanceAmount: balance,
                    advanceAmount: advanceAmt
                }
            }
        );

        // PUSH TO USER upcomingBookings (THIS IS WHAT THE APP READS)
        const userPushResult = await mongoose.connection.db.collection('users').updateOne(
            { firebaseUid: booking.userId },
            {
                $push: {
                    upcomingBookings: {
                        bookingId: booking.bookingId,
                        turfId: booking.turfId,
                        turfName: booking.turfName,
                        date: req.body.date,
                        slots: booking.slots,
                        sport: booking.sport ,
                        totalAmount: totalAmount,
                        paidAmount: paidNow,
                        balanceAmount: balance,
                        isAdvance: isAdvance,
                        advanceAmount: advanceAmt,
                        status: 'confirmed',
                        paymentStatus: isAdvance ? 'partial' : 'full',
                        paymentId: paymentId,
                        bookedAt: new Date()
                    }
                }
            }
        );

        console.log(`[USER PUSH] Modified ${userPushResult.modifiedCount} user document(s)`);

        

        // Clear held slots
        await HeldSlot.deleteMany({
            turfId: booking.turfId,
            userId: booking.userId,
            date: { $in: booking.slots.map(s => s.date) },
            slot: { $in: booking.slots.map(s => s.slot) }
        });

        console.log(`[SUCCESS] Booking fully confirmed & synced`);
        console.log(`   → Advance: ${isAdvance}`);
        console.log(`   → Paid Now: ₹${paidNow}`);
        console.log(`   → Balance Due: ₹${balance}`);
        console.log(`=== MANUAL VERIFY END ===\n`);

        res.json({
            success: true,
            message: "Booking confirmed successfully!",
            isAdvance: isAdvance,
            advanceAmount: advanceAmt,
            balanceAmount: balance,
            totalAmount: totalAmount,
            bookingId: booking.bookingId
        });

    } catch (error) {
        console.error('Manual verify error:', error.message);
        console.error(error.stack);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});
// REPLACE THIS ENTIRE ROUTE IN YOUR MAIN server.js FILE
app.post('/api/payments/create-tournament-order', async (req, res) => {
    try {
        const {
            userId,
            turfId,
            amount,
            turfName,
            tournamentId,
            teamName,
            captainName,
            captainPhone,
            playerNames
        } = req.body;

        if (!userId || !turfId || !amount || amount <= 0 || !tournamentId || !teamName) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Firebase Auth
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        let decoded;
        try {
            decoded = await admin.auth().verifyIdToken(token);
        } catch (error) {
            return res.status(401).json({ success: false, message: 'Invalid token' });
        }

        if (decoded.uid !== userId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        // Auto-create turf
        await ensureTurfExists(turfId, turfName);

        // Create Razorpay order
        const order = await rzp.orders.create({
            amount: Math.round(amount * 100),
            currency: 'INR',
            receipt: `tourn_${tournamentId}_${Date.now()}`,
            notes: {
                type: 'tournament_registration',
                tournamentId,
                teamName,
                userId,
                turfId
            }
        });

        res.json({
            success: true,
            order_id: order.id,
            amount: order.amount,
            key: process.env.RAZORPAY_KEY_ID
        });

    } catch (error) {
        console.error('Tournament order error:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/turf/:turfId/slots', async (req, res) => {
    try {
        const { turfId } = req.params;
        const { date, sport } = req.query;

        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const token = authHeader.split(' ')[1];
        let userId;

        // Try JWT first (your custom token)
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            userId = decoded.userId || decoded.firebaseUid;
        } catch (jwtError) {
            // Fallback to Firebase ID token
            try {
                const decoded = await admin.auth().verifyIdToken(token);
                userId = decoded.uid;
            } catch (firebaseError) {
                console.error('Token verification failed:', firebaseError.message);
                return res.status(401).json({ success: false, message: 'Invalid token' });
            }
        }

        // ──── IMPORTANT: Define now here ────
        const now = new Date();

        // Get turf document
        const adminUser = await Admin.findOne({ 'currentTurf.id': turfId });
        if (!adminUser || !adminUser.currentTurf) {
            return res.status(404).json({ success: false, message: 'Turf not found' });
        }

        const turf = adminUser.currentTurf;

        // 1. Admin permanent holds (from admin document array)
        const adminHeldSlots = (turf.heldSlots || [])
            .filter(h => !date || h.date === date);

        // 2. Full day hold check
        const dayHeld = (turf.heldDays || [])
            .some(d => d.date === date);

        // 3. Temporary user reservations — ONLY those not yet expired
        const userHeldSlots = await HeldSlot.find({
            turfId,
            ...(date && { date }),                // filter by specific date if provided
            expiresAt: { $gte: now }              // only show holds that are still valid
        }).lean();

        // 4. Confirmed (paid) bookings — filtered by sport if provided
        const confirmedBookings = await Booking.find({
            turfId,
            status: 'confirmed',
            ...(date && { 'slots.date': date }),
            ...(sport && { sport })               // better than { $exists: true }
        }).lean();

        // Flatten confirmed slots for response
        const confirmedSlotsFlat = [];
        for (const booking of confirmedBookings) {
            for (const slot of booking.slots) {
                if (!date || slot.date === date) {
                    confirmedSlotsFlat.push({
                        date: slot.date,
                        slot: slot.slot,
                        userId: booking.userId,
                        // Optional: add more fields if frontend needs them
                        // paymentId: booking.paymentId,
                        // bookedAt: booking.bookedAt
                    });
                }
            }
        }

        // Final response
        res.status(200).json({
            success: true,
            operationStartTime: turf.operationStartTime || '06:00 AM',
            operationEndTime: turf.operationEndTime || '10:00 PM',

            // Red slots — admin permanent holds
            heldSlots: adminHeldSlots.map(h => ({
                date: h.date,
                slot: h.slot,
                reason: h.reason || 'Held by admin'
            })),

            // Orange slots — temporary user reservations (non-expired)
            reservedSlots: userHeldSlots.map(h => ({
                date: h.date,
                slot: h.slot,
                // Optional: you can include expiresAt or userId if frontend wants to show countdown
                // expiresAt: h.expiresAt?.toISOString()
            })),

            // Green/gray slots — already confirmed bookings
            confirmedSlots: confirmedSlotsFlat,

            // Full day blocked
            heldDays: dayHeld ? [{ date, reason: 'Full day held' }] : [],

            loggedInUserId: userId,
        });

    } catch (error) {
        console.error('Slot fetch error:', error.stack || error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch slots',
            // Only show detailed error in development (optional)
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});
        // === USER BOOKINGS ===
        app.get('/api/user/bookings', async (req, res) => {
            try {
                const authHeader = req.headers.authorization;
                if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Unauthorized' });
                const token = authHeader.split(' ')[1];
                let decoded;
                try { decoded = await admin.auth().verifyIdToken(token); } catch { return res.status(401).json({ success: false, message: 'Invalid token' }); }

                const user = await mongoose.connection.db.collection('users').findOne({ firebaseUid: decoded.uid });
                if (!user) return res.status(404).json({ success: false, message: 'User not found' });

                const bookings = (user.upcomingBookings || []).map(b => ({
                    ...b,
                    date: b.slots[0]?.date || 'N/A',
                    time: b.slots[0]?.slot || 'N/A',
                })).sort((a, b) => new Date(b.bookedAt || 0) - new Date(a.bookedAt || 0));

                res.status(200).json({ success: true, bookings });
            } catch (error) {
                console.error('Bookings fetch error:', error.message);
                res.status(500).json({ success: false, message: 'Failed' });
            }
        });

        // === /api/home (FOR BOOKINGS SCREEN) ===
        app.get('/api/home', async (req, res) => {
            try {
                const token = req.headers.authorization?.split(' ')[1];
                if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

                const decoded = await admin.auth().verifyIdToken(token);
                const user = await mongoose.connection.db.collection('users').findOne({ firebaseUid: decoded.uid });
                if (!user) return res.status(404).json({ success: false, message: 'User not found' });

                const upcomingBookings = (user.upcomingBookings || [])
                    .filter(b => b.status === 'confirmed')
                    .sort((a, b) => new Date(b.bookedAt) - new Date(a.bookedAt));

                res.json({ success: true, upcomingBookings });
            } catch (error) {
                console.error('Home API error:', error.message);
                res.status(500).json({ success: false, message: 'Failed' });
            }
        });

        
                // IMPROVED CRON JOB WITH BOOKING REMINDERS + CLEANUP (FINAL ROBUST VERSION)
        cron.schedule('*/3 * * * *', async () => {  // Every 30 minutes (TEST MODE - change to */30 for production)
            try {
                const now = new Date();
                console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] ⏰ Running b booking reminder cron job...`);

                const reminders = [
                    { hours: 1,  text: '1 hour' },
                    { hours: 6,  text: '6 hours' },
                    { hours: 24, text: '1 day' }
                ];

                // Get all confirmed bookings
                const bookings = await Booking.find({ status: 'confirmed' }).lean();

                let reminderCount = 0;

                for (const booking of bookings) {
                    if (!booking.slots || booking.slots.length === 0) continue;

                    const firstSlot = booking.slots[0];

                    // === ROBUST DATE PARSING (supports YYYY-MM-DD and DD-MM-YYYY) ===
                    let playDateStr;
                    if (firstSlot.date.includes('-')) {
                        const parts = firstSlot.date.split('-').map(p => p.trim());
                        if (parts.length !== 3) {
                            console.warn(`Invalid date format for booking ${booking.bookingId}: ${firstSlot.date}`);
                            continue;
                        }
                        if (parts[0].length === 4) {
                            // YYYY-MM-DD format
                            playDateStr = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
                        } else {
                            // DD-MM-YYYY format
                            playDateStr = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
                        }
                    } else {
                        console.warn(`Invalid date format for booking ${booking.bookingId}: ${firstSlot.date}`);
                        continue;
                    }

                    // === ROBUST TIME PARSING ===
                    const timeMatch = firstSlot.slot.match(/(\d{1,2}:\d{2}\s*(AM|PM|am|pm))/i);
                    if (!timeMatch) {
                        console.warn(`Invalid time format for booking ${booking.bookingId}: ${firstSlot.slot}`);
                        continue;
                    }
                    const startTime = timeMatch[1].trim(); // e.g., "7:00 PM" or "06:00 AM"

                    // Construct full datetime string
                    const dateTimeStr = `${playDateStr} ${startTime}`;
                    const playDateTime = new Date(dateTimeStr);

                    if (isNaN(playDateTime.getTime())) {
                        console.warn(`Failed to parse date/time for booking ${booking.bookingId}: ${dateTimeStr}`);
                        continue;
                    }

                    let sent = false;
                    for (const r of reminders) {
                        const reminderTime = new Date(playDateTime.getTime() - r.hours * 60 * 60 * 1000);
                        const diffMins = Math.abs((now - reminderTime) / (1000 * 60));

                        
                        if (diffMins <= 30 && !sent) {
                            await sendNotificationToTopic(
                                'booking_reminders',
                                `⏰ ${r.text} until your game!`,
                                `Your slot at ${booking.turfName} starts soon! Get ready ⚡`,
                                {
                                    type: 'booking_reminder',
                                    bookingId: booking.bookingId,
                                    turfId: booking.turfId,
                                    turfName: booking.turfName
                                }
                            );
                            reminderCount++;
                            sent = true;
                            console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Reminder sent: ${r.text} for booking ${booking.bookingId}`);
                        }
                    }
                }

                console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] ✅ Sent ${reminderCount} booking reminders`);

                // === EXISTING CLEANUP LOGIC (KEEP THIS!) ===
                const heldResult = await HeldSlot.deleteMany({ expiresAt: { $lt: now } });
                if (heldResult.deletedCount > 0) {
                    console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Cleared ${heldResult.deletedCount} expired held slots`);
                }

                const adminResult = await Admin.updateMany(
                    { "currentTurf": { $ne: null } },
                    { 
                        $pull: { 
                            "currentTurf.heldSlots": { 
                                expiresAt: { $lt: now } 
                            } 
                        } 
                    }
                );

                if (adminResult.modifiedCount > 0) {
                    console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Cleared expired heldSlots from ${adminResult.modifiedCount} turf admins`);
                }

            } catch (error) {
                console.error(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] ❌ Cron job error:`, error.message);
            }
        });

            const PORT = process.env.PORT || 3000;
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Server running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] MongoDB error: ${err.message}`);
        process.exit(1);
    });