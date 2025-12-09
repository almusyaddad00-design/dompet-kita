const express = require('express');
const router = express.Router();
const { db, bucket } = require('../services/firebaseAdmin');
const multer = require('multer');
const ExcelJS = require('exceljs');

const upload = multer({ storage: multer.memoryStorage() });

// 1. Tampilkan Dashboard dengan FILTER & SORTING INPUT
router.get('/', async (req, res) => {
    try {
        const userId = req.user.uid;
        const { type, date, month, year } = req.query;

        // 1. Ambil SEMUA data (Sort by Date dulu dari database)
        const snapshot = await db.collection('users').doc(userId).collection('ledger').orderBy('date', 'asc').get();
        
        let allTransactions = [];

        // 2. Masukkan data ke array javascript
        snapshot.forEach(doc => {
            allTransactions.push({ 
                id: doc.id, 
                ...doc.data() 
            });
        });

        // 3. [PENTING] Sorting Lanjutan dengan JavaScript (Date + CreatedAt)
        // Ini memperbaiki urutan jika tanggalnya sama persis
        allTransactions.sort((a, b) => {
            // Bandingkan Tanggal dulu
            if (a.date < b.date) return -1;
            if (a.date > b.date) return 1;

            // JIKA TANGGAL SAMA, Bandingkan Waktu Input (createdAt)
            // Pastikan field createdAt ada (data lama mungkin tidak punya, kita anggap 0)
            const timeA = a.createdAt ? a.createdAt.toDate().getTime() : 0;
            const timeB = b.createdAt ? b.createdAt.toDate().getTime() : 0;
            
            return timeA - timeB; // Ascending (Lama ke Baru)
        });

        // 4. Hitung Saldo Berjalan (Looping dari data terlama ke terbaru)
        let globalSaldo = 0;
        const transactionsWithSaldo = allTransactions.map(t => {
            const amount = parseFloat(t.amount);
            if(t.category === 'Pemasukan') {
                globalSaldo += amount;
            } else {
                globalSaldo -= amount;
            }
            return { ...t, saldo: globalSaldo };
        });

        // 5. Filter Data untuk Tampilan (Sesuai input user)
        let filteredTransactions = [];
        if (!type || type === 'all') {
            filteredTransactions = transactionsWithSaldo;
        } else {
            filteredTransactions = transactionsWithSaldo.filter(t => {
                if (type === 'daily' && date) return t.date === date;
                if (type === 'monthly' && month) return t.date.startsWith(month);
                if (type === 'yearly' && year) return t.date.startsWith(year);
                return true;
            });
        }

        // 6. Hitung Summary (Kartu Atas)
        let summaryPemasukan = 0;
        let summaryPengeluaran = 0;
        filteredTransactions.forEach(t => {
            if(t.category === 'Pemasukan') summaryPemasukan += parseFloat(t.amount);
            else summaryPengeluaran += parseFloat(t.amount);
        });

        // Saldo Akhir ambil dari data terakhir yang lolos filter
        let displaySaldo = filteredTransactions.length > 0 
            ? filteredTransactions[filteredTransactions.length - 1].saldo 
            : (transactionsWithSaldo.length > 0 ? transactionsWithSaldo[transactionsWithSaldo.length - 1].saldo : 0);

        // 7. Balik Urutan untuk Tampilan Tabel (Yang Terbaru di Atas)
        // Agar user melihat data yang barusan diinput di posisi paling atas tabel
        const ledgerView = filteredTransactions.slice().reverse();

        res.render('dashboard', { 
            user: req.user, 
            transactions: ledgerView,
            summary: { 
                totalPemasukan: summaryPemasukan, 
                totalPengeluaran: summaryPengeluaran, 
                saldoAkhir: displaySaldo 
            },
            filter: { type, date, month, year }
        });

    } catch (error) {
        console.error(error);
        res.status(500).send("Error mengambil data");
    }
});

