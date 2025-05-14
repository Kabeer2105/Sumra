const mongoose = require('mongoose');

mongoose.connect('mongodb+srv://kabeerd:Ashifa2505@cluster0.yke9w5x.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0', {
  dbName: 'citydata'
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error('Mongo error:', err));

const personSchema = new mongoose.Schema({
  name: String,
  birthdate: String,
  contact: String,
  bloodGroup: String,
  city: String,
  order: Number
});

const Person = mongoose.model('Person', personSchema);

async function addOrderFields() {
  const cities = await Person.distinct('city');

  for (const city of cities) {
    const people = await Person.find({ city }).sort({ _id: 1 }); // assuming _id order is insert order
    for (let i = 0; i < people.length; i++) {
      people[i].order = i + 1;
      await people[i].save();
    }
    console.log(`Updated order for city: ${city}`);
  }

  mongoose.disconnect();
}

addOrderFields();
