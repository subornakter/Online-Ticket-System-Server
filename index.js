const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());

/* -----------------------------------
   Firebase Admin JWT Verification
------------------------------------- */
const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf8");
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(decodedKey)),
});

const verifyJWT = async (req, res, next) => {
  const token = req.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch {
    return res.status(401).send({ message: "Invalid Token" });
  }
};

/* -----------------------------------
    MongoDB Start
------------------------------------- */
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.r9l6yhe.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, { serverApi: ServerApiVersion.v1 });

async function run() {
  try {
    await client.connect();
    const db = client.db("onlineTicket");
    const tickets = db.collection("tickets");
    const bookings = db.collection("bookings");
    const payments = db.collection("payments");
    const users = db.collection("users");

    /* ---------------------------
       Role Middleware (Admin)
    ----------------------------*/
    const verifyAdmin = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await users.findOne({ email });
      if (!user || user.role !== "admin") return res.status(403).send({ message: "Forbidden - Admin Only" });
      next();
    };

    /* ---------------------------
          Auth User Save
    ----------------------------*/
    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.role = "customer";
      const exists = await users.findOne({ email: userData.email });

      if (exists) {
        await users.updateOne({ email: userData.email }, { $set: { last_loggedIn: new Date() } });
        return res.send({ updated: true });
      }

      userData.created_at = new Date();
      const result = await users.insertOne(userData);
      res.send(result);
    });

    app.get("/user/role", verifyJWT, async (req, res) => {
      const email = req.query.email;
      const user = await users.findOne({ email });
      res.send({ role: user?.role || "customer" });
    });

    /* ---------------------------
         Admin - Manage Users
    ----------------------------*/
    app.get("/admin/users", verifyJWT, verifyAdmin, async (req, res) => {
      const result = await users.find().toArray();
      res.send(result);
    });

    app.patch("/admin/make-admin/:email", verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const result = await users.updateOne({ email }, { $set: { role: "admin" } });
      res.send(result);
    });

    app.patch("/admin/make-vendor/:email", verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const result = await users.updateOne({ email }, { $set: { role: "vendor" } });
      res.send(result);
    });

    app.patch("/admin/mark-fraud/:email", verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      await users.updateOne({ email }, { $set: { role: "fraud" } });
      await tickets.updateMany({ "seller.email": email }, { $set: { status: "hidden" } });
      res.send({ message: "Vendor marked as fraud" });
    });

    /* ---------------------------
         Admin Ticket Approval
    ----------------------------*/
    app.get("/admin/tickets", verifyJWT, verifyAdmin, async (req, res) => {
      const data = await tickets.find({ status: "pending" }).sort({ _id: -1 }).toArray();
      res.send(data);
    });

    app.patch("/admin/ticket/approve/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await tickets.updateOne({ _id: new ObjectId(id) }, { $set: { status: "approved" } });
      res.send(result);
    });

    app.patch("/admin/ticket/reject/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await tickets.updateOne({ _id: new ObjectId(id) }, { $set: { status: "rejected" } });
      res.send(result);
    });

    /* ---------------------------
         Advertise Ticket
    ----------------------------*/
    app.get("/admin/advertise-tickets", verifyJWT, verifyAdmin, async (req, res) => {
      const result = await tickets.find({ status: "approved" }).toArray();
      res.send(result);
    });

    app.patch("/admin/ticket/advertise/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { advertise } = req.body;
      const result = await tickets.updateOne({ _id: new ObjectId(id) }, { $set: { advertise } });
      res.send(result);
    });

    app.get("/advertised-tickets", async (req, res) => {
      const result = await tickets.find({ advertise: true, status: "approved" }).limit(10).toArray();
      res.send(result);
    });

    /* ---------------------------
            Vendor APIs
    ----------------------------*/
    app.post("/tickets", verifyJWT, async (req, res) => {
      const ticket = req.body;
      ticket.status = "pending";
      ticket.advertise = false;
      const result = await tickets.insertOne(ticket);
      res.send(result);
    });

    app.get("/my-tickets", verifyJWT, async (req, res) => {
      const email = req.query.email;
      if (email !== req.tokenEmail) return res.status(403).send({ message: "Forbidden" });
      const result = await tickets.find({ "seller.email": email }).sort({ _id: -1 }).toArray();
      res.send(result);
    });

    app.patch("/ticket/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const email = req.tokenEmail;
      const updateData = req.body;

      const ticket = await tickets.findOne({ _id: new ObjectId(id) });
      if (!ticket) return res.status(404).send({ message: "Ticket not found" });
      if (ticket.seller.email !== email) return res.status(403).send({ message: "Forbidden" });

      const result = await tickets.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
      res.send(result);
    });

    app.delete("/ticket/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const email = req.tokenEmail;

      const ticket = await tickets.findOne({ _id: new ObjectId(id) });
      if (!ticket) return res.status(404).send({ message: "Ticket not found" });
      if (ticket.seller.email !== email) return res.status(403).send({ message: "Forbidden" });

      const result = await tickets.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    /* ---------------------------
            Bookings
    ----------------------------*/
    app.get("/tickets", async (req, res) => {
      const result = await tickets.find({ status: "approved" }).sort({ _id: -1 }).toArray();
      res.send(result);
    });

    app.get("/ticket/:id", async (req, res) => {
      const id = req.params.id;
      const ticket = await tickets.findOne({ _id: new ObjectId(id), status: "approved" });
      if (!ticket) return res.status(404).send({ message: "Ticket not found or not approved" });
      res.send(ticket);
    });

    // Create booking
    app.post("/bookings", verifyJWT, async (req, res) => {
      const booking = req.body;
      const ticket = await tickets.findOne({ _id: new ObjectId(booking.ticketId) });
      if (!ticket) return res.status(404).send({ message: "Ticket not found" });
      if (booking.quantity > ticket.ticket_quantity) return res.status(400).send({ message: "Not enough tickets available" });

      await tickets.updateOne({ _id: new ObjectId(booking.ticketId) }, { $inc: { ticket_quantity: -booking.quantity } });

      const newBooking = {
        ...booking,
        userEmail: req.tokenEmail,
        ticketTitle: ticket.title,
        ticketUnitPrice: ticket.price,
        ticketSellerEmail: ticket.seller.email,
        status: "pending",
        createdAt: new Date(),
      };

      const result = await bookings.insertOne(newBooking);
      res.send(result);
    });

    // Get bookings for logged-in user
    app.get("/my-bookings", verifyJWT, async (req, res) => {
      const userEmail = req.tokenEmail;
      const userBookings = await bookings.find({ userEmail }).sort({ createdAt: -1 }).toArray();
      res.send(userBookings);
    });

    // Vendor: get pending bookings
    app.get("/vendor/bookings", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const result = await bookings.find({ ticketSellerEmail: email, status: "pending" }).sort({ createdAt: -1 }).toArray();
      res.send(result);
    });

    // Vendor accept booking
    app.patch("/vendor/accept/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const email = req.tokenEmail;
      const booking = await bookings.findOne({ _id: new ObjectId(id) });
      if (!booking) return res.status(404).send({ message: "Booking not found" });
      if (booking.ticketSellerEmail !== email) return res.status(403).send({ message: "Forbidden" });

      const result = await bookings.updateOne({ _id: new ObjectId(id) }, { $set: { status: "accepted" } });
      res.send(await bookings.findOne({ _id: new ObjectId(id) }));
    });

    // Vendor reject booking
    app.patch("/vendor/reject/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const email = req.tokenEmail;
      const booking = await bookings.findOne({ _id: new ObjectId(id) });
      if (!booking) return res.status(404).send({ message: "Booking not found" });
      if (booking.ticketSellerEmail !== email) return res.status(403).send({ message: "Forbidden" });

      const result = await bookings.updateOne({ _id: new ObjectId(id) }, { $set: { status: "rejected" } });
      res.send(await bookings.findOne({ _id: new ObjectId(id) }));
    });
  

    // Get Vendor Revenue Overview
