const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- CONFIGURATION BDD ---
// Sur Render (production sans disque persistant dédié), on stocke simplement la BDB à la racine
const dbPath = 'menuflash.db';

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Erreur critique lors de l'ouverture de la base de données :", err.message);
        process.exit(1);
    }
    console.log("Connecté à la base de données SQLite.");
});

// Initialisation des tables et du restaurant de test
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS restaurants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE,
            name TEXT,
            category TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            restaurant_id INTEGER,
            name TEXT,
            price TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            restaurant_id INTEGER,
            name TEXT,
            phone TEXT,
            date TEXT,
            time TEXT,
            people TEXT,
            status TEXT DEFAULT 'pending'
        )
    `);

    // Restaurant par défaut de test
    db.get("SELECT * FROM restaurants WHERE slug = 'café-paris'", (err, row) => {
        if (!row) {
            db.run("INSERT INTO restaurants (slug, name, category) VALUES (?, ?, ?)", ['café-paris', 'Le Café de Paris', 'Restaurant / Bar'], function(err) {
                if (!err) {
                    const restoId = this.lastID;
                    db.run("INSERT INTO items (restaurant_id, name, price) VALUES (?, ?, ?)", [restoId, 'Café Expresso', '2.00 €']);
                    db.run("INSERT INTO items (restaurant_id, name, price) VALUES (?, ?, ?)", [restoId, 'Croissant pur beurre', '1.50 €']);
                }
            });
        }
    });
});

// --- ROUTES ---

app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>MenuFlash - Accueil</title><style>body{font-family:sans-serif;padding:40px;background:#f4f4f9;}</style></head>
        <body>
            <h1>MenuFlash SaaS 🚀</h1>
            <p>Accédez à votre espace restaurant :</p>
            <a href="/admin/café-paris" style="font-size:1.2rem; background:#2563eb; color:#fff; padding:10px 20px; text-decoration:none; border-radius:6px;">📱 Ouvrir l'App Tablette Staff</a>
        </body>
        </html>
    `);
});

// Admin Dashboard
app.get('/admin/:slug', (req, res) => {
    const slug = req.params.slug;
    
    db.get("SELECT * FROM restaurants WHERE slug = ?", [slug], (err, resto) => {
        if (err || !resto) return res.status(404).send("Restaurant introuvable.");

        db.all("SELECT * FROM items WHERE restaurant_id = ?", [resto.id], (err, items) => {
            db.all("SELECT * FROM reservations WHERE restaurant_id = ? AND status = 'pending' ORDER BY id DESC", [resto.id], async (err, reservations) => {
                try {
                    const host = req.get('host');
                    const protocol = req.protocol;
                    const menuUrl = `${protocol}://${host}/menu/${slug}`;
                    
                    const qrImage = await QRCode.toDataURL(menuUrl);
                    res.render('admin', { resto, items: items || [], reservations: reservations || [], qrImage });
                } catch (qrErr) {
                    res.status(500).send("Erreur génération QR Code.");
                }
            });
        });
    });
});

// Ajouter un plat
app.post('/admin/:slug/add-item', (req, res) => {
    const slug = req.params.slug;
    const { name, price } = req.body;
    
    db.get("SELECT id FROM restaurants WHERE slug = ?", [slug], (err, resto) => {
        if (resto) {
            db.run("INSERT INTO items (restaurant_id, name, price) VALUES (?, ?, ?)", [resto.id, name, price], () => {
                res.redirect(`/admin/${slug}`);
            });
        } else {
            res.redirect('/');
        }
    });
});

// Supprimer un plat
app.post('/admin/:slug/delete-item/:id', (req, res) => {
    const { slug, id } = req.params;
    db.run("DELETE FROM items WHERE id = ?", [id], () => {
        res.redirect(`/admin/${slug}`);
    });
});

// Marquer une réservation comme traitée
app.post('/admin/:slug/complete-reservation/:id', (req, res) => {
    const { slug, id } = req.params;
    db.run("UPDATE reservations SET status = 'completed' WHERE id = ?", [id], () => {
        res.redirect(`/admin/${slug}`);
    });
});

// Menu public client
app.get('/menu/:slug', (req, res) => {
    const slug = req.params.slug;
    
    db.get("SELECT * FROM restaurants WHERE slug = ?", [slug], (err, resto) => {
        if (err || !resto) return res.status(404).send("Menu introuvable.");

        db.all("SELECT * FROM items WHERE restaurant_id = ?", [resto.id], (err, items) => {
            const success = req.query.success === 'true';
            res.render('menu', { resto, items: items || [], success });
        });
    });
});

app.get('/reserve/:slug', (req, res) => {
    res.redirect(`/menu/${req.params.slug}`);
});

// Traitement réservation (WebSocket temps réel)
app.post('/reserve/:slug', (req, res) => {
    const slug = req.params.slug;
    const { name, phone, date, time, people } = req.body;

    db.get("SELECT * FROM restaurants WHERE slug = ?", [slug], (err, resto) => {
        if (resto) {
            db.run(
                "INSERT INTO reservations (restaurant_id, name, phone, date, time, people, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                [resto.id, name, phone, date, time, people],
                function(err) {
                    if (!err) {
                        const newResId = this.lastID;
                        io.to(slug).emit('new-reservation', { id: newResId, name, phone, date, time, people });
                    }
                    res.redirect(`/menu/${slug}?success=true`);
                }
            );
        } else {
            res.redirect('/');
        }
    });
});

io.on('connection', (socket) => {
    socket.on('join-admin-room', (slug) => {
        socket.join(slug);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`MenuFlash SaaS Pro actif sur le port ${PORT}`);
});