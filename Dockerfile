# Utiliser une image officielle Node.js stable
FROM node:18-slim

# Créer le dossier de travail dans le conteneur
WORKDIR /app

# Installer les dépendances système pour compiler better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copier les fichiers package.json et package-lock.json
COPY package*.json ./

# Installer toutes les dépendances (nécessaire pour la compilation)
RUN npm install

# Forcer la reconstruction spécifique de better-sqlite3 pour Linux
RUN npm rebuild better-sqlite3 --build-from-source

# Copier le reste du code de l'application
COPY . .

# Exposer le port de l'application
EXPOSE 3000

# Commande pour démarrer l'application
CMD ["node", "server.js"]