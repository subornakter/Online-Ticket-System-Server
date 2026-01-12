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
    origin: ["https://phenomenal-custard-25a583.netlify.app"],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());


  //  Firebase Admin JWT Verification

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

    // MongoDB Start

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.r9l6yhe.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, { serverApi: ServerApiVersion.v1 });

async function run() {
  try {
    // await client.connect();
    const db = client.db("onlineTicket");
    const tickets = db.collection("tickets");
    const bookings = db.collection("bookings");
    const payments = db.collection("payments");
    const users = db.collection("users");


    // await payments.createIndex({ transactionId: 1 }, { unique: true });
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
  try {
    const adminEmail = req.tokenEmail;

    const allUsers = await users.find().toArray();

  
    const filteredUsers = allUsers.filter(u => u.email !== adminEmail);

    res.send(filteredUsers);

  } catch (err) {
    console.log("Error fetching users:", err);
    res.status(500).send({ message: "Failed to fetch users" });
  }
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

    // app.patch("/admin/ticket/advertise/:id", verifyJWT, verifyAdmin, async (req, res) => {
    //   const id = req.params.id;
    //   const { advertise } = req.body;
    //   const result = await tickets.updateOne({ _id: new ObjectId(id) }, { $set: { advertise } });
    //   res.send(result);
    // });
    app.patch("/admin/ticket/advertise/:id", verifyJWT, verifyAdmin, async (req, res) => {
  const id = req.params.id;
  const { advertise } = req.body;

  // COUNT how many tickets are already advertised
  const advertisedCount = await tickets.countDocuments({ advertise: true });

  // If admin wants to advertise and limit reached
  if (advertise === true && advertisedCount >= 6) {
    return res.status(400).send({ message: "You cannot advertise more than 6 tickets!" });
  }

  await tickets.updateOne(
    { _id: new ObjectId(id) },
    { $set: { advertise } }
  );

  const updated = await tickets.findOne({ _id: new ObjectId(id) });

  res.send(updated);
});

// SEARCH TICKETS
app.get("/tickets/search", verifyJWT, async (req, res) => {
  try {
    const { from, to, date } = req.query;

    console.log("Search Query:", from, to, date);

    const query = { status: "approved" };

    if (from) query.from = { $regex: from, $options: "i" };
    if (to) query.to = { $regex: to, $options: "i" };
    if (date) query.departure_date_time = { $regex: date, $options: "i" };

    const result = await tickets.find(query).toArray();

    res.send(result);

  } catch (err) {
    console.log("Search error:", err);
    res.status(500).send({ message: "Search failed", error: err });
  }
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

    app.get("/tickets/latest", async (req, res) => {
  const result = await tickets.find({ status: "approved" })
    .sort({ _id: -1 })  
    .limit(8)         
    .toArray();

  res.send(result);
});


    app.get("/ticket/:id", async (req, res) => {
      const id = req.params.id;
      const ticket = await tickets.findOne({ _id: new ObjectId(id), status: "approved" });
      if (!ticket) return res.status(404).send({ message: "Ticket not found or not approved" });
      res.send(ticket);
    });

 app.post("/bookings", verifyJWT, async (req, res) => {
  const booking = req.body;
  const userEmail = req.tokenEmail;

  // Check existing unpaid booking
  const existingBooking = await bookings.findOne({
    userEmail,
    ticketId: booking.ticketId,
    status: { $in: ["pending", "accepted"] }
  });

  if (existingBooking) {
    return res.send({
      message: "Existing unpaid booking found",
      existingBooking,
    });
  }

  const ticket = await tickets.findOne({
    _id: new ObjectId(booking.ticketId),
  });

  if (!ticket)
    return res.status(404).send({ message: "Ticket not found" });

  if (booking.quantity > ticket.ticket_quantity)
    return res.status(400).send({ message: "Not enough tickets available" });

  const newBooking = {
    ...booking,
    userEmail,
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

    // 1️⃣ Tickets added by this vendor
    const totalTicketsAdded = await tickets.countDocuments({
      "seller.email": vendorEmail,
    });

    // 2️⃣ ONLY PAID bookings for this vendor
    const paidBookings = await bookings.find({
      ticketSellerEmail: vendorEmail,
      status: "paid",
    }).toArray();

    // 3️⃣ Total tickets sold (quantity sum)
    const totalTicketsSold = paidBookings.reduce(
      (sum, b) => sum + b.quantity,
      0
    );

    // 4️⃣ Total revenue
    const totalRevenue = paidBookings.reduce(
      (sum, b) => sum + b.ticketUnitPrice * b.quantity,
      0
    );

    res.send({
      totalTicketsAdded,
      totalTicketsSold,
      totalRevenue,
    });

  } catch (err) {
    console.error("Vendor revenue error:", err);
    res.status(500).send({ message: "Failed to fetch revenue overview" });
  }
});


    /* ---------------------------
              Stripe Payment
    ----------------------------*/
    // app.post("/create-checkout-session", verifyJWT, async (req, res) => {
    //   const info = req.body;
    //   const booking = await bookings.findOne({ _id: new ObjectId(info._id) });
    //   if (!booking) return res.status(404).send({ message: "Booking not found" });

    //   if (booking.status !== "accepted") return res.status(400).send({ message: "Booking is not accepted yet" });
    //   if (new Date(booking.departureTime) < new Date()) return res.status(400).send({ message: "Cannot pay, departure time passed" });

    //   const session = await stripe.checkout.sessions.create({
    //     payment_method_types: ["card"],
    //     line_items: [{
    //       price_data: {
    //         currency: "usd",
    //         unit_amount: info.price * 100,
    //         product_data: { name: info.title, images: [info.image] }
    //       },
    //       quantity: info.quantity,
    //     }],
    //     mode: "payment",
    //     success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    //     cancel_url: `${process.env.CLIENT_URL}/dashboard/my-bookings`,
    //     customer_email: info.userEmail,
    //     metadata: { bookingId: info._id },
    //   });

    //   res.send({ url: session.url });
    // });
    app.post("/create-checkout-session", verifyJWT, async (req, res) => {
  try {
    const info = req.body;

    if (!info?._id) {
      return res.status(400).send({ message: "Booking ID missing" });
    }

    const booking = await bookings.findOne({
      _id: new ObjectId(info._id),
    });

    if (!booking) {
      return res.status(404).send({ message: "Booking not found" });
    }

    // ✅ Must be accepted by vendor
    if (booking.status !== "accepted") {
      return res.status(400).send({
        message: "Booking is not accepted yet",
      });
    }

    // ✅ Optional departure time check (safe)
    if (
      booking.departureTime &&
      new Date(booking.departureTime) < new Date()
    ) {
      return res.status(400).send({
        message: "Departure time already passed",
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",

      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: Math.round(booking.ticketUnitPrice * 100),
            product_data: {
              name: booking.ticketTitle,
            },
          },
          quantity: booking.quantity,
        },
      ],

      customer_email: booking.userEmail,

      metadata: {
        bookingId: booking._id.toString(),
      },

      success_url: `https://phenomenal-custard-25a583.netlify.app/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://phenomenal-custard-25a583.netlify.app/dashboard/my-bookings`,
    });

    res.send({ url: session.url });

  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).send({
      message: "Failed to create checkout session",
      error: err.message,
    });
  }
});


// ---------------------------
// Stripe Payment Success
// ---------------------------
app.post("/payment-success", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).send({ message: "Session ID required" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const bookingId = session.metadata.bookingId;
    const transactionId = session.payment_intent;

    const existingPayment = await payments.findOne({ transactionId });
    if (existingPayment) {
      return res.send({ success: true, message: "Payment already recorded" });
    }

    const booking = await bookings.findOne({ _id: new ObjectId(bookingId) });
    if (!booking || booking.status === "paid") {
      return res.send({ success: true, message: "Booking already processed" });
    }

  
    const paymentDoc = {
      transactionId,
      email: booking.userEmail,
      amount: session.amount_total / 100,
      title: booking.ticketTitle,
      date: new Date(),
      quantity: booking.quantity,
    };


    try {
      await payments.insertOne(paymentDoc);
      
      await bookings.updateOne(
        { _id: new ObjectId(bookingId) },
        { $set: { status: "paid" } }
      );

      await tickets.updateOne(
        { _id: new ObjectId(booking.ticketId) },
        { $inc: { ticket_quantity: -booking.quantity } }
      );

      res.send({ success: true, message: "Payment processed successfully" });
    } catch (insertErr) {
      if (insertErr.code === 11000) {
        return res.send({ success: true, message: "Duplicate payment ignored" });
      }
      throw insertErr;
    }

  } catch (err) {
    console.error("Payment success error:", err);
    res.status(500).send({ error: "Processing failed", details: err.message });
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

app.get("/dashboard/customer-stats", verifyJWT, async (req, res) => {
  try {
    const email = req.tokenEmail;

    const totalBookings = await bookings.countDocuments({
      userEmail: email,
    });

    const userPayments = await payments.find({ email }).toArray();

    const totalSpent = userPayments.reduce(
      (sum, p) => sum + p.amount,
      0
    );

    res.send({
      totalBookings,
      totalPayments: userPayments.length,
      totalSpent,
    });
  } catch (err) {
    console.log("Customer stats error:", err);
    res.status(500).send({ message: "Failed to load stats" });
  }
});

app.get("/admin/stats", verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const totalUsers = await users.countDocuments();
  
    const adminCount = await users.countDocuments({ role: "admin" });
    const vendorCount = await users.countDocuments({ role: "vendor" });
    const customerCount = await users.countDocuments({ role: "customer" });
    const fraudCount = await users.countDocuments({ role: "fraud" });

  
    const approvedTickets = await tickets.countDocuments({ status: "approved" });
    const pendingTickets = await tickets.countDocuments({ status: "pending" });
    const rejectedTickets = await tickets.countDocuments({ status: "rejected" });

    res.send({ 
      totalUsers, 
      adminCount, 
      vendorCount, 
      customerCount, 
      fraudCount,
      approvedTickets,
      pendingTickets,
      rejectedTickets,
      totalRevenue: (await payments.find().toArray()).reduce((sum, p) => sum + p.amount, 0)
    });
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch admin stats" });
  }
});

// Vendor Stats Route
app.get("/vendor/stats/:email", verifyJWT, async (req, res) => {
  try {
    const vendorEmail = req.params.email.toLowerCase();

    // Security check: only the logged-in vendor can access their stats
    if (vendorEmail !== req.tokenEmail.toLowerCase())
      return res.status(403).send({ message: "Forbidden" });

    //  Tickets added by vendor
    const totalTicketsAdded = await tickets.countDocuments({
      "seller.email": { $regex: `^${vendorEmail}$`, $options: "i" }
    });

    // Tickets by status
    const approvedTickets = await tickets.countDocuments({
      "seller.email": { $regex: `^${vendorEmail}$`, $options: "i" },
      status: { $regex: /^approved$/i }
    });

    const pendingTickets = await tickets.countDocuments({
      "seller.email": { $regex: `^${vendorEmail}$`, $options: "i" },
      status: { $regex: /^pending$/i }
    });

    //Bookings by this vendor
    const allBookings = await bookings.find({
      ticketSellerEmail: { $regex: `^${vendorEmail}$`, $options: "i" }
    }).toArray();

    const paidBookings = allBookings.filter(
      b => b.status.toLowerCase() === "paid"
    );

    const pendingBookings = allBookings.filter(
      b => b.status.toLowerCase() === "pending" || b.status.toLowerCase() === "accepted"
    );

    //  Total sold quantity and revenue (only paid bookings)
    const totalSoldQuantity = paidBookings.reduce((sum, b) => sum + b.quantity, 0);
    const totalRevenue = paidBookings.reduce(
      (sum, b) => sum + b.ticketUnitPrice * b.quantity,
      0
    );

    //Transport type stats
    const transportTypes = ["bus", "plane", "launch", "train"];
    const transportStats = [];
    for (const type of transportTypes) {
      const count = await tickets.countDocuments({
        "seller.email": { $regex: `^${vendorEmail}$`, $options: "i" },
        transport_type: { $regex: `^${type}$`, $options: "i" }
      });
      transportStats.push({ type, count });
    }

    // Send response
    res.send({
      totalTicketsAdded,
      approvedTickets,
      pendingTickets,
      totalSoldQuantity,
      totalRevenue,
      bookingStats: [
        { name: "Paid Sales", value: paidBookings.length },
        { name: "Unpaid/Pending", value: pendingBookings.length }
      ],
      transportStats
    });

  } catch (err) {
    console.error("Vendor stats error:", err);
    res.status(500).send({ message: "Failed to fetch vendor stats", error: err.message });
  }
});





    console.log("Server Connected ✔");
  } catch (err) {
    console.log(err);
  }
}
run();
app.get('/', (req, res) => {
  res.send('Hello from Server..')
})

app.listen(port, () => {
  console.log("Server running on port", port);
});