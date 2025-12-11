const express = require('express')
const cors = require('cors')
const { MongoClient, ServerApiVersion } = require('mongodb')
const port = process.env.PORT || 3000

require('dotenv').config()
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const app = express()
const admin = require('firebase-admin')
// Firebase Admin Initialization
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf-8'
)
const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})
// Middleware
app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}))

app.use(express.json())

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.r9l6yhe.mongodb.net/?appName=Cluster0`;


// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection
    const db = client.db('onlineTicket')
    const ticketsCollection = db.collection('tickets')
    const bookingsCollection = db.collection('bookings');
    const paymentsCollection = db.collection("payments");
    const usersCollection = db.collection('users')



    app.get('/tickets', verifyJWT, async (req, res) => {
      const cursor = ticketsCollection.find()
      const result = await cursor.toArray()
      res.send(result)
    })

    app.post('/tickets', async (req, res) => {
      const ticket = req.body
      console.log(ticket)
      const result = await ticketsCollection.insertOne(ticket)
      res.send(result)
    })

//    app.get('/ticket/:id', verifyJWT, async (req, res) => {
//   const id = req.params.id;
//   const result = await ticketsCollection.findOne({ _id: new ObjectId(id) });
//   res.send(result);
// });

// Get tickets added by a vendor
app.get("/my-tickets", verifyJWT, async (req, res) => {
  try {
    const email = req.query.email;

    if (!email) {
      return res.status(400).send({ message: "Email required" });
    }

    // prevent unauthorized access
    if (email !== req.tokenEmail) {
      return res.status(403).send({ message: "Forbidden" });
    }

    const result = await ticketsCollection
      .find({ "seller.email": email })
      .sort({ _id: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Server error" });
  }
});

app.delete("/ticket/:id", verifyJWT, async (req, res) => {
  const id = req.params.id;

  const result = await ticketsCollection.deleteOne({
    _id: new ObjectId(id),
  });

  res.send(result);
});
app.put("/ticket/:id", verifyJWT, async (req, res) => {
  const id = req.params.id;
  const data = req.body;

  const result = await ticketsCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: data }
  );

  res.send(result);
});


const { ObjectId } = require('mongodb')

// Single Ticket Details API
app.get('/ticket/:id', async (req, res) => {
  try {
    const id = req.params.id
    const query = { _id: new ObjectId(id) } // convert to ObjectId

    const ticket = await ticketsCollection.findOne(query)

    if (!ticket) {
      return res.status(404).send({ message: "Ticket not found" })
    }

    res.send(ticket)
  } catch (error) {
    console.log("Error fetching ticket:", error)
    res.status(500).send({ message: "Internal Server Error", error })
  }
})

//User Dashboard - Bookings APIs
// app.post('/bookings', verifyJWT, async (req, res) => {
//   try {
//     const booking = req.body;

//     // Optional: check if ticket exists
//     const ticket = await ticketsCollection.findOne({ _id: new ObjectId(booking.ticketId) });
//     if (!ticket) return res.status(404).send({ message: "Ticket not found" });

//     // Optional: check if quantity is available
//     if (booking.quantity > ticket.ticket_quantity) {
//       return res.status(400).send({ message: "Not enough tickets available" });
//     }

//     // Reduce ticket quantity
//     await ticketsCollection.updateOne(
//       { _id: new ObjectId(booking.ticketId) },
//       { $inc: { ticket_quantity: -booking.quantity } }
//     );

//     // Add booking with "Pending" status
//     const result = await bookingsCollection.insertOne(booking);

//     res.send(result);
//   } catch (err) {
//     console.log(err);
//     res.status(500).send({ message: 'Internal Server Error', error: err });
//   }
// });
app.post('/bookings', verifyJWT, async (req, res) => {
  try {
    const booking = req.body;

    const ticket = await ticketsCollection.findOne({ _id: new ObjectId(booking.ticketId) });
    if (!ticket) return res.status(404).send({ message: "Ticket not found" });

    if (booking.quantity > ticket.ticket_quantity) {
      return res.status(400).send({ message: "Not enough tickets available" });
    }

    await ticketsCollection.updateOne(
      { _id: new ObjectId(booking.ticketId) },
      { $inc: { ticket_quantity: -booking.quantity } }
    );

    // ADD these extra fields ⬇️
    const newBooking = {
      ...booking,
      ticketTitle: ticket.title,
      ticketUnitPrice: ticket.price,
      ticketSellerEmail: ticket.seller.email,
      status: "pending",
      createdAt: new Date()
    };

    const result = await bookingsCollection.insertOne(newBooking);

    res.send(result);
  } catch (err) {
    console.log(err);
    res.status(500).send({ message: 'Internal Server Error', error: err });
  }
});

app.get("/vendor/bookings", verifyJWT, async (req, res) => {
  try {
    const email = req.query.email;

    if (!email) {
      return res.status(400).send({ message: "Email is required" });
    }

    // Vendors can only view their own ticket bookings
    if (email !== req.tokenEmail) {
      return res.status(403).send({ message: "Forbidden!" });
    }

    const result = await bookingsCollection
      .find({ ticketSellerEmail: email, status: "pending" })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (err) {
    console.log(err);
    res.status(500).send({ message: "Server Error" });
  }
});

app.patch("/vendor/booking/accept/:id", verifyJWT, async (req, res) => {
  try {
    const id = req.params.id;

    const result = await bookingsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "accepted" } }
    );

    res.send(result);
  } catch (err) {
    console.log(err);
    res.status(500).send({ message: "Server Error" });
  }
});

app.patch("/vendor/booking/reject/:id", verifyJWT, async (req, res) => {
  try {
    const id = req.params.id;

    const result = await bookingsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "rejected" } }
    );

    res.send(result);
  } catch (err) {
    console.log(err);
    res.status(500).send({ message: "Server Error" });
  }
});


// Get specific user's bookings
app.get("/bookings", verifyJWT, async (req, res) => {
  try {
    const email = req.query.email;

    if (!email) {
      return res.status(400).send({ message: "Email is required!" });
    }

    // Only allow logged user to see own bookings
    if (email !== req.tokenEmail) {
      return res.status(403).send({ message: "Forbidden!" });
    }

    const result = await bookingsCollection.find({ userEmail: email }).toArray();
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Failed to fetch bookings" });
  }
});

// Payment Intent API
app.post("/create-checkout-session", verifyJWT, async (req, res) => {
  try {
    const booking = req.body; // your paymentInfo from frontend
 console.log(booking);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: booking.title,
              images: [booking.image], // optional
            },
            unit_amount: booking.price * 100, // convert to cents
          },
          quantity: booking.quantity,
        },
      ],
      // user_email: booking.userEmail,
      mode: "payment",
      // success_url: `${process.env.CLIENT_URL}/dashboard/my-bookings?success=true`,
     success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/dashboard/my-bookings?canceled=true`,
        customer_email: booking.userEmail,
      metadata: {
  bookingId: booking._id.toString(),
  title: booking.title,
  userEmail: booking.userEmail,
},
    });

    res.send({ url: session.url });
  } catch (err) {
    console.log(err);
    res.status(500).send({ error: err.message });
  }
});

