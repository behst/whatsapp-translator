require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MY_PERSONAL_NUMBER = process.env.MY_PERSONAL_NUMBER;
const MONGODB_URI = process.env.MONGODB_URI;

let db;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('beastmode');
  console.log('Connected to MongoDB');
}

async function translate(text, fromLang, toLang) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Translate the following ${fromLang} text to ${toLang}. Return ONLY the translated text, nothing else.\n\n${text}`,
      },
    ],
  });
  return message.content[0].text.trim();
}

app.post('/incoming', async (req, res) => {
  const incomingMessage = req.body.Body;
  const sender = req.body.From;
  const keyword = incomingMessage.trim().toUpperCase();

  console.log(`\nINCOMING from ${sender}`);

  if (keyword === 'START' || keyword === 'UNSTOP' || keyword === 'YES') {
    console.log(`Opt-in keyword received from ${sender}`);
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Message>You have successfully been re-subscribed to messages from this number. I agree to receive text messages from Ironstone Contracting. Reply HELP for help. Reply STOP to unsubscribe. Msg&amp;Data Rates May Apply.</Message></Response>');
    return;
  }

  if (keyword === 'STOP' || keyword === 'STOPALL' || keyword === 'CANCEL' || keyword === 'END' || keyword === 'QUIT' || keyword === 'UNSUBSCRIBE') {
    console.log(`Opt-out keyword received from ${sender}`);
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Message>Ironstone Contracting: You have been unsubscribed and will receive no further messages. Reply START to resubscribe.</Message></Response>');
    return;
  }

  if (keyword === 'HELP' || keyword === 'INFO') {
    console.log(`Help keyword received from ${sender}`);
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Message>Ironstone Contracting: For assistance contact us directly. Reply STOP to unsubscribe. Msg&amp;Data Rates May Apply.</Message></Response>');
    return;
  }

  console.log(`Spanish: ${incomingMessage}`);
  try {
    const english = await translate(incomingMessage, 'Spanish', 'English');
    console.log(`English: ${english}`);

    const contacts = await db.collection('contacts').find({}).toArray();
    const clean = sender.replace('whatsapp:', '');
    const contact = contacts.find(c => c.number === clean);
    const contactName = contact ? contact.name : sender;

    await db.collection('messages').insertOne({
      direction: 'IN',
      from: sender,
      original: incomingMessage,
      translated: english,
      time: new Date().toLocaleTimeString(),
      date: new Date().toLocaleDateString(),
      unread: true,
      createdAt: new Date()
    });

    await twilioClient.messages.create({
      from: process.env.TWILIO_SMS_NUMBER,
      to: MY_PERSONAL_NUMBER,
      body: `New message from ${contactName}:\n"${english}"`,
    });
  } catch (err) {
    console.error('Error:', err.message);
  }
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  try {
    const spanish = await translate(message, 'English', 'Spanish');

    const contacts = await db.collection('contacts').find({}).toArray();
    const contact = contacts.find(c => c.number === to);
    const contactName = contact ? contact.name : to;

    console.log(`\nOUTGOING to ${contactName}`);
    console.log(`English: ${message}`);
    console.log(`Spanish: ${spanish}`);

    await twilioClient.messages.create({
      from: process.env.TWILIO_SMS_NUMBER,
      to: to,
      body: spanish,
    });

    await db.collection('messages').insertOne({
      direction: 'OUT',
      to,
      original: message,
      translated: spanish,
      time: new Date().toLocaleTimeString(),
      date: new Date().toLocaleDateString(),
      unread: false,
      createdAt: new Date()
    });

    res.json({ success: true, youTyped: message, theySee: spanish });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/messages', async (req, res) => {
  const messages = await db.collection('messages').find({}).sort({ createdAt: 1 }).toArray();
  res.json(messages);
});

app.post('/markread', async (req, res) => {
  const { number } = req.body;
  await db.collection('messages').updateMany(
    { direction: 'IN', from: number, unread: true },
    { $set: { unread: false } }
  );
  res.json({ success: true });
});

app.get('/contacts', async (req, res) => {
  const contacts = await db.collection('contacts').find({}).toArray();
  res.json(contacts);
});

app.post('/contacts/add', async (req, res) => {
  const { name, number } = req.body;
  await db.collection('contacts').insertOne({ name, number, createdAt: new Date() });
  res.json({ success: true });
});

app.put('/contacts/edit', async (req, res) => {
  const { oldNumber, name, number } = req.body;
  const result = await db.collection('contacts').updateOne(
    { number: oldNumber },
    { $set: { name, number } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Contact not found' });
  res.json({ success: true });
});

app.delete('/contacts/delete', async (req, res) => {
  const { number } = req.body;
  await db.collection('contacts').deleteOne({ number });
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Beast Mode Translator running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});
