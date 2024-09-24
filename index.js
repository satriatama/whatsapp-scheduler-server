import express from "express";
import https from "https";
import fs from "fs";
import path from "path";
import multer from "multer";
import { WebSocketServer } from "ws";
import * as whatsapp from "wa-multi-session";

class App {
  constructor() {
    this.express = express();
    this.wsClients = {};
    this.wss = null;
    this.startServer();
    this.setupWebSocket();
  }

  startServer() {
    const key = fs.readFileSync("key-rsa.pem");
    const cert = fs.readFileSync("cert.pem");

    const upload = multer({ dest: "uploads/" });

    // Middleware untuk parsing form data dan JSON
    this.express.use(express.json());
    this.express.use(express.urlencoded({ extended: true }));

    // Setup routes
    const router = express.Router();

    router.post("/api/send-message", upload.single("file"), async (req, res) => {
      res.header("Access-Control-Allow-Origin", "*");
      try {
        const { message, recipients, schedule, username } = req.body;
        const sessionId = username;

        console.log("Request body:", req.body);

        const recipientsArray = JSON.parse(recipients); // Parse JSON string for recipients

        // Jika ada file yang diupload
        let filePath = null;
        if (req.file) {
          filePath = path.join(__dirname, req.file.path); // Path file yang diupload
        }

        const sessions = whatsapp.getAllSession();
        if (!sessions.includes(sessionId)) {
          console.log(`Session ${sessionId} not started yet`);
          whatsapp.startSession(sessionId);
        }

        // Panggil fungsi scheduleMessage untuk mengatur jadwal pengiriman pesan
        this.scheduleMessage({
          sessionId,
          message,
          recipients: recipientsArray,
          schedule,
          filePath,
        });

        res.json({ success: true, message: "Pesan berhasil dijadwalkan!" });
      } catch (error) {
        console.error("Error in API:", error);
        res.status(500).json({ error: "Gagal menjadwalkan pesan." });
      } finally {
        if (req.file && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      }
    });

    this.express.use("/", router);

    // Server creation starts here
    const server = https.createServer({ key, cert }, this.express);
    server.listen(3001, (err) => {
      if (err) {
        console.log("Well, this didn't work...");
        process.exit();
      }
      console.log("Server is listening on port 3001");
    });

    // Attach WebSocket server to the HTTPS server
    this.wss = new WebSocketServer({ server });
  }

  // Fungsi untuk inisialisasi sesi WhatsApp dan kirim QR Code melalui WebSocket
  async initializeSession(sessionId, ws) {
    try {
      const socket = await whatsapp.startSession(sessionId);

      socket.ev.on("connection.update", (update) => {
        const { qr, connection } = update;
        console.log("WebSocket state:", ws ? "Connected" : "Not connected");
        if (qr) {
          ws.send(JSON.stringify({ type: "qr", data: qr })); // Kirim QR code
        } else if (connection === "open") {
          ws.send(JSON.stringify({ type: "connected", data: "connected" })); // Kirim status connected
        }
      });
    } catch (error) {
      console.error("Error starting session:", error);
      throw new Error("Failed to start WhatsApp session");
    }
  }

  // Fungsi untuk menjadwalkan pengiriman pesan
  scheduleMessage({ sessionId, message, recipients, schedule, filePath }) {
    const currentTime = new Date();
    const scheduleTime = new Date(schedule);
    const delay = scheduleTime.getTime() - currentTime.getTime();

    if (delay <= 0) {
      this.sendMessage({ sessionId, message, recipients, filePath });
    } else {
      setTimeout(() => {
        this.sendMessage({ sessionId, message, recipients, filePath });
      }, delay);
    }
  }

  // Fungsi untuk mengirim pesan
  async sendMessage({ sessionId, message, recipients, filePath }) {
    try {
      console.log("Sending message to recipients:", recipients);
      await whatsapp.sendTextMessage({ sessionId, to: recipients, text: message });

      if (filePath) {
        await whatsapp.sendMediaMessage({ sessionId, to: recipients, filePath });
      }
      console.log("Message sent successfully");
    } catch (error) {
      console.error("Error during message sending:", error);
      throw new Error("Failed to send message");
    }
  }

  setupWebSocket() {
    // WebSocket connection logic
    this.wss.on("connection", (ws, req) => {
      const sessionId = "satriatama";

      if (sessionId) {
        this.wsClients[sessionId] = ws;
        console.log(`Client connected for session ${sessionId}`);

        // Handle ping-pong to keep the connection alive
        ws.isAlive = true;
        ws.on('pong', () => {
          ws.isAlive = true;
        });

        const interval = setInterval(() => {
          if (!ws.isAlive) {
            console.log("Terminating connection due to inactivity");
            ws.terminate();
            return;
          }
          ws.isAlive = false;
          ws.ping();
        }, 30000); // Ping every 30 seconds

        try {
          const sessions = whatsapp.getAllSession();
          if (sessions.includes(sessionId)) {
            ws.on("close", () => {
              console.log(`Client disconnected for session ${sessionId}`);
              delete this.wsClients[sessionId];
              clearInterval(interval); // Clear interval on close
            });
          } else {
            this.initializeSession(sessionId, ws);
            console.log(`Session ${sessionId} started successfully`);
          }
        } catch (error) {
          console.error("Error starting session:", error);
          throw new Error("Failed to start WhatsApp session");
        }

        ws.on("close", (code, reason) => {
          console.log(`WebSocket closed: ${code}, Reason: ${reason}`);
          delete this.wsClients[sessionId];
          clearInterval(interval); // Clear interval on close
        });

        ws.on("error", (error) => {
          console.error(`WebSocket error: ${error}`);
        });
      }
    });
  }
}

export default new App().express;
