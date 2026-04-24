require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

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
const MESSAGES_FILE = 'messages.json';

function loadMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
      const parsed = JSON.parse(data);
      console.log(`Messages loaded: ${parsed.length}`);
      return parsed;
    }
  } catch (e) {
    console.error('Error loading messages:', e.message);
  }
  console.log('Messages loaded: 0');
  return [];
}

function saveMessages(messages) {
  try {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2), 'utf8');
    console.log(`Saved ${messages.length} messages to file`);
  } catch (e) {
    console.error('Error saving messages:', e.message);
  }
}

function getContactName(number) {
  try {
    const contacts = JSON.parse(fs.readFileSync('contacts.json', 'utf8'));
    const clean = number.replace('whatsapp:', '');
    const contact = contacts.find(c => c.number === clean);
    return contact ? contact.name : number;
  } catch (e) {
    return number;
  }
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

let messageLog = loadMessages();

app.post('/incoming', async (req, res) => {
  const incomingMessage = req.body.Body;
  const sender = req.body.From;
  const contactName = getContactName(sender);
  const keyword = incomingMessage.trim().toUpperCase();

  console.log(`\nINCOMING from ${contactName}`);

  // Handle opt-in keywords
  if (keyword === 'START' || keyword === 'UNSTOP' || keyword === 'YES') {
    console.log(`Opt-in keyword received from ${sender}`);
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Message>You have successfully been re-subscribed to messages from this number. I agree to receive text messages from Ironstone Contracting. Reply HELP for help. Reply STOP to unsubscribe. Msg&amp;Data Rates May Apply.</Message></Response>');
    return;
  }

  // Handle opt-out keywords
  if (keyword === 'STOP' || keyword === 'STOPALL' || keyword === 'CANCEL' || keyword === 'END' || keyword === 'QUIT' || keyword === 'UNSUBSCRIBE') {
    console.log(`Opt-out keyword received from ${sender}`);
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Message>Ironstone Contracting: You have been unsubscribed and will receive no further messages. Reply START to resubscribe.</Message></Response>');
    return;
  }

  // Handle help keywords
  if (keyword === 'HELP' || keyword === 'INFO') {
    console.log(`Help keyword received from ${sender}`);
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Message>Ironstone Contracting: For assistance contact us directly. Reply STOP to unsubscribe. Msg&amp;Data Rates May Apply.</Message></Response>');
    return;
  }

  // Handle regular Spanish incoming messages
  console.log(`Spanish: ${incomingMessage}`);
  try {
    const english = await translate(incomingMessage, 'Spanish', 'English');
    console.log(`English: ${english}`);
    messageLog.push({
      direction: 'IN',
      from: sender,
      original: incomingMessage,
      translated: english,
      time: new Date().toLocaleTimeString(),
      date: new Date().toLocaleDateString(),
      unread: true,
    });
    saveMessages(messageLog);
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
    const contactName = getContactName(to);
    console.log(`\nOUTGOING to ${contactName}`);
    console.log(`English: ${message}`);
    console.log(`Spanish: ${spanish}`);
    await twilioClient.messages.create({
      from: process.env.TWILIO_SMS_NUMBER,
      to: to,
      body: spanish,
    });
    messageLog.push({
      direction: 'OUT',
      to,
      original: message,
      translated: spanish,
      time: new Date().toLocaleTimeString(),
      date: new Date().toLocaleDateString(),
      unread: false,
    });
    saveMessages(messageLog);
    res.json({ success: true, youTyped: message, theySee: spanish });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/messages', (req, res) => {
  res.json(messageLog);
});

app.post('/markread', (req, res) => {
  const { number } = req.body;
  messageLog.forEach(msg => {
    if (msg.direction === 'IN' && msg.from.replace('whatsapp:', '') === number) {
      msg.unread = false;
    }
  });
  saveMessages(messageLog);
  res.json({ success: true });
});

app.get('/contacts', (req, res) => {
  try {
    const contacts = JSON.parse(fs.readFileSync('contacts.json', 'utf8'));
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/contacts/add', (req, res) => {
  const { name, number } = req.body;
  try {
    const contacts = JSON.parse(fs.readFileSync('contacts.json', 'utf8'));
    contacts.push({ name, number });
    fs.writeFileSync('contacts.json', JSON.stringify(contacts, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/contacts/edit', (req, res) => {
  const { oldNumber, name, number } = req.body;
  try {
    const contacts = JSON.parse(fs.readFileSync('contacts.json', 'utf8'));
    const index = contacts.findIndex(c => c.number === oldNumber);
    if (index === -1) return res.status(404).json({ error: 'Contact not found' });
    contacts[index] = { name, number };
    fs.writeFileSync('contacts.json', JSON.stringify(contacts, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/contacts/delete', (req, res) => {
  const { number } = req.body;
  try {
    let contacts = JSON.parse(fs.readFileSync('contacts.json', 'utf8'));
    contacts = contacts.filter(c => c.number !== number);
    fs.writeFileSync('contacts.json', JSON.stringify(contacts, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Translator running on port ${PORT}`);
});
