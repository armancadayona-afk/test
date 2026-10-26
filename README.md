# On-Tour — Apartment Tour Presentation

Production-oriented WebRTC video platform enabling an Admin to host interactive virtual walkthroughs with multiple Clients concurrently.

## Core Features
- **True Bidirectional WebRTC**: Admin sends high-resolution presentation and audio while simultaneously receiving and rendering live camera/audio feeds from all connected Clients.
- **Dynamic Broadcasting**: Admin can switch seamlessly between their live webcam and an uploaded local video tour (MP4/WebM) via `replaceTrack` without dropping connection.
- **Real-Time Room Chat**: In-memory, non-persistent broadcast chat for questions during presentations.
- **Stateless & Scalable**: Pure memory room orchestration requiring zero external database setup.

---

## Local Development Setup

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Set Local Environment Variables (Optional):**
   ```bash
   export ADMIN_PASSWORD="YourSecurePasswordHere"
   export SESSION_SECRET="SuperSecretSessionKey"
   ```

3. **Start the Server:**
   ```bash
   npm start
   ```
   Navigate to `http://localhost:3000`.

---

## Render Deployment Guide

1. Create a new **Web Service** on [Render.com](https://render.com).
2. Connect your repository containing this code.
3. Configure runtime settings:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Under **Environment Variables**, configure:
   - `ADMIN_PASSWORD`: Secret admin password
   - `SESSION_SECRET`: Random 32+ character hex string
   - `TURN_URL`: (Optional) STUN/TURN URL
   - `TURN_USERNAME`: (Optional) TURN Auth Username
   - `TURN_CREDENTIAL`: (Optional) TURN Auth Password
5. Click **Create Web Service**. Render provisions HTTPS automatically, which is mandatory for browser camera and microphone permissions.
