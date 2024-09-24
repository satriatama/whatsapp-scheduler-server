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
    this.wsClients = {}; // Store connected WebSocket clients
    this.wss = null;
    this.startServer();
    this.setupWebSocket();
  }

  startServer() {
    const key = fs.readFileSync("key-rsa.pem");
    const cert = fs.readFileSync("cert.pem");

    const upload = multer({ dest: "uploads/" });

    // Middleware for parsing form data and JSON
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

        // If a file is uploaded
        let filePath = null;
        if (req.file) {
          filePath = path.join(__dirname, req.file.path); // Path of uploaded file
        }

        const sessions = whatsapp.getAllSession();
        if (!sessions.includes(sessionId)) {
          console.log(`Session ${sessionId} not started yet`);
          whatsapp.startSession(sessionId);
        }

        // Call the function to schedule the message
        this.scheduleMessage({
          sessionId,
          message,
          recipients: recipientsArray,
          schedule,
          filePath,
        });

        res.json({ success: true, message: "Message scheduled successfully!" });
      } catch (error) {
        console.error("Error in API:", error);
        res.status(500).json({ error: "Failed to schedule message." });
      } finally {
        if (req.file && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path); // Remove uploaded file after processing
        }
      }
    });

    this.express.use("/", router);

    // Create the HTTPS server
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

  // Initialize WhatsApp session and send QR Code through WebSocket
  async initializeSession(sessionId, ws) {
    try {
      const socket = await whatsapp.startSession(sessionId);

      socket.ev.on("connection.update", (update) => {
        const { qr, connection } = update;
        if (qr) {
          ws.send(JSON.stringify({ type: "qr", data: qr })); // Send QR code to client
        } else if (connection === "open") {
          ws.send(JSON.stringify({ type: "connected", data: "connected" })); // Send status connected
        }
      });
    } catch (error) {
      console.error("Error starting session:", error);
      throw new Error("Failed to start WhatsApp session");
    }
  }

  // Schedule a message to be sent later
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

  // Send a message via WhatsApp
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
    this.wss.on("connection", (ws, req) => {
      const sessionId = "satriatama"; // Set a unique session ID for the client

      // Check if the client is already connected
      if (this.wsClients[sessionId]) {
        console.log(`Client for session ${sessionId} already exists. Closing old connection.`);
        this.wsClients[sessionId].terminate(); // Terminate the previous connection
        delete this.wsClients[sessionId]; // Remove old client reference
      }

      // Store the new WebSocket connection
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
      }, 30000); // Ping every 30 seconds to check if the connection is alive

      try {
        const sessions = whatsapp.getAllSession();
        if (sessions.includes(sessionId)) {
          ws.on("close", () => {
            console.log(`Client disconnected for session ${sessionId}`);
            this.wsClients[sessionId] = null; // Clear client reference on disconnect
            clearInterval(interval); // Clear ping interval on close
            delete this.wsClients[sessionId]; // Remove client reference on disconnect
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
        this.wsClients[sessionId] = null; // Clear client reference on close
        console.log(`WebSocket closed: ${code}, Reason: ${reason || "Unknown reason"}`);
        clearInterval(interval); // Clear ping-pong interval
        delete this.wsClients[sessionId]; // Remove reference when closed
      });

      ws.on("error", (error) => {
        console.error(`WebSocket error: ${error.message}`);
      });
    });
  }
}

export default new App().express;
