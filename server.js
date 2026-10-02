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

app.use((req, res, next) => {
    console.log(
        `[${new Date().toLocaleString()}] ${req.method} ${req.originalUrl}`
    );
    next();
});
// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    
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
        
    } catch (error) {
        console.error(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] FCM Error: ${error.message}`);
    }
}

async function reconcileCapturedPayment({
  paymentId,
  orderId,
  paymentEntity = null
}) {
  const Booking =
    mongoose.models.Booking || mongoose.model("Booking");

  const HeldSlot =
    mongoose.models.HeldSlot || mongoose.model("HeldSlot");

  const SlotBookingLock =
    mongoose.models.SlotBookingLock ||
    mongoose.model("SlotBookingLock", SlotBookingLockSchema);

  if (!paymentId || !orderId) {
    throw new Error("paymentId and orderId are required");
  }

  let payment = paymentEntity;

  if (!payment) {
    payment = await razorpay.payments.fetch(paymentId);
  }

  if (!payment) {
    throw new Error("Razorpay payment not found");
  }

  if (payment.order_id !== orderId) {
    throw new Error(
      `Payment order mismatch. Expected ${orderId}, got ${payment.order_id}`
    );
  }

  if (payment.status !== "captured") {
    throw new Error(
      `Payment is not captured. Current status: ${payment.status}`
    );
  }

  let booking = await Booking.findOne({
    $or: [
      { razorpayOrderId: orderId },
      { orderId: orderId }
    ]
  });

  if (!booking) {
    throw new Error(
      `No booking found for Razorpay order ${orderId}`
    );
  }

  if (
    booking.status === "confirmed" &&
    (
      booking.paymentId === paymentId ||
      booking.razorpayPaymentId === paymentId
    )
  ) {
    return {
      success: true,
      alreadyProcessed: true,
      booking
    };
  }

  const razorpayAmount = Number(payment.amount);
  const bookingPaidAmount = Number(booking.paidAmount);

  if (!Number.isFinite(razorpayAmount)) {
    throw new Error("Invalid Razorpay payment amount");
  }

  if (!Number.isFinite(bookingPaidAmount)) {
    throw new Error("Invalid booking paid amount");
  }

  // Razorpay amount is in paise.
  const razorpayAmountRupees = razorpayAmount / 100;

  // Small floating point tolerance.
  const amountDifference = Math.abs(
    razorpayAmountRupees - bookingPaidAmount
  );

  if (amountDifference > 0.01) {
    throw new Error(
      `Payment amount mismatch. Razorpay=${razorpayAmountRupees}, Booking=${bookingPaidAmount}`
    );
  }

  if (
    !booking.turfId ||
    !booking.userId ||
    !Array.isArray(booking.slots) ||
    booking.slots.length === 0
  ) {
    throw new Error(
      `Booking ${booking.bookingId} does not contain valid turf/user/slot information`
    );
  }

  const bookingSlots = booking.slots.map((item) => ({
    date: String(item.date),
    slot: String(item.slot)
  }));

  // Remove duplicates just in case.
  const uniqueSlotKeys = [
    ...new Set(
      bookingSlots.map(
        (item) => `${item.date}|||${item.slot}`
      )
    )
  ];

  const acquiredLocks = [];

  try {
    for (const key of uniqueSlotKeys) {
      const [date, slot] = key.split("|||");

      const existingOwnLock =
        await SlotBookingLock.findOne({
          turfId: String(booking.turfId),
          date,
          slot,
          bookingId: String(booking.bookingId)
        });

      if (existingOwnLock) {
        acquiredLocks.push(existingOwnLock);
        continue;
      }

      try {
        const lock =
          await SlotBookingLock.create({
            turfId: String(booking.turfId),
            date,
            slot,
            bookingId: String(booking.bookingId),
            userId: String(booking.userId)
          });

        acquiredLocks.push(lock);
      } catch (lockError) {
        if (lockError && lockError.code === 11000) {
          const owner =
            await SlotBookingLock.findOne({
              turfId: String(booking.turfId),
              date,
              slot
            }).lean();

          if (
            owner &&
            String(owner.bookingId) ===
              String(booking.bookingId)
          ) {
            acquiredLocks.push(owner);
            continue;
          }

          throw new Error(
            `SLOT_ALREADY_BOOKED:${date}:${slot}`
          );
        }

        throw lockError;
      }
    }

    booking = await Booking.findById(booking._id);

    if (!booking) {
      throw new Error("Booking disappeared during reconciliation");
    }

    if (booking.status === "confirmed") {
      return {
        success: true,
        alreadyProcessed: true,
        booking
      };
    }

    const totalAmount = Number(booking.totalAmount || 0);
    const paidAmount = Number(booking.paidAmount || 0);

    let paymentStatus = "full";
    let isFullyPaid = true;
    let balanceAmount = 0;
    let advanceAmount = paidAmount;

    if (totalAmount > paidAmount) {
      paymentStatus = "partial";
      isFullyPaid = false;
      balanceAmount = totalAmount - paidAmount;
    }

    const confirmedBooking =
      await Booking.findOneAndUpdate(
        {
          _id: booking._id,
          status: "pending"
        },
        {
          $set: {
            paymentId: paymentId,
            razorpayPaymentId: paymentId,
            razorpayOrderId: orderId,
            orderId: orderId,

            status: "confirmed",

            paymentStatus,
            isFullyPaid,

            balanceAmount,
            advanceAmount,

            paidAt: new Date(),
            bookedAt: booking.bookedAt || new Date()
          }
        },
        {
          new: true
        }
      );

    if (!confirmedBooking) {
      const latestBooking =
        await Booking.findById(booking._id);

      if (
        latestBooking &&
        latestBooking.status === "confirmed"
      ) {
        return {
          success: true,
          alreadyProcessed: true,
          booking: latestBooking
        };
      }

      throw new Error(
        "Booking could not be confirmed because its state changed"
      );
    }

    booking = confirmedBooking;

    const User =
      mongoose.models.User ||
      mongoose.models.users ||
      mongoose.model("User");

    try {
      await User.updateOne(
        {
          uid: booking.userId
        },
        {
          $addToSet: {
            upcomingBookings: {
              bookingId: booking.bookingId,
              turfId: booking.turfId,
              turfName: booking.turfName,
              slots: booking.slots,
              sport: booking.sport,
              totalAmount: booking.totalAmount,
              paidAmount: booking.paidAmount,
              balanceAmount: booking.balanceAmount,
              paymentStatus: booking.paymentStatus,
              status: "confirmed",
              bookedAt: booking.bookedAt,
              paymentId: paymentId,
              razorpayOrderId: orderId
            }
          }
        }
      );
    } catch (userUpdateError) {
      console.error(
        "Failed to update user upcomingBookings:",
        userUpdateError
      );
    }

    const holdOrConditions = bookingSlots.map(
      ({ date, slot }) => ({
        turfId: String(booking.turfId),
        date,
        slot,
        userId: String(booking.userId)
      })
    );

    if (holdOrConditions.length > 0) {
      await HeldSlot.deleteMany({
        $or: holdOrConditions
      });
    }

    return {
      success: true,
      alreadyProcessed: false,
      booking
    };

  } catch (error) {

    if (
      error &&
      typeof error.message === "string" &&
      error.message.startsWith("SLOT_ALREADY_BOOKED:")
    ) {
      try {
        await SlotBookingLock.deleteMany({
          bookingId: String(booking.bookingId)
        });
      } catch (cleanupError) {
        console.error(
          "Failed to cleanup SlotBookingLock:",
          cleanupError
        );
      }

      throw new Error(
        "PAYMENT_CAPTURED_SLOT_UNAVAILABLE"
      );
    }
    try {
      if (acquiredLocks.length > 0) {
        await SlotBookingLock.deleteMany({
          bookingId: String(booking.bookingId)
        });
      }
    } catch (cleanupError) {
      console.error(
        "Failed to cleanup temporary slot locks:",
        cleanupError
      );
    }

    throw error;
  }
}

async function reconcilePendingPayments() {
    try {
        const Booking = mongoose.models.Booking;

        if (!Booking) {
            throw new Error('Booking model is not initialized');
        }

        const pendingBookings = await Booking.find({
            paymentStatus: 'pending',
            status: 'pending',
            razorpayOrderId: { $exists: true, $ne: null }
        })
            .sort({ bookedAt: 1 })
            .limit(100);

        if (!pendingBookings.length) {
            return;
        }

        for (const booking of pendingBookings) {
            try {
                const orderId = booking.razorpayOrderId;

                const payments = await rzp.orders.fetchPayments(orderId);

                const capturedPayment = payments.items?.find(
                    payment =>
                        payment.order_id === orderId &&
                        payment.status === 'captured'
                );

                if (!capturedPayment) {
                    continue;
                }

                await reconcileCapturedPayment({
                    orderId,
                    paymentId: capturedPayment.id,
                    paymentEntity: capturedPayment
                });

            } catch (error) {
                console.error(
                    `Pending payment reconciliation failed for booking ${booking.bookingId}:`,
                    error.message
                );
            }
        }
    } catch (error) {
        console.error(
            'Pending payment reconciliation failed:',
            error.message
        );
    }
}


app.post(
    '/api/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {

        try {

            const signature =
                req.headers['x-razorpay-signature'];

            if (!signature) {
                return res.status(400).json({
                    success: false,
                    message: 'Missing Razorpay signature'
                });
            }
            const expectedSignature =
                crypto
                    .createHmac(
                        'sha256',
                        process.env.RAZORPAY_WEBHOOK_SECRET
                    )
                    .update(req.body)
                    .digest('hex');

            const receivedBuffer =
                Buffer.from(signature, 'utf8');

            const expectedBuffer =
                Buffer.from(expectedSignature, 'utf8');

            if (
                receivedBuffer.length !==
                expectedBuffer.length ||
                !crypto.timingSafeEqual(
                    receivedBuffer,
                    expectedBuffer
                )
            ) {

                console.error(
                    'Invalid Razorpay webhook signature'
                );

                return res.status(401).json({
                    success: false,
                    message: 'Invalid webhook signature'
                });
            }

            const event = JSON.parse(
                req.body.toString('utf8')
            );

            console.log(
                'Razorpay webhook received:',
                event.event
            );

            if (event.event === 'payment.captured') {

                const paymentEntity =
                    event.payload?.payment?.entity;

                if (!paymentEntity) {
                    throw new Error(
                        'Payment entity missing from webhook'
                    );
                }

                const paymentId =
                    paymentEntity.id;

                const orderId =
                    paymentEntity.order_id;

                if (!paymentId || !orderId) {
                    throw new Error(
                        'Payment ID or Order ID missing'
                    );
                }

                await reconcileCapturedPayment({
                    paymentId,
                    orderId,
                    paymentEntity
                });

                console.log(
                    `Payment reconciled successfully: ${paymentId}`
                );
            }

            return res.status(200).json({
                success: true,
                received: true
            });

        } catch (error) {

            console.error(
                'Razorpay webhook reconciliation error:',
                error.message
            );

            return res.status(500).json({
                success: false,
                message: 'Webhook processing failed'
            });
        }
    }
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const uploadsPath = path.join(__dirname, '..', 'admin-backend', 'uploads');

app.use('/uploads', express.static(uploadsPath));

 
// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
            
            const User = require('./models/User'); 
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
            sport: { type: String, required: true },
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

        const SlotBookingLockSchema = new mongoose.Schema(
  {
    turfId: {
      type: String,
      required: true,
      index: true
    },

    date: {
      type: String,
      required: true,
      index: true
    },

    slot: {
      type: String,
      required: true,
      index: true
    },

    bookingId: {
      type: String,
      required: true,
      index: true
    },

    userId: {
      type: String,
      required: true,
      index: true
    },

    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

SlotBookingLockSchema.index(
  { turfId: 1, date: 1, slot: 1 },
  { unique: true }
);

const SlotBookingLock =
  mongoose.models.SlotBookingLock ||
  mongoose.model("SlotBookingLock", SlotBookingLockSchema);

        const AdminSchema = new mongoose.Schema({
            currentTurf: {
                id: String,
                name: String,
                sports: [String],
                confirmedSlots: [{ date: String, slot: String, userId: String, paymentId: String, totalAmount: Number, paidAmount: Number, isAdvance: Boolean, bookedAt: Date }],
                heldSlots: [{
    sport: String,
    date: String,
    slot: String,
    reason: String,
    adminId: String,
    userId: String,
    expiresAt: Date,
    timestamp: Date
}],
                heldDays: [{ date: String }],
                bookingCount: { type: Number, default: 0 },
            },
        }, { collection: 'admins' });

        const Booking = mongoose.model('Booking', BookingSchema);
        const HeldSlot = mongoose.model('HeldSlot', HeldSlotSchema);
        const Admin = mongoose.model('Admin', AdminSchema);
        

        // === TURF ROUTES (Now models are safely registered) ===
        const turfRouter = require('./routes/turf');
        const routeRoutes = require('./routes/routes');
        const turfRoutes = turfRouter.stack
            .filter(layer => layer.route)
            .map(layer => ({
                path: layer.route.path,
                methods: Object.keys(layer.route.methods).join(', '),
            }));
        
        app.use('/api', turfRouter);
        app.use('/api', routeRoutes);

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

// === REFRESH GOTURF JWT ===
app.post('/api/auth/refresh', async (req, res) => {
    try {
        const { firebaseToken } = req.body;

        if (!firebaseToken) {
            return res.status(400).json({
                success: false,
                message: 'Firebase token required'
            });
        }

        // Verify Firebase ID token
        let decoded;

        try {
            decoded = await admin.auth().verifyIdToken(firebaseToken);
        } catch (error) {
            return res.status(401).json({
                success: false,
                message: 'Invalid Firebase token'
            });
        }

        const firebaseUid = decoded.uid;

        // Find GoTurf user
        const db = mongoose.connection.db;

        const user = await db.collection('users').findOne({
            firebaseUid: firebaseUid
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Generate new GoTurf JWT
        const token = jwt.sign(
            {
                userId: user.userId,
                firebaseUid: user.firebaseUid
            },
            process.env.JWT_SECRET,
            {
                expiresIn: '7d'
            }
        );

        return res.status(200).json({
            success: true,
            token: token
        });

    } catch (error) {
        console.error('Refresh token error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

app.post('/api/payments/create-order', async (req, res) => {

    try {

        const {
            userId,
            turfId,
            slots,
            amount,
            totalAmount,
            isAdvance
        } = req.body;


        // =========================================================
        // 1. BASIC VALIDATION
        // =========================================================

        if (
            !userId ||
            !turfId ||
            !Array.isArray(slots) ||
            slots.length === 0
        ) {

            return res.status(400).json({
                success: false,
                message: 'Invalid booking details'
            });

        }


        // =========================================================
        // 2. FIREBASE AUTHENTICATION
        // =========================================================

        const token =
            req.headers.authorization?.split(' ')[1];

        if (!token) {

            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });

        }


        let decoded;

        try {

            decoded =
                await admin.auth().verifyIdToken(token);

        } catch (error) {

            return res.status(401).json({
                success: false,
                message: 'Invalid authentication token'
            });

        }


        if (decoded.uid !== userId) {

            return res.status(403).json({
                success: false,
                message: 'Unauthorized user'
            });

        }


        // =========================================================
        // 3. GET MODELS
        // =========================================================

        const Booking =
            mongoose.models.Booking;

        const HeldSlot =
            mongoose.models.HeldSlot;


        if (!Booking || !HeldSlot) {

            return res.status(500).json({
                success: false,
                message: 'Booking system unavailable'
            });

        }


        const now = new Date();


        // =========================================================
        // 4. NORMALIZE / VALIDATE SLOTS
        // =========================================================

        const normalizedSlots = slots.map(item => ({
            date: String(item.date),
            slot: String(item.slot)
        }));


        const uniqueSlotKeys =
            new Set(
                normalizedSlots.map(
                    item => `${item.date}__${item.slot}`
                )
            );


        if (
            uniqueSlotKeys.size !==
            normalizedSlots.length
        ) {

            return res.status(400).json({
                success: false,
                message: 'Duplicate slots detected'
            });

        }


        // =========================================================
        // 5. VERIFY ACTIVE HELD SLOTS
        //
        // IMPORTANT:
        // The booking is allowed only if every requested slot
        // belongs to THIS USER and is still active.
        // =========================================================

        const holdQueries =
            normalizedSlots.map(item => ({
                turfId: turfId,
                userId: userId,
                date: item.date,
                slot: item.slot,
                expiresAt: {
                    $gt: now
                }
            }));


        const heldSlots =
            await HeldSlot.find({
                $or: holdQueries
            });


        if (
            heldSlots.length !==
            normalizedSlots.length
        ) {

            return res.status(409).json({
                success: false,
                message:
                    'One or more selected slots are no longer available'
            });

        }


        // =========================================================
        // 6. MAKE SURE EVERY REQUESTED SLOT WAS FOUND
        // =========================================================

        const heldSlotKeys =
            new Set(
                heldSlots.map(
                    hold =>
                        `${hold.date}__${hold.slot}`
                )
            );


        for (const slot of normalizedSlots) {

            const key =
                `${slot.date}__${slot.slot}`;

            if (!heldSlotKeys.has(key)) {

                return res.status(409).json({
                    success: false,
                    message:
                        `Slot ${slot.date} ${slot.slot} is no longer available`
                });

            }

        }


        // =========================================================
        // 7. SERVER-SIDE BOOKING AMOUNT
        //
        // NEVER TRUST amount / totalAmount FROM FLUTTER.
        // =========================================================

        const serverTotalAmount =
            Number(
                heldSlots[0].totalAmount || 0
            );


        const serverPaidAmount =
            Number(
                heldSlots[0].paidAmount || 0
            );


        const serverIsAdvance =
            heldSlots[0].isAdvance === true;


        if (
            serverTotalAmount <= 0 ||
            serverPaidAmount <= 0
        ) {

            return res.status(400).json({
                success: false,
                message:
                    'Invalid server-side booking amount'
            });

        }


        // =========================================================
        // 8. VERIFY ALL HELD SLOTS HAVE SAME BOOKING DATA
        // =========================================================

        const serverSport =
            heldSlots[0].sport;


        if (!serverSport) {

            return res.status(400).json({
                success: false,
                message:
                    'Sport information missing from held slot'
            });

        }


        for (const hold of heldSlots) {

            if (
                Number(hold.totalAmount || 0) !==
                    serverTotalAmount ||

                Number(hold.paidAmount || 0) !==
                    serverPaidAmount ||

                hold.isAdvance !==
                    serverIsAdvance ||

                hold.sport !==
                    serverSport
            ) {

                return res.status(409).json({
                    success: false,
                    message:
                        'Booking information is inconsistent'
                });

            }

        }


        // =========================================================
        // 9. OPTIONAL CLIENT AMOUNT CHECK
        //
        // This is only a consistency check.
        // Server values remain authoritative.
        // =========================================================

        if (
            amount !== undefined &&
            Math.round(Number(amount) * 100) !==
                Math.round(serverPaidAmount * 100)
        ) {

            return res.status(400).json({
                success: false,
                message:
                    'Payment amount mismatch'
            });

        }


        if (
            totalAmount !== undefined &&
            Math.round(Number(totalAmount) * 100) !==
                Math.round(serverTotalAmount * 100)
        ) {

            return res.status(400).json({
                success: false,
                message:
                    'Total amount mismatch'
            });

        }


        // =========================================================
        // 10. GET TURF NAME FROM DATABASE
        //
        // Do NOT trust turfName sent by Flutter.
        // =========================================================

        const db =
            mongoose.connection.db;


        const adminTurf =
            await db.collection('admins').findOne(
                {
                    'currentTurf.id': turfId
                },
                {
                    projection: {
                        'currentTurf.turfName': 1,
                        'currentTurf.name': 1,
                        name: 1
                    }
                }
            );


        const serverTurfName =
            adminTurf?.currentTurf?.turfName ||
            adminTurf?.currentTurf?.name ||
            adminTurf?.name;


        if (!serverTurfName) {

            return res.status(404).json({
                success: false,
                message:
                    'Turf information not found'
            });

        }


        // =========================================================
        // 11. CHECK FOR EXISTING PENDING BOOKING
        // =========================================================

        const existingPendingBooking =
            await Booking.findOne({

                userId: userId,

                turfId: turfId,

                status: 'pending',

                paymentStatus: 'pending',

                'slots.date': {
                    $in:
                        normalizedSlots.map(
                            s => s.date
                        )
                },

                'slots.slot': {
                    $in:
                        normalizedSlots.map(
                            s => s.slot
                        )
                }

            });


        if (existingPendingBooking) {

            // Existing booking already has Razorpay order
            if (
                existingPendingBooking.razorpayOrderId
            ) {

                return res.json({

                    success: true,

                    existingBooking: true,

                    bookingId:
                        existingPendingBooking.bookingId,

                    orderId:
                        existingPendingBooking.razorpayOrderId,

                    // Flutter currently expects this key
                    order_id:
                        existingPendingBooking.razorpayOrderId,

                    amount:
                        existingPendingBooking.paidAmount

                });

            }


            // A broken pending booking exists without
            // a Razorpay order. Remove it so a clean
            // booking can be created below.
            await Booking.deleteOne({
                _id:
                    existingPendingBooking._id
            });

        }


        // =========================================================
        // 12. CREATE UNIQUE BOOKING ID
        // =========================================================

        const bookingId =
            uuidv4();


        // =========================================================
        // 13. CREATE PENDING BOOKING BEFORE RAZORPAY
        // =========================================================

        const booking =
            await Booking.create({

                bookingId:

                    bookingId,

                userId:

                    userId,

                turfId:

                    turfId,

                turfName:

                    serverTurfName,

                slots:

                    normalizedSlots,

                sport:

                    serverSport,

                totalAmount:

                    serverTotalAmount,

                paidAmount:

                    serverPaidAmount,

                isAdvance:

                    serverIsAdvance,

                advanceAmount:

                    serverIsAdvance
                        ? serverPaidAmount
                        : serverTotalAmount,

                balanceAmount:

                    serverIsAdvance
                        ? Math.max(
                            serverTotalAmount -
                            serverPaidAmount,
                            0
                        )
                        : 0,

                isFullyPaid:

                    false,

                paymentStatus:

                    'pending',

                status:

                    'pending',

                bookedAt:

                    new Date(),

                expiresAt:

                    new Date(
                        now.getTime() +
                        60 * 60 * 1000
                    )

            });


        // =========================================================
        // 14. CREATE RAZORPAY ORDER
        // =========================================================

        let razorpayOrder;

        try {

            razorpayOrder =
                await rzp.orders.create({

                    amount:
                        Math.round(
                            serverPaidAmount * 100
                        ),

                    currency:
                        'INR',

                    receipt:
                        bookingId,

                    notes: {

                        bookingId:
                            bookingId,

                        userId:
                            userId,

                        turfId:
                            turfId,

                        sport:
                            serverSport

                    }

                });

        } catch (razorpayError) {

            // Razorpay order was not created.
            // Remove the pending DB record so
            // retry does not get stuck.

            await Booking.deleteOne({
                _id:
                    booking._id
            });

            throw razorpayError;

        }


        // =========================================================
        // 15. SAVE RAZORPAY ORDER ID
        // =========================================================

        booking.razorpayOrderId =
            razorpayOrder.id;

        booking.orderId =
            razorpayOrder.id;


        await booking.save();


        // =========================================================
        // 16. RESPONSE
        // =========================================================

        return res.status(200).json({

            success: true,

            bookingId:
                booking.bookingId,

            // Keep both names for compatibility
            orderId:
                razorpayOrder.id,

            order_id:
                razorpayOrder.id,

            amount:
                serverPaidAmount,

            totalAmount:
                serverTotalAmount,

            isAdvance:
                serverIsAdvance,

            advanceAmount:
                serverIsAdvance
                    ? serverPaidAmount
                    : serverTotalAmount,

            balanceAmount:
                serverIsAdvance
                    ? Math.max(
                        serverTotalAmount -
                        serverPaidAmount,
                        0
                    )
                    : 0

        });


    } catch (error) {

        console.error(
            'Create order error:',
            error.message
        );


        if (error.code === 11000) {

            return res.status(409).json({

                success: false,

                message:
                    'Slot conflict detected'

            });

        }


        return res.status(500).json({

            success: false,

            message:
                'Failed to create payment order'

        });

    }

});

app.post('/api/payments/verify-manual', async (req, res) => {

    try {

        const {
            paymentId,
            orderId
        } = req.body;

        if (!paymentId || !orderId) {

            return res.status(400).json({
                success: false,
                message:
                    'paymentId and orderId required'
            });
        }

        const token =
            req.headers.authorization?.split(' ')[1];

        if (!token) {

            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        let decoded;

        try {

            decoded =
                await admin.auth().verifyIdToken(token);

        } catch (error) {

            return res.status(401).json({
                success: false,
                message: 'Invalid authentication token'
            });
        }

        const Booking = mongoose.models.Booking;

        if (!Booking) {

            return res.status(500).json({
                success: false,
                message: 'Booking system unavailable'
            });
        }

        const booking =
            await Booking.findOne({
                $or: [
                    {
                        razorpayOrderId: orderId
                    },
                    {
                        orderId: orderId
                    }
                ]
            });

        if (!booking) {

            return res.status(404).json({
                success: false,
                message:
                    'Booking not found for this payment'
            });
        }

        if (booking.userId !== decoded.uid) {

            return res.status(403).json({
                success: false,
                message: 'Unauthorized booking'
            });
        }

        if (booking.status === 'confirmed') {

            return res.json({

                success: true,

                message:
                    'Booking already confirmed',

                bookingId:
                    booking.bookingId,

                paymentStatus:
                    booking.paymentStatus,

                isAdvance:
                    booking.isAdvance,

                advanceAmount:
                    booking.advanceAmount ||
                    booking.paidAmount,

                balanceAmount:
                    booking.balanceAmount || 0,

                totalAmount:
                    booking.totalAmount
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

        if (payment.order_id !== orderId) {

            return res.status(400).json({
                success: false,
                message:
                    'Payment/order mismatch'
            });
        }

        if (payment.status !== 'captured') {

            return res.status(400).json({
                success: false,
                message:
                    `Payment is not captured. Status: ${payment.status}`
            });
        }

        const expectedAmount =
            Number(booking.paidAmount || 0);

        const receivedAmount =
            Number(payment.amount || 0) / 100;

        if (
            Math.round(expectedAmount * 100) !==
            Math.round(receivedAmount * 100)
        ) {

            return res.status(400).json({
                success: false,
                message:
                    'Payment amount mismatch'
            });
        }

        const result =
            await reconcileCapturedPayment({

                paymentId:
                    paymentId,

                orderId:
                    orderId,

                paymentEntity:
                    payment
            });

        return res.json({

            success: true,

            message:
                result.alreadyConfirmed
                    ? 'Booking already confirmed'
                    : 'Payment verified and booking confirmed',

            bookingId:
                result.booking.bookingId,

            isAdvance:
                result.booking.isAdvance,

            advanceAmount:
                result.booking.advanceAmount,

            balanceAmount:
                result.booking.balanceAmount,

            totalAmount:
                result.booking.totalAmount,

            paymentStatus:
                result.booking.paymentStatus
        });

    } catch (error) {

        console.error(
            'Payment verification error:',
            error.message
        );

        return res.status(500).json({
            success: false,
            verificationPending: true,
            message:
                'Payment received. Booking confirmation is pending.'
        });
    }
});

app.get('/api/user/payment-recovery', async (req, res) => {
    try {
        const token =
            req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const decoded =
            await admin.auth().verifyIdToken(token);

        const userId = decoded.uid;

        const Booking = mongoose.models.Booking;

        if (!Booking) {
            return res.status(500).json({
                success: false,
                message: 'Booking model unavailable'
            });
        }

        const pendingBookings =
            await Booking.find({
                userId,
                status: 'pending',
                razorpayOrderId: {
                    $exists: true,
                    $ne: null
                }
            }).sort({
                createdAt: -1
            });

        const recovered = [];
        const stillPending = [];
        const failed = [];

        for (const booking of pendingBookings) {
            try {
                const orderId =
                    booking.razorpayOrderId ||
                    booking.orderId;

                if (!orderId) {
                    continue;
                }

                const payments =
                    await rzp.orders.fetchPayments(orderId);

                const capturedPayment =
                    (payments.items || []).find(
                        p =>
                            p.status === 'captured' &&
                            p.order_id === orderId
                    );

                if (!capturedPayment) {
                    stillPending.push({
                        bookingId: booking.bookingId,
                        orderId,
                        status: 'payment_pending'
                    });

                    continue;
                }

                const result =
                    await reconcileCapturedPayment({
                        paymentId: capturedPayment.id,
                        orderId,
                        paymentEntity: capturedPayment
                    });

                recovered.push({
                    bookingId:
                        result.booking.bookingId,
                    orderId,
                    paymentId:
                        capturedPayment.id,
                    status: 'confirmed'
                });

            } catch (error) {
                console.error(
                    `Payment recovery failed for booking ${booking.bookingId}:`,
                    error.message
                );

                failed.push({
                    bookingId: booking.bookingId,
                    orderId:
                        booking.razorpayOrderId ||
                        booking.orderId,
                    message: error.message
                });
            }
        }

        return res.json({
            success: true,
            recovered,
            stillPending,
            failed
        });

    } catch (error) {
        console.error(
            'Payment recovery error:',
            error
        );

        return res.status(500).json({
            success: false,
            message: 'Payment recovery failed'
        });
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
        const { date } = req.query;

        // Normalize sport
        const sport = (req.query.sport || "").trim().toUpperCase();

        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized'
            });
        }

        const token = authHeader.split(' ')[1];
        let userId;

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            userId = decoded.userId || decoded.firebaseUid;
        } catch {
            try {
                const decoded = await admin.auth().verifyIdToken(token);
                userId = decoded.uid;
            } catch (e) {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid token'
                });
            }
        }

        const now = new Date();

        const adminUser = await Admin.findOne({
            'currentTurf.id': turfId
        });

        if (!adminUser || !adminUser.currentTurf) {
            return res.status(404).json({
                success: false,
                message: 'Turf not found'
            });
        }

        const turf = adminUser.currentTurf;

      

        // Admin held slots
        const adminHeldSlots = (turf.heldSlots || []).filter(h => {


    const sportMatch =
        (h.sport || "").trim().toUpperCase() ===
        (sport || "").trim().toUpperCase();

    const dateMatch =
        (h.date || "").trim() ===
        (date || "").trim();

    

    return sportMatch && dateMatch;
});
       

        // Held Days
        const dayHeld = (turf.heldDays || []).some(
            d => d.date === date
        );

        // Temporary reservations
        const userHeldSlots = await HeldSlot.find({
            turfId,
            date,
            sport,
            expiresAt: { $gte: now }
        }).lean();

        // Confirmed bookings
        const confirmedBookings = await Booking.find({
    turfId,
    status: "confirmed",
    "slots.date": date,
    sport: new RegExp(`^${sport}$`, "i")
}).lean();

        const confirmedSlotsFlat = [];

        confirmedBookings.forEach(b => {
            b.slots.forEach(s => {
                if (s.date === date) {
                    confirmedSlotsFlat.push({
                        date: s.date,
                        slot: s.slot,
                        userId: b.userId
                    });
                }
            });
        });

        console.log("========== SLOT API DEBUG ==========");
console.log("Logged In User:", userId);

console.log("Confirmed Bookings:");
console.dir(confirmedBookings, { depth: null });

console.log("Confirmed Slots Flat:");
console.dir(confirmedSlotsFlat, { depth: null });

console.log("====================================");

        res.json({
            success: true,
            operationStartTime: turf.operationStartTime || "06:00 AM",
            operationEndTime: turf.operationEndTime || "10:00 PM",

            heldSlots: adminHeldSlots.map(h => ({
                date: h.date,
                slot: h.slot,
                reason: h.reason || "Held by admin"
            })),

            reservedSlots: userHeldSlots.map(h => ({
    date: h.date,
    slot: h.slot,
    userId: h.userId
})),

            confirmedSlots: confirmedSlotsFlat,

            heldDays: dayHeld
                ? [{ date, reason: "Full day held" }]
                : [],

            loggedInUserId: userId
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});

app.get('/api/user/bookings', async (req, res) => {

    try {

        const token =
            req.headers.authorization?.split(' ')[1];

        if (!token) {

            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        let decoded;

        try {

            decoded =
                await admin.auth().verifyIdToken(token);

        } catch (error) {

            return res.status(401).json({
                success: false,
                message: 'Invalid authentication token'
            });
        }

        const Booking = mongoose.models.Booking;

        if (!Booking) {

            return res.status(500).json({
                success: false,
                message: 'Booking system unavailable'
            });
        }

        const bookings =
            await Booking.find({

                userId: decoded.uid,

                status: 'confirmed'

            })
            .sort({
                bookedAt: -1
            })
            .lean();

        const formattedBookings =
            bookings.map(booking => ({

                bookingId:
                    booking.bookingId,

                turfId:
                    booking.turfId,

                turfName:
                    booking.turfName,

                date:
                    booking.slots?.[0]?.date || null,

                slots:
                    booking.slots || [],

                sport:
                    booking.sport,

                totalAmount:
                    booking.totalAmount || 0,

                paidAmount:
                    booking.paidAmount || 0,

                advanceAmount:
                    booking.advanceAmount ||
                    booking.paidAmount ||
                    0,

                balanceAmount:
                    booking.balanceAmount || 0,

                isAdvance:
                    booking.isAdvance === true,

                status:
                    booking.status,

                paymentStatus:
                    booking.paymentStatus,

                paymentId:
                    booking.paymentId,

                bookedAt:
                    booking.bookedAt
            }));

        return res.json({

            success: true,

            bookings:
                formattedBookings
        });

    } catch (error) {

        console.error(
            'Get user bookings error:',
            error.message
        );

        return res.status(500).json({
            success: false,
            message:
                'Failed to load bookings'
        });
    }
});
        

        
                // IMPROVED CRON JOB WITH BOOKING REMINDERS + CLEANUP (FINAL ROBUST VERSION)
        cron.schedule('*/3 * * * *', async () => {  // Every 30 minutes (TEST MODE - change to */30 for production)
            try {
                const now = new Date();
                

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
                        
                        }
                    }
                }

                

                // === EXISTING CLEANUP LOGIC (KEEP THIS!) ===
                const heldResult = await HeldSlot.deleteMany({ expiresAt: { $lt: now } });
                if (heldResult.deletedCount > 0) {

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
                    
                }

            } catch (error) {
                console.error(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] ❌ Cron job error:`, error.message);
            }
        });

            const PORT = process.env.PORT || 3000;

        setInterval(() => {
  reconcilePendingPayments();
}, 3 * 60 * 1000);

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Server running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error(`[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] MongoDB error: ${err.message}`);
        process.exit(1);
    });