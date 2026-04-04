const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
const serviceAccount = require('../firebase-service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL || 'https://aviator-82cdb-default-rtdb.firebaseio.com'
});

const db = admin.database();
const auth = admin.auth();

module.exports = { admin, db, auth };