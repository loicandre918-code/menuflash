const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Configuration du port pour Fly.io ou local
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- CONFIGURATION BDD (Persistante sur Fly.io via /data) ---
const dbPath = process.env.NODE_ENV === 'production' ? '/data/menuflash.db' : 'menuflash.db';
const db = new Database(dbPath);

db.exec(`
    CREATE TABLE IF NOT EXISTS restaurants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE,
        name TEXT,
        category TEXT
    );

    CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        restaurant_id INTEGER,
        name TEXT,
        price TEXT
    );

    CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        restaurant_id INTEGER,
        name TEXT,
        phone TEXT,
        date TEXT,
        time TEXT,
        people TEXT,
        status TEXT DEFAULT 'pending'
    );
`);

// Restaurant par défaut de test
const existingResto = db.prepare("SELECT * FROM restaurants WHERE slug = 'café-paris'").get();
if (!existingResto) {
    const info = db.prepare("INSERT INTO restaurants (slug, name, category) VALUES (?, ?, ?)").run('café-paris', 'Le Café de Paris', 'Restaurant / Bar');
    const restoId = info.lastInsertRowid;
    db.prepare("INSERT INTO items (restaurant_id, name, price) VALUES (?, ?, ?)").run(restoId, 'Café Expresso', '2.00 €');
    db.prepare("INSERT INTO items (restaurant_id, name, price) VALUES (?, ?, ?)").run(restoId, 'Croissant pur beurre', '1.50 €');
}

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

// Admin Dashboard (Génère le QR Code avec la bonne URL publique ou locale)
app.get('/admin/:slug', async (req, res) => {
    const slug = req.params.slug;
    const resto = db.prepare("SELECT * FROM restaurants WHERE slug = ?").get(slug);
    
    if (!resto) return res.status(404).send("Restaurant introuvable.");

    const items = db.prepare("SELECT * FROM items WHERE restaurant_id = ?").all(resto.id);
    const reservations = db.prepare("SELECT * FROM reservations WHERE restaurant_id = ? AND status = 'pending' ORDER BY id DESC").all(resto.id);

    try {
        // Détecte automatiquement si on est en ligne ou en local pour le QR Code
        const host = req.get('host');
        const protocol = req.protocol;
        const menuUrl = `${protocol}://${host}/menu/${slug}`;
        
        const qrImage = await QRCode.toDataURL(menuUrl);
        res.render('admin', { resto, items, reservations, qrImage });
    } catch (err) {
        res.status(500).send("Erreur génération QR Code.");
    }
});

// Ajouter un plat
app.post('/admin/:slug/add-item', (req, res) => {
    const slug = req.params.slug;
    const { name, price } = req.body;
    const resto = db.prepare("SELECT id FROM restaurants WHERE slug = ?").get(slug);
    
    if (resto) {
        db.prepare("INSERT INTO items (restaurant_id, name, price) VALUES (?, ?, ?)").run(resto.id, name, price);
    }
    res.redirect(`/admin/${slug}`);
});

// Supprimer un plat
app.post('/admin/:slug/delete-item/:id', (req, res) => {
    const { slug, id } = req.params;
    db.prepare("DELETE FROM items WHERE id = ?").run(id);
    res.redirect(`/admin/${slug}`);
});

// Marquer une réservation comme traitée (terminée)
app.post('/admin/:slug/complete-reservation/:id', (req, res) => {
    const { slug, id } = req.params;
    db.prepare("UPDATE reservations SET status = 'completed' WHERE id = ?").run(id);
    res.redirect(`/admin/${slug}`);
});

// Menu public client
app.get('/menu/:slug', (req, res) => {
    const slug = req.params.slug;
    const resto = db.prepare("SELECT * FROM restaurants WHERE slug = ?").get(slug);
    
    if (!resto) return res.status(404).send("Menu introuvable.");

    const items = db.prepare("SELECT * FROM items WHERE restaurant_id = ?").all(resto.id);
    const success = req.query.success === 'true';

    res.render('menu', { resto, items, success });
});

app.get('/reserve/:slug', (req, res) => {
    res.redirect(`/menu/${req.params.slug}`);
});

// Traitement réservation (avec temps réel WebSocket)
app.post('/reserve/:slug', (req, res) => {
    const slug = req.params.slug;
    const { name, phone, date, time, people } = req.body;

    const resto = db.prepare("SELECT * FROM restaurants WHERE slug = ?").get(slug);
    if (resto) {
        const info = db.prepare("INSERT INTO reservations (restaurant_id, name, phone, date, time, people, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')")
          .run(resto.id, name, phone, date, time, people);

        const newResId = info.lastInsertRowid;

        // Notifier la tablette du staff
        io.to(slug).emit('new-reservation', { id: newResId, name, phone, date, time, people });

        res.redirect(`/menu/${slug}?success=true`);
    } else {
        res.redirect('/');
    }
});

io.on('connection', (socket) => {
    socket.on('join-admin-room', (slug) => {
        socket.join(slug);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`MenuFlash SaaS Pro actif sur le port ${PORT}`);
});