// 2. Tambah Transaksi (Pastikan createdAt tersimpan)
router.post('/add', upload.single('evidence'), async (req, res) => {
    try {
        const { date, description, category, amount, method } = req.body;
        const userId = req.user.uid;
        
        let imageUrl = '';
        if (req.file) {
            const fileName = `evidence/${userId}/${Date.now()}_${req.file.originalname}`;
            const file = bucket.file(fileName);
            await file.save(req.file.buffer, { contentType: req.file.mimetype });
            await file.makePublic(); 
            imageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        }

        await db.collection('users').doc(userId).collection('ledger').add({
            date,
            description,
            category,
            amount: parseFloat(amount),
            method,
            imageUrl,
            createdAt: new Date() // <--- INI KUNCINYA (Jam/Detik saat input)
        });

        res.redirect('/dashboard');
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// 3. Export Excel
router.get('/export', async (req, res) => {
    try {
        const userId = req.user.uid;
        const { type, date, month, year } = req.query;
        
        // GUNAKAN LOGIKA SORTING SAMA PERSIS DENGAN DASHBOARD
        const snapshot = await db.collection('users').doc(userId).collection('ledger').orderBy('date', 'asc').get();
        let allTransactions = [];
        snapshot.forEach(doc => allTransactions.push({ ...doc.data() }));

        // Sort Date + Time
        allTransactions.sort((a, b) => {
            if (a.date < b.date) return -1;
            if (a.date > b.date) return 1;
            const timeA = a.createdAt ? a.createdAt.toDate().getTime() : 0;
            const timeB = b.createdAt ? b.createdAt.toDate().getTime() : 0;
            return timeA - timeB;
        });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Laporan');
        
        worksheet.columns = [
            { header: 'Tanggal', key: 'date', width: 15 },
            { header: 'Keterangan', key: 'desc', width: 30 },
            { header: 'Kategori', key: 'cat', width: 15 },
            { header: 'Debit', key: 'debit', width: 15 },
            { header: 'Kredit', key: 'credit', width: 15 },
            { header: 'Saldo', key: 'balance', width: 15 },
            { header: 'Metode', key: 'method', width: 10 },
        ];

        // Hitung Saldo Ulang untuk Excel
        let saldo = 0;
        allTransactions.forEach(d => {
            const amount = parseFloat(d.amount);
            let debit = 0, credit = 0;
            
            if(d.category === 'Pemasukan') {
                saldo += amount;
                debit = amount;
            } else {
                saldo -= amount;
                credit = amount;
            }

            // Filter Logic untuk Excel
            let include = false;
            if (!type || type === 'all') include = true;
            else if (type === 'daily' && date && d.date === date) include = true;
            else if (type === 'monthly' && month && d.date.startsWith(month)) include = true;
            else if (type === 'yearly' && year && d.date.startsWith(year)) include = true;

            if(include) {
                worksheet.addRow({
                    date: d.date,
                    desc: d.description,
                    cat: d.category,
                    debit: debit,
                    credit: credit,
                    balance: saldo,
                    method: d.method
                });
            }
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Laporan.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).send("Error Export"); }
});

// 4. Update
router.post('/update/:id', upload.single('evidence'), async (req, res) => {
    try {
        const { date, description, category, amount, method } = req.body;
        let updateData = { date, description, category, amount: parseFloat(amount), method };
        if (req.file) {
            const fileName = `evidence/${req.user.uid}/${Date.now()}_${req.file.originalname}`;
            const file = bucket.file(fileName);
            await file.save(req.file.buffer, { contentType: req.file.mimetype });
            await file.makePublic();
            updateData.imageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        }
        await db.collection('users').doc(req.user.uid).collection('ledger').doc(req.params.id).update(updateData);
        res.redirect('/dashboard');
    } catch (error) { res.status(500).send("Gagal Update"); }
});

// 5. Delete
router.get('/delete/:id', async (req, res) => {
    try {
        await db.collection('users').doc(req.user.uid).collection('ledger').doc(req.params.id).delete();
        res.redirect('/dashboard');
    } catch (error) { res.status(500).send("Gagal Hapus"); }
});

module.exports = router;