require('dotenv').config();



const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');


const app = express();
const PORT = 3000;


// Replace this with your actual MongoDB Atlas connection string
mongoose.connect('mongodb+srv://kabeerd:Ashifa2505@cluster0.yke9w5x.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0', { dbName: 'citydata' })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('Mongo error:', err));

app.use(cors());
app.use(express.json());
app.use(cors());
app.use(express.json());

// Catch-all request logger
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});



// Serve static files from the frontend folder
app.use(express.static(path.join(__dirname, '../frontend')));

// Fallback for the root route to serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});


const personSchema = new mongoose.Schema({
  name: String,
  birthdate: String,
  contact: String,
  bloodGroup: String,
  city: String,
  order: Number
});

const Person = mongoose.model('Person', personSchema);

app.get('/people', async (req, res) => {
  const city = req.query.city;
  if (!city) return res.status(400).json({ error: 'City is required' });

  /*const people = await Person.find({ city });*/
  const people = await Person.find({ city }).sort({ order: 1 }); // sorted by order
  res.json(people);
});

app.post('/people', async (req, res) => {
  const data = req.body;

console.log('Final data before save:', data);

  const person = new Person(data);
  await person.save();
  res.json({ message: 'Saved' });
});

app.delete('/people/:id', async (req, res) => {
  await Person.findByIdAndDelete(req.params.id);
  res.json({ message: 'Deleted' });
});


// Shift orders starting from a given order by +1
app.put('/shift-orders', async (req, res) => {
  const { city, startingOrder } = req.body;

  await Person.updateMany(
    { city, order: { $gte: startingOrder } },
    { $inc: { order: 1 } }
  );

  res.json({ message: 'Orders shifted' });
});


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});



