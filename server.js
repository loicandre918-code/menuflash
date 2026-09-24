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
            category TEXT,
            password TEXT DEFAULT '1234'
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
            db.run("INSERT INTO restaurants (slug, name, category, password) VALUES (?, ?, ?, ?)", ['café-paris', 'Le Café de Paris', 'Restaurant / Bar', '1234'], function(err) {
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
        <head><title>MenuFlash - Accueil</title><style>body{font-family:sans-serif;padding:40px;background:#0f172a;color:#fff;}</style></head>
        <body>
            <h1>MenuFlash SaaS 🚀</h1>
            <p>Accédez à votre espace restaurant (Mot de passe par défaut : <b>1234</b>) :</p>
            <a href="/admin/café-paris" style="font-size:1.2rem; background:#4f46e5; color:#fff; padding:10px 20px; text-decoration:none; border-radius:8px; display:inline-block; margin-top:10px;">📱 Ouvrir l'App Tablette Staff</a>
        </body>
        </html>
    `);
});

// --- SÉCURITÉ ADMIN : Page de Connexion ---
app.get('/admin/:slug/login', (req, res) => {
    const slug = req.params.slug;
    const error = req.query.error === 'true';
    
    db.get("SELECT name FROM restaurants WHERE slug = ?", [slug], (err, resto) => {
        if (!resto) return res.status(404).send("Restaurant introuvable.");

        res.send(`
            <!DOCTYPE html>
            <html lang="fr">
            <head>
                <meta charset="UTF-8">
                <title>Connexion - ${resto.name}</title>
                <script src="https://cdn.tailwindcss.com"></script>
            </head>
            <body class="bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white flex items-center justify-center min-h-screen p-4">
                <div class="bg-white/10 backdrop-blur-md p-8 rounded-3xl border border-white/10 w-full max-w-sm space-y-6 shadow-2xl">
                    <div class="text-center space-y-1">
                        <h1 class="text-xl font-bold">🔐 Espace Staff</h1>
                        <p class="text-xs text-gray-300">${resto.name}</p>
                    </div>

                    ${error ? '<div class="bg-red-500/20 border border-red-500 text-red-300 text-xs p-3 rounded-xl text-center">Mot de passe incorrect.</div>' : ''}

                    <form action="/admin/${slug}/login" method="POST" class="space-y-4">
                        <div>
                            <label class="block text-xs text-gray-300 mb-1">Mot de passe</label>
                            <input type="password" name="password" required placeholder="••••" autofocus
                                class="w-full px-4 py-2.5 rounded-xl bg-slate-800/60 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm">
                        </div>
                        <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 transition-all rounded-xl text-sm shadow-lg shadow-indigo-600/30">
                            Se connecter
                        </button>
                    </form>
                </div>
            </body>
            </html>
        `);
    });
});

// Traitement de la connexion admin
app.post('/admin/:slug/login', (req, res) => {
    const slug = req.params.slug;
    const { password } = req.body;

    db.get("SELECT * FROM restaurants WHERE slug = ? AND password = ?", [slug, password], (err, resto) => {
        if (resto) {
            // Authentification réussie (on redirige avec le paramètre auth=true)
            res.redirect(`/admin/${slug}?auth=true`);
        } else {
            res.redirect(`/admin/${slug}/login?error=true`);
        }
    });
});

// Admin Dashboard (Protégé par le paramètre ?auth=true)
app.get('/admin/:slug', (req, res) => {
    const slug = req.params.slug;
    const isAuthed = req.query.auth === 'true';

    // Si non authentifié, on redirige vers la page de login
    if (!isAuthed) {
        return res.redirect(`/admin/${slug}/login`);
    }
    
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

// Ajouter un plat (Sécurisé par l'authentification dans l'URL)
app.post('/admin/:slug/add-item', (req, res) => {
    const slug = req.params.slug;
    const { name, price } = req.body;
    
    db.get("SELECT id FROM restaurants WHERE slug = ?", [slug], (err, resto) => {
        if (resto) {
            db.run("INSERT INTO items (restaurant_id, name, price) VALUES (?, ?, ?)", [resto.id, name, price], () => {
                res.redirect(`/admin/${slug}?auth=true`);
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
        res.redirect(`/admin/${slug}?auth=true`);
    });
});

// Marquer une réservation comme traitée
app.post('/admin/:slug/complete-reservation/:id', (req, res) => {
    const { slug, id } = req.params;
    db.run("UPDATE reservations SET status = 'completed' WHERE id = ?", [id], () => {
        res.redirect(`/admin/${slug}?auth=true`);
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