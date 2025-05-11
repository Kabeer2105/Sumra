/*const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Replace this with your actual MongoDB Atlas connection string
mongoose.connect('mongodb+srv://kabeerd:Ashifa2505@cluster0.yke9w5x.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0', {
  dbName: 'citydata'
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error('Mongo error:', err));

app.use(cors());
app.use(express.json());

const personSchema = new mongoose.Schema({
  name: String,
  birthdate: String,
  contact: String,
  bloodGroup: String,
  city: String
});

const Person = mongoose.model('Person', personSchema);

app.get('/people', async (req, res) => {
  const city = req.query.city;
  if (!city) return res.status(400).json({ error: 'City is required' });

  const people = await Person.find({ city });
  res.json(people);
});

app.post('/people', async (req, res) => {
  const data = req.body;
  const person = new Person(data);
  await person.save();
  res.json({ message: 'Saved' });
});

app.delete('/people/:id', async (req, res) => {
  await Person.findByIdAndDelete(req.params.id);
  res.json({ message: 'Deleted' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});*/

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = 3000;

const mongoURI = process.env.MONGODB_URI;

// Replace this with your actual MongoDB Atlas connection string
mongoose.connect(mongoURI, { dbName: 'citydata' })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('Mongo error:', err));

app.use(cors());
app.use(express.json());

const personSchema = new mongoose.Schema({
  name: String,
  birthdate: String,
  contact: String,
  bloodGroup: String,
  city: String
});

const Person = mongoose.model('Person', personSchema);

app.get('/people', async (req, res) => {
  const city = req.query.city;
  if (!city) return res.status(400).json({ error: 'City is required' });

  const people = await Person.find({ city });
  res.json(people);
});

app.post('/people', async (req, res) => {
  const data = req.body;
  const person = new Person(data);
  await person.save();
  res.json({ message: 'Saved' });
});

app.delete('/people/:id', async (req, res) => {
  await Person.findByIdAndDelete(req.params.id);
  res.json({ message: 'Deleted' });
});

// **Added PUT route for updating person**
app.put('/people/:id', async (req, res) => {
  const personId = req.params.id;
  const updatedData = req.body;
  
  const person = await Person.findByIdAndUpdate(personId, updatedData, { new: true });
  
  if (!person) return res.status(404).json({ error: 'Person not found' });
  
  res.json(person);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});