app.get("/vendor/revenue-overview", verifyJWT, async (req, res) => {
  try {
    const vendorEmail = req.tokenEmail;

    // Total Tickets Added
    const totalTicketsAdded = await tickets.countDocuments({ "seller.email": vendorEmail });

    // Total Tickets Sold (bookings that are paid or accepted)
    const soldBookings = await bookings.find({ ticketSellerEmail: vendorEmail, status: { $in: ["accepted", "paid"] } }).toArray();
    const totalTicketsSold = soldBookings.reduce((sum, b) => sum + b.quantity, 0);

    // Total Revenue (sum of paid bookings)
    const paidBookings = soldBookings.filter(b => b.status === "paid");
    const totalRevenue = paidBookings.reduce((sum, b) => sum + (b.ticketUnitPrice * b.quantity), 0);

    res.send({
      totalTicketsAdded,
      totalTicketsSold,
      totalRevenue,
    });
  } catch (err) {
    console.log(err);
    res.status(500).send({ message: "Failed to fetch revenue overview", error: err });
  }
});

    /* ---------------------------
              Stripe Payment
    ----------------------------*/
    app.post("/create-checkout-session", verifyJWT, async (req, res) => {
      const info = req.body;
      const booking = await bookings.findOne({ _id: new ObjectId(info._id) });
      if (!booking) return res.status(404).send({ message: "Booking not found" });

      if (booking.status !== "accepted") return res.status(400).send({ message: "Booking is not accepted yet" });
      if (new Date(booking.departureTime) < new Date()) return res.status(400).send({ message: "Cannot pay, departure time passed" });

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "usd",
            unit_amount: info.price * 100,
            product_data: { name: info.title, images: [info.image] }
          },
          quantity: info.quantity,
        }],
        mode: "payment",
        success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/dashboard/my-bookings`,
        customer_email: info.userEmail,
        metadata: { bookingId: info._id },
      });

      res.send({ url: session.url });
    });

app.post("/payment-success", async (req, res) => {
  try {
    const { sessionId } = req.body;

    // Retrieve Stripe session
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Get booking ID from metadata
    const bookingId = session.metadata.bookingId;

    // Find this booking
    const booking = await bookings.findOne({
      _id: new ObjectId(bookingId)
    });

    if (!booking) {
      return res.status(404).send({ message: "Booking not found" });
    }

    // Prevent duplicate transaction
    const existingPayment = await payments.findOne({
      transactionId: session.payment_intent,
    });

    // Save only once
    if (!existingPayment) {
      const paymentData = {
        transactionId: session.payment_intent,
        email: booking.userEmail,
        amount: session.amount_total / 100,
        title: booking.title,
        date: new Date(),
      };

      await payments.insertOne(paymentData);

      // Update booking status → paid
      await bookings.updateOne(
        { _id: new ObjectId(bookingId) },
        { $set: { status: "paid" } }
      );
    }

    res.send({ success: true });

  } catch (err) {
    console.log(err);
    res.status(500).send({ error: "Payment processing failed" });
  }
});



    // Get transaction history for logged-in user
app.get("/transactions", verifyJWT, async (req, res) => {
  try {
    const email = req.query.email;

    // Only allow the logged-in user to access their own transactions
    if (email !== req.tokenEmail)
      return res.status(403).send({ message: "Forbidden" });

    const userPayments = await payments
      .find({ email })
      .sort({ date: -1 })
      .toArray();

    res.send(userPayments);
  } catch (err) {
    console.log(err);
    res.status(500).send({ message: "Failed to fetch transactions", error: err });
  }
});


    console.log("Server Connected ✔");
  } catch (err) {
    console.log(err);
  }
}
run();

app.listen(port, () => {
  console.log("Server running on port", port);
});
