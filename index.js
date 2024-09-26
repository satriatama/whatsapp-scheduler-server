import express from "express";
import * as whatsapp from "wa-multi-session";
import multer from "multer"; // Untuk menangani upload file
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import https from "https"; // Import https untuk server SSL

// Setup storage untuk file uploads (optional jika file perlu disimpan sementara)
const upload = multer({ dest: "uploads/" });

// Baca key dan certificate untuk HTTPS
const key = fs.readFileSync("key-rsa.pem");
const cert = fs.readFileSync("cert.pem");

// Setup WebSocket server
const wss = new WebSocketServer({ noServer: true });

const wsClients = {};

// Fungsi untuk memulai sesi WhatsApp jika belum ada
async function initializeSession(sessionId, ws) {
  try {
    const socket = await whatsapp.startSession(sessionId);
    socket.ev.on("connection.update", (update) => {
      const { qr, connection } = update;
      console.log("WebSocket state:", ws ? "Connected" : "Not connected");
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "qr", data: qr })); // Kirim QR code melalui WebSocket jika ws tersedia dan terbuka
      }
    });
  } catch (error) {
    console.error("Error starting session:", error);
    throw new Error("Failed to start WhatsApp session");
  }
}

// Fungsi utama untuk mengirim pesan
async function sendMessage({ sessionId, message, recipients, filePath }) {
  try {
    console.log("Sending message to recipients:", recipients);
    await whatsapp.sendTextMessage({
      sessionId,
      to: recipients,
      text: message,
    });

    if (filePath) {
      await whatsapp.sendMediaMessage({
        sessionId,
        to: recipients,
        filePath,
      });
    }

    console.log("Message sent successfully");
  } catch (error) {
    console.error("Error during message sending:", error);
    throw new Error("Failed to send message");
  }
}

// Fungsi untuk menjadwalkan pengiriman pesan
function scheduleMessage({ sessionId, message, recipients, schedule, filePath }) {
  const currentTime = new Date();
  const scheduleTime = new Date(schedule);
  const delay = scheduleTime - currentTime;

  if (delay <= 0) {
    return sendMessage({ sessionId, message, recipients, filePath });
  }

  setTimeout(() => {
    sendMessage({ sessionId, message, recipients, filePath });
  }, delay);
}

// Inisialisasi Express
const app = express();
const port = 3001;

// Parsing form data dan JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Route API untuk menangani pengiriman pesan
app.post("/api/send-message", upload.single("file"), async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  try {
    const { message, recipients, schedule, username } = req.body;
    const sessionId = username;

    console.log("Request body:", req.body);

    const recipientsArray = JSON.parse(recipients); // Parse JSON string for recipients

    let filePath = null;
    if (req.file) {
      filePath = path.join(__dirname, req.file.path);
    }

    const sessions = whatsapp.getAllSession();
    if (!sessions.includes(sessionId)) {
      console.log(`Session ${sessionId} not started yet`);
      whatsapp.startSession(sessionId);
    }

    scheduleMessage({
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

// Membuat HTTPS server
const httpsServer = https.createServer({ key, cert }, app);

// Upgrade HTTPS server to handle WebSocket
httpsServer.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

// WebSocket connection logic
wss.on("connection", (ws, req) => {
  const sessionId = "satriatama";

  if (sessionId) {
    wsClients[sessionId] = ws;
    console.log(`Client connected for session ${sessionId}`);
    try {
      const sessions = whatsapp.getAllSession();
      if (sessions.includes(sessionId)) {
        console.log(`Session ${sessionId} already started`);
        ws.on("close", () => {
          console.log(`Client disconnected for session ${sessionId}`);
          delete wsClients[sessionId];
        });
      } else {
        initializeSession(sessionId, ws);
        console.log(`Session ${sessionId} started successfully`);
      }
    } catch (error) {
      console.error("Error starting session:", error);
      throw new Error("Failed to start WhatsApp session");
    }

    ws.on("close", () => {
      console.log(`Client disconnected for session ${sessionId}`);
      delete wsClients[sessionId];
    });
  }
});

// Jalankan HTTPS server
httpsServer.listen(port, () => {
  console.log(`Server berjalan di https://localhost:${port}`);
});