app.post("/payment-success", async (req, res) => {
  try {
    const { sessionId } = req.body;

    // Retrieve Stripe session
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Get booking ID from metadata
    const bookingId = session.metadata.bookingId;

    // Find this booking
    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(bookingId)
    });

    if (!booking) {
      return res.status(404).send({ message: "Booking not found" });
    }

    // Prevent duplicate transaction
    const existingPayment = await paymentsCollection.findOne({
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

      await paymentsCollection.insertOne(paymentData);

      // Update booking status → paid
      await bookingsCollection.updateOne(
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


app.get("/transactions", verifyJWT, async (req, res) => {
  try {
    const email = req.query.email;

    if (!email) {
      return res.status(400).send({ message: "Email is required" });
    }

    if (email !== req.tokenEmail) {
      return res.status(403).send({ message: "Forbidden" });
    }

    const result = await paymentsCollection
      .find({ email: email })   
      .sort({ date: -1 })       // newest first
      .toArray();

    res.send(result);

  } catch (err) {
    console.log(err);
    res.status(500).send({ message: "Server error" });
  }
});

  // save or update a user in db
    app.post('/user', async (req, res) => {
      const userData = req.body
      userData.created_at = new Date().toISOString()
      userData.last_loggedIn = new Date().toISOString()
      userData.role = 'customer'

      const query = {
        email: userData.email,
      }

      const alreadyExists = await usersCollection.findOne(query)
      console.log('User Already Exists---> ', !!alreadyExists)

      if (alreadyExists) {
        console.log('Updating user info......')
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        })
        return res.send(result)
      }

      console.log('Saving new user info......')
      const result = await usersCollection.insertOne(userData)
      res.send(result)
    })

  app.get('/user/role', verifyJWT, async (req, res) => {
  const email = req.query.email;

  if (!email) {
    return res.status(400).send({ error: "Email missing in request" });
  }

  const user = await usersCollection.findOne({ email });

  res.send({ role: user?.role || "user" });
});



    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Hello from Server......')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})