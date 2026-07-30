const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    console.log("✅ MongoDB Connected");

    console.log("==================================");
    console.log("DATABASE:", mongoose.connection.db.databaseName);

    const adminDb = mongoose.connection.db.admin();
    const info = await adminDb.command({ hello: 1 });

    console.log("PRIMARY SERVER:", info.primary);
    console.log("==================================");

  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

module.exports = connectDB;