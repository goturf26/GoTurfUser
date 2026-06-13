const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, '../uploads');
    // Create uploads directory if it doesn't exist
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueFilename = `${Date.now()}-${file.originalname}`;
    console.log(`Saving file as: ${uniqueFilename}, MIME type: ${file.mimetype}, Extension: ${path.extname(file.originalname).toLowerCase()}`);
    cb(null, uniqueFilename);
  },
});

// File filter to accept only images
const fileFilter = (req, file, cb) => {
  const filetypes = /jpeg|jpg|png|gif/;
  const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = filetypes.test(file.mimetype.replace(/\/.+$/, '')); // Extract base MIME type (e.g., 'image' from 'image/jpeg')

  console.log(`File filter check - Originalname: ${file.originalname}, Extname: ${extname}, Mimetype: ${mimetype}`);

  if (extname && mimetype) {
    return cb(null, true);
  } else {
    const errorMsg = `Only image files (jpeg, jpg, png, gif) are allowed! Received: ${file.mimetype}, ${path.extname(file.originalname).toLowerCase()}`;
    console.error(errorMsg);
    cb(new Error(errorMsg));
  }
};

// Initialize multer with storage and file filter
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // Limit file size to 5MB
});

// Error handling middleware for multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('Multer error:', err.message);
    return res.status(400).json({
      success: false,
      message: 'File upload error',
      error: err.message,
    });
  } else if (err) {
    console.error('File validation error:', err.message);
    return res.status(400).json({
      success: false,
      message: 'Invalid file',
      error: err.message,
    });
  }
  next();
};

module.exports = { upload, handleMulterError };