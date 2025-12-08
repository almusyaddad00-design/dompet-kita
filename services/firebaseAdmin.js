const admin = require("firebase-admin");
require('dotenv').config();

let serviceAccount;

// LOGIKA: Jika ada variable ENV (saat di Hosting), pakai itu. Jika tidak (di Laptop), pakai file json.
if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    // Decode kunci dari Base64 (Untuk di Render)
    const buffer = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64');
    serviceAccount = JSON.parse(buffer.toString('ascii'));
} else {
    try {
        // Load file lokal (Untuk di Laptop)
        serviceAccount = require("../serviceAccountKey.json");
    } catch (e) {
        console.error("Error: serviceAccountKey.json tidak ditemukan dan GOOGLE_CREDENTIALS_BASE64 tidak di-set.");
    }
}

// Inisialisasi
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.STORAGE_BUCKET
    });
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

module.exports = { admin, db, bucket };