// models/User.js
const mongoose = require('mongoose');

// ==================== BOOKING SUB-SCHEMA (SYNC WITH server.js) ====================
const bookingSchema = new mongoose.Schema(
  {
    bookingId: { type: String, required: true, trim: true },
    turfId: { type: String, required: true, trim: true },
    turfName: { type: String, required: true, trim: true },
    slots: [
      {
        date: { type: String, required: true },
        slot: { type: String, required: true },
      },
    ],
    sport: { type: String, required: true, trim: true, uppercase: true },

    // === AMOUNT FIELDS ===
    totalAmount: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, required: true, min: 0 },
    balanceAmount: { type: Number, default: 0, min: 0 },

    // === ADVANCE PAYMENT FLAGS ===
    isAdvance: { type: Boolean, default: false },
    advanceAmount: { type: Number, default: 0, min: 0 },

    // === PAYMENT STATUS ===
    paymentStatus: {
      type: String,
      enum: ['pending', 'partial', 'completed', 'failed', 'refunded'],
      default: 'pending',
    },

    // === PAYMENT IDs ===
    paymentId: { type: String, trim: true, default: '' },
    orderId: { type: String, trim: true, default: '' },

    // === TIMESTAMPS & STATUS ===
    bookedAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ['confirmed', 'cancelled', 'completed', 'no-show'],
      default: 'confirmed',
    },
  },
  { _id: false }
);

// ==================== TOURNAMENT REGISTRATION SUB-SCHEMA ====================
const registeredTournamentSchema = new mongoose.Schema(
  {
    registrationId: { type: String, required: true, trim: true },
    type: { type: String, default: 'tournament' },
    tournamentId: { type: String, required: true, trim: true },
    tournamentName: { type: String, required: true, trim: true },
    venue: { type: String, required: true, trim: true },
    sport: { type: String, required: true, uppercase: true },
    entryFee: { type: Number, required: true, min: 0 },
    paymentId: { type: String, required: true, trim: true },
    orderId: { type: String, trim: true },
    status: { type: String, enum: ['confirmed', 'pending', 'cancelled'], default: 'confirmed' },
    registeredAt: { type: Date, default: Date.now },
    teamName: { type: String, required: true, trim: true },
    captainName: { type: String, required: true, trim: true },
    captainPhone: { type: String, required: true, trim: true },
    playerNames: [{ type: String, trim: true }],
  },
  { _id: false }
);

// ==================== MAIN USER SCHEMA ====================
const userSchema = new mongoose.Schema(
  {
    // ----- Core -----
    userId: {
      type: String,
      required: true,
      unique: true,        // kept inline → Mongoose creates unique index automatically
      trim: true,
    },
    userName: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: (v) => /^[a-zA-Z\s]{2,}$/.test(v),
        message: 'Invalid username: letters & spaces only, min 2 chars',
      },
    },
    email: {
      type: String,
      required: true,
      unique: true,        // kept inline
      trim: true,
      lowercase: true,
      validate: {
        validator: (v) => /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/.test(v),
        message: 'Invalid email',
      },
    },
    phone: {
      type: String,
      required: true,
      unique: true,        // kept inline
      trim: true,
      validate: {
        validator: (v) => /^[6-9]\d{9}$/.test(v),
        message: 'Invalid Indian mobile number',
      },
    },

    // ----- Auth -----
    password: { type: String, trim: true },
    googleId: { type: String, trim: true, default: '' },
    // firebaseUid: unique + sparse → CANNOT be done cleanly inline → use manual index
    firebaseUid: { type: String, trim: true, default: '' },

    // ----- Referral / Invite -----
    invite: {
      code: { type: String, trim: true, default: '' },
      count: { type: Number, default: 0 },
      cycle: { type: Number, default: 0 },
      points: { type: Number, default: 0 },
    },
    inviteCode: { type: String, trim: true, default: '' },

    // ----- Bookings -----
    upcomingBookings: {
      type: [bookingSchema],
      default: [],
    },

    // ----- Registered Tournaments -----
    registeredTournaments: {
      type: [registeredTournamentSchema],
      default: [],
    },

    // ----- Profile -----
    profileImagePath: { type: String, trim: true, default: '' },

    // ----- Timestamps -----
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'users', timestamps: true }
);

// ==================== INDEXES - CLEAN & NO DUPLICATE WARNINGS ====================
// Only define indexes manually when needed (sparse, compound, etc.)
// userId, email, phone → already unique via field → no need to redefine
userSchema.index({ firebaseUid: 1 }, { unique: true, sparse: true });

// Helpful query indexes
userSchema.index({ 'upcomingBookings.bookingId': 1 });
userSchema.index({ 'upcomingBookings.turfId': 1 });
userSchema.index({ 'upcomingBookings.orderId': 1 });
userSchema.index({ 'upcomingBookings.isAdvance': 1 });
userSchema.index({ 'upcomingBookings.paymentStatus': 1 });
userSchema.index({ 'registeredTournaments.tournamentId': 1 });
userSchema.index({ 'invite.code': 1 });
userSchema.index({ inviteCode: 1 });

const User = mongoose.model('User', userSchema);
module.exports = User;