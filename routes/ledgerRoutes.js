const express = require('express');
const router = express.Router();
const { db, bucket } = require('../services/firebaseAdmin');
const multer = require('multer');
const ExcelJS = require('exceljs');

const upload = multer({ storage: multer.memoryStorage() });

// 1. Tampilkan Dashboard
router.get('/', async (req, res) => {
    try {
        const userId = req.user.uid;
        // Ambil semua data lalu sort di server (agar saldo akurat)
        const snapshot = await db.collection('users').doc(userId).collection('ledger').orderBy('date', 'asc').get();
        
        let transactions = [];
        let totalPemasukan = 0;
        let totalPengeluaran = 0;
        let saldo = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            const amount = parseFloat(data.amount);
            
            // Hitung Saldo Berjalan
            if(data.category === 'Pemasukan') {
                saldo += amount;
                totalPemasukan += amount;
            } else {
                saldo -= amount;
                totalPengeluaran += amount;
            }

            transactions.push({ id: doc.id, ...data, saldo });
        });

        // Balik urutan agar yang terbaru diatas (tapi saldo sudah benar)
        const ledgerView = transactions.slice().reverse();

        res.render('dashboard', { 
            user: req.user, 
            transactions: ledgerView,
            summary: { totalPemasukan, totalPengeluaran, saldoAkhir: saldo }
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
            amount: parseFloat(amount), // Pastikan disimpan sebagai Angka Murni
            method,
            imageUrl,
            createdAt: new Date()
        });

        res.redirect('/dashboard');
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// 3. Export Excel (UPDATE FITUR FILTER)
router.get('/export', async (req, res) => {
    try {
        const userId = req.user.uid;
        const { type, date, month, year } = req.query;

        // Ambil SEMUA data dulu, baru kita filter di server (lebih mudah & fleksibel)
        const snapshot = await db.collection('users').doc(userId).collection('ledger').orderBy('date', 'asc').get();

        let filteredData = [];
        let saldo = 0;

        // Proses Filter Data
        snapshot.forEach(doc => {
            const data = doc.data();
            const tDate = data.date; // Format YYYY-MM-DD
            let include = false;

            // Logika Filter
            if (type === 'all') {
                include = true;
            } else if (type === 'daily' && date) {
                if (tDate === date) include = true;
            } else if (type === 'monthly' && month) {
                // month input format: "2024-12"
                if (tDate.startsWith(month)) include = true;
            } else if (type === 'yearly' && year) {
                if (tDate.startsWith(year)) include = true;
            }

            // Hitung saldo HANYA untuk data yang di-include agar laporan akurat sesuai periode
            // ATAU hitung saldo global? Biasanya laporan saldo mengikuti periode berjalan.
            // Disini kita hitung saldo kumulatif untuk baris yang ditampilkan.
            const amount = parseFloat(data.amount);
            
            if (include) {
                let debit = 0, credit = 0;
                if (data.category === 'Pemasukan') {
                    debit = amount;
                    saldo += amount;
                } else {
                    credit = amount;
                    saldo -= amount;
                }
                filteredData.push({ ...data, debit, credit, saldo });
            } else {
                // Jika ingin saldo sambungan dari bulan lalu, uncomment ini:
                // if (data.category === 'Pemasukan') saldo += amount; else saldo -= amount;
            }
        });

        // Buat Excel
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Laporan Keuangan');

        // Header Style
        worksheet.columns = [
            { header: 'Tanggal', key: 'date', width: 15 },
            { header: 'Keterangan', key: 'desc', width: 30 },
            { header: 'Kategori', key: 'cat', width: 15 },
            { header: 'Debit (Masuk)', key: 'debit', width: 15 },
            { header: 'Kredit (Keluar)', key: 'credit', width: 15 },
            { header: 'Saldo', key: 'balance', width: 15 },
            { header: 'Metode', key: 'method', width: 10 },
        ];

        // Isi Data
        filteredData.forEach(d => {
            worksheet.addRow({
                date: d.date,
                desc: d.description,
                cat: d.category,
                debit: d.debit || '',
                credit: d.credit || '',
                balance: d.saldo,
                method: d.method
            });
        });

        // Styling Header (Bold)
        worksheet.getRow(1).font = { bold: true };
        
        // Nama File Dinamis
        let filename = 'Laporan_Keuangan.xlsx';
        if(type === 'daily') filename = `Laporan_Harian_${date}.xlsx`;
        if(type === 'monthly') filename = `Laporan_Bulanan_${month}.xlsx`;
        if(type === 'yearly') filename = `Laporan_Tahunan_${year}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error(error);
        res.status(500).send("Gagal Export Excel");
    }
});

module.exports = router;