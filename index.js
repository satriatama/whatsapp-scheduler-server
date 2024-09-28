import fastify from 'fastify';
import * as whatsapp from 'wa-multi-session';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { DateTime } from 'luxon';
import fastifyCors from '@fastify/cors';

// Buat Fastify instance dengan konfigurasi yang diinginkan
const app = fastify({ logger: { level: 'error' }, trustProxy: true });

// Daftarkan middleware Fastify untuk CORS dan Multipart
app.register(fastifyCors);

const wsClients = {};

// Fungsi untuk memulai sesi WhatsApp jika belum ada
async function initializeSession(sessionId, ws) {
  try {
    const socket = await whatsapp.startSession(sessionId);
    socket.ev.on('connection.update', (update) => {
      const { qr, connection } = update;
      console.log('WebSocket state:', ws ? 'Connected' : 'Not connected');
      ws.send(JSON.stringify({ type: 'qr', data: qr }));
    });
  } catch (error) {
    console.error('Error starting session:', error);
    throw new Error('Failed to start WhatsApp session');
  }
}

// Fungsi utama untuk mengirim pesan
async function sendMessage({ sessionId, message, recipients, filePath }) {
  try {
    console.log('Sending message to recipients:', recipients);

    await whatsapp.sendTextMessage({
      sessionId,
      to: recipients,
      text: message,
    });

    // if (filePath) {
    //   await whatsapp.sendMediaMessage({
    //     sessionId,
    //     to: recipients,
    //     filePath,
    //   });
    // }

    console.log('Message sent successfully');
  } catch (error) {
    console.error('Error during message sending:', error);
    throw new Error('Failed to send message');
  }
}

// Fungsi untuk menjadwalkan pengiriman pesan
function scheduleMessage({ sessionId, message, recipients, schedule, filePath }) {
  const currentTime = DateTime.utc();
  const scheduleTime = DateTime.fromISO(schedule, { zone: 'Asia/Jakarta' }).toUTC();
  const delay = scheduleTime - currentTime;

  console.log('currentTime:', currentTime);
  console.log('scheduleTime:', scheduleTime);
  console.log('delay:', delay);

  if (delay <= 0) {
    return sendMessage({ sessionId, message, recipients, filePath });
  }

  setTimeout(() => {
    sendMessage({ sessionId, message, recipients, filePath });
  }, delay);
}

// Route API untuk menangani pengiriman pesan
app.post('/api/send-message', async (req, reply) => {
  const file = ""
  const { message, recipients, schedule, username } = req.body;
  const sessionId = username;

  try {
    const recipientsArray = JSON.parse(recipients);

    let filePath = null;
    if (file) {
      const uploadPath = path.join(__dirname, 'uploads', file.filename);
      await file.toBuffer();
      fs.writeFileSync(uploadPath, file.file);
      filePath = uploadPath;
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

    reply.send({ success: true, message: 'Pesan berhasil dijadwalkan!' });
  } catch (error) {
    console.error('Error in API:', error);
    reply.code(500).send({ error: 'Gagal menjadwalkan pesan.' });
  } finally {
    if (file && fs.existsSync(file.file)) {
      fs.unlinkSync(file.file);
    }
  }
});

// WebSocket setup
const wss = new WebSocketServer({ noServer: true });

app.server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  const sessionId = 'satriatama';

  if (sessionId) {
    wsClients[sessionId] = ws;
    console.log(`Client connected for session ${sessionId}`);

    try {
      const sessions = whatsapp.getAllSession();
      if (sessions.includes(sessionId)) {
        console.log(`Session ${sessionId} already started`);
      } else {
        initializeSession(sessionId, ws);
        console.log(`Session ${sessionId} started successfully`);
      }
    } catch (error) {
      console.error('Error starting session:', error);
      throw new Error('Failed to start WhatsApp session');
    }

    ws.on('close', () => {
      console.log(`Client disconnected for session ${sessionId}`);
      delete wsClients[sessionId];
    });
  }
});

// Start server
const start = async () => {
  try {
    await app.listen({ port: "3001", host: '0.0.0.0' });
    console.log(`Server listening on https://localhost:${"3001"}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
