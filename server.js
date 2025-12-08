const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { admin, db, bucket } = require('./services/firebaseAdmin');

const app = express();

// Middleware
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

// --- MIDDLEWARE CEK LOGIN ---
const checkAuth = async (req, res, next) => {
    const sessionCookie = req.cookies.session || '';
    try {
        const decodedClaims = await admin.auth().verifySessionCookie(sessionCookie, true);
        req.user = decodedClaims;
        
        // Ambil data nama dari Firestore
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        if(userDoc.exists) {
            req.user.name = userDoc.data().name;
            req.user.email = userDoc.data().email;
        }
        
        next();
    } catch (error) {
        res.redirect('/login');
    }
};

// --- ROUTES HALAMAN ---
app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/login', (req, res) => {
    if(req.cookies.session) return res.redirect('/dashboard');
    res.render('login');
});

app.get('/logout', (req, res) => {
    res.clearCookie('session');
    res.redirect('/login');
});

// --- API AUTHENTICATION ---

// 1. API Login (Tukar ID Token jadi Session Cookie)
app.post('/api/sessionLogin', async (req, res) => {
    const idToken = req.body.idToken.toString();
    const expiresIn = 60 * 60 * 24 * 5 * 1000; // 5 hari

    try {
        const sessionCookie = await admin.auth().createSessionCookie(idToken, { expiresIn });
        res.cookie('session', sessionCookie, { maxAge: expiresIn, httpOnly: true });
        res.json({ status: 'success' });
    } catch (error) {
        res.status(401).send('UNAUTHORIZED REQUEST');
    }
});

// 2. API Register (Daftar Pakai Email)
app.post('/api/register', async (req, res) => {
    const { email, name, password } = req.body;

    try {
        // Buat User di Authentication
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            displayName: name
        });

        // Simpan Data ke Firestore
        await db.collection('users').doc(userRecord.uid).set({
            name: name,
            email: email,
            createdAt: new Date(),
            walletBalance: 0
        });

        res.json({ status: 'success' });
    } catch (error) {
        // Handle jika email sudah ada
        if (error.code === 'auth/email-already-exists') {
            return res.status(400).json({ error: "Email sudah terdaftar!" });
        }
        res.status(500).json({ error: error.message });
    }
});

// Import Routes Fitur Ledger
const ledgerRoutes = require('./routes/ledgerRoutes');
app.use('/dashboard', checkAuth, ledgerRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));