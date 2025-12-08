const express = require('express');
const router = express.Router();
const { db, bucket } = require('../services/firebaseAdmin');
const multer = require('multer');
const ExcelJS = require('exceljs');

const upload = multer({ storage: multer.memoryStorage() });

// Helper: Format Rupiah
const toIDR = (num) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(num);

// 1. Tampilkan Dashboard & Buku Besar
router.get('/', async (req, res) => {
    try {
        const userId = req.user.uid;
        const snapshot = await db.collection('users').doc(userId).collection('ledger').orderBy('date', 'desc').get();
        
        let transactions = [];
        let totalPemasukan = 0;
        let totalPengeluaran = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            transactions.push({ id: doc.id, ...data });
            if(data.category === 'Pemasukan') totalPemasukan += parseFloat(data.amount);
            else totalPengeluaran += parseFloat(data.amount);
        });

        // Hitung Saldo Berjalan (Logic sederhana untuk tampilan)
        // Note: Untuk buku besar akurat, sorting harus Ascending dari awal waktu
        let saldo = 0;
        const ledgerView = transactions.slice().reverse().map(t => {
            if(t.category === 'Pemasukan') saldo += parseFloat(t.amount);
            else saldo -= parseFloat(t.amount);
            return { ...t, saldo };
        }).reverse(); // Balikkan lagi agar yang terbaru diatas

        res.render('dashboard', { 
            user: req.user, 
            transactions: ledgerView,
            summary: { totalPemasukan, totalPengeluaran, saldoAkhir: totalPemasukan - totalPengeluaran }
        });

    } catch (error) {
        console.error(error);
        res.status(500).send("Error mengambil data");
    }
});

// 2. Tambah Transaksi
router.post('/add', upload.single('evidence'), async (req, res) => {
    try {
        const { date, description, category, amount, method } = req.body;
        const userId = req.user.uid;
        
        let imageUrl = '';

        // Upload ke Firebase Storage jika ada gambar
        if (req.file) {
            const fileName = `evidence/${userId}/${Date.now()}_${req.file.originalname}`;
            const file = bucket.file(fileName);
            await file.save(req.file.buffer, { contentType: req.file.mimetype });
            await file.makePublic(); // Opsional, atau gunakan signed URL
            imageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        }

        await db.collection('users').doc(userId).collection('ledger').add({
            date,
            description,
            category,
            amount: parseFloat(amount),
            method,
            imageUrl,
            createdAt: new Date()
        });

        res.redirect('/dashboard');
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// 3. Export Excel
router.get('/export', async (req, res) => {
    const userId = req.user.uid;
    const snapshot = await db.collection('users').doc(userId).collection('ledger').orderBy('date', 'asc').get();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Buku Besar');

    worksheet.columns = [
        { header: 'Tanggal', key: 'date', width: 15 },
        { header: 'Keterangan', key: 'desc', width: 30 },
        { header: 'Kategori', key: 'cat', width: 15 },
        { header: 'Debit (Masuk)', key: 'debit', width: 15 },
        { header: 'Kredit (Keluar)', key: 'credit', width: 15 },
        { header: 'Saldo', key: 'balance', width: 15 },
        { header: 'Metode', key: 'method', width: 10 },
    ];

    let saldo = 0;
    snapshot.forEach(doc => {
        const data = doc.data();
        const amount = parseFloat(data.amount);
        let debit = 0, credit = 0;

        if(data.category === 'Pemasukan') {
            debit = amount;
            saldo += amount;
        } else {
            credit = amount;
            saldo -= amount;
        }

        worksheet.addRow({
            date: data.date,
            desc: data.description,
            cat: data.category,
            debit: debit || '',
            credit: credit || '',
            balance: saldo,
            method: data.method
        });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Laporan_Keuangan.xlsx');

    await workbook.xlsx.write(res);
    res.end();
});

module.exports = router;