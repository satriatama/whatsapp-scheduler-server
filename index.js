import express from "express";
import * as whatsapp from "wa-multi-session";
import multer from "multer"; // Untuk menangani upload file
import fs from "fs";
import path from "path";
import https from "https"; // Import https module
import { WebSocketServer } from "ws";
import { DateTime } from "luxon";
import { fileURLToPath } from "url";

// Setup storage untuk file uploads (optional jika file perlu disimpan sementara)
const upload = multer({ dest: "uploads/" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const options = {
  key: fs.readFileSync(path.join(__dirname, "key.pem"), "utf8"),
  cert: fs.readFileSync(path.join(__dirname, "cert.pem"), "utf8"),
};


const wss = new WebSocketServer({ noServer: true }); // WebSocket on HTTPS requires noServer

const wsClients = {};

// Fungsi untuk memulai sesi WhatsApp jika belum ada
async function initializeSession(sessionId, ws) {
  try {
    const socket = await whatsapp.startSession(sessionId);
    // Daftarkan event listener untuk QR code
    socket.ev.on("connection.update", (update) => {
      const { qr, connection } = update;
      console.log("WebSocket state:", ws ? "Connected" : "Not connected");
      ws.send(JSON.stringify({ type: "qr", data: qr })); // Kirim QR code melalui WebSocket jika ws tersedia dan terbuka
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

    // Mengirim pesan teks ke setiap penerima
    await whatsapp.sendTextMessage({
      sessionId,
      to: recipients,
      text: message,
    });

    // Jika ada file yang harus dikirim
    if (filePath) {
      await whatsapp.sendMediaMessage({
        sessionId,
        to: recipients,
        filePath, // path file yang dikirim
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
  const currentTime = DateTime.utc(); // Ambil waktu UTC sekarang
  const scheduleTime = DateTime.fromISO(schedule, { zone: 'Asia/Jakarta' }).toUTC(); // Konversi dari waktu Jakarta ke UTC

  // Hitung selisih waktu dalam milidetik
  const delay = scheduleTime - currentTime;
  console.log("currentTime: ", currentTime);
  console.log("scheduleTime: ", scheduleTime);
  console.log("delay: ", delay);

  // Jika waktu yang dijadwalkan sudah lewat, kirim pesan langsung
  if (delay <= 0) {
    return sendMessage({ sessionId, message, recipients, filePath });
  }

  // Jadwalkan pengiriman pesan
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
    // Hapus file setelah dikirim (optional)
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

// Create HTTPS server with certificate and key
const server = https.createServer(options, app);

// Upgrade HTTP server to handle WebSocket
server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

// WebSocket connection logic
wss.on("connection", (ws, req) => {
  const sessionId = "satriatama";

  if (sessionId) {
    wsClients[sessionId] = ws; // Simpan WebSocket client berdasarkan sessionId
    console.log(`Client connected for session ${sessionId}`);
    // Inisialisasi sesi dan kirim QR code atau pesan connected
    try {
      const sessions = whatsapp.getAllSession();
      if (sessions.includes(sessionId)) {
        console.log(`Session ${sessionId} already started`);
        ws.on("close", () => {
          console.log(`Client disconnected for session ${sessionId}`);
          delete wsClients[sessionId]; // Hapus client ketika terputus
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
      delete wsClients[sessionId]; // Hapus client ketika terputus
    });
  }
});

// Start the HTTPS server
server.listen(port, () => {
  console.log(`Server berjalan di https://localhost:${port}`);
});
