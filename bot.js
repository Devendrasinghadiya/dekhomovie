require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const groupId = process.env.GROUP_ID;

app.get('/', (req, res) => {
  res.send('Cineflow Bot is running!');
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

bot.setMyCommands([
  { command: 'start', description: 'Start the bot' },
  { command: 'movie', description: 'Search a movie (e.g., /movie RRR)' },
  { command: 'tv', description: 'Search a TV show (e.g., /tv Friends)' },
]);

async function isMember(userId) {
  try {
    const res = await bot.getChatMember(groupId, userId);
    return ['creator', 'administrator', 'member'].includes(res.status);
  } catch (err) {
    return false;
  }
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const allowed = await isMember(userId);
  if (allowed) {
    return bot.sendMessage(chatId, `👋 Welcome to Cineflow Bot!\n\n🎥 Search movies & TV shows and watch them directly on Cineflow.\n\nThen use:\n/movie <movie name>\n/tv <tv show name>`);
  }

  return bot.sendMessage(chatId, `👋 Welcome to Cineflow Bot!\n\n🎥 Search movies & TV shows and watch them directly on Cineflow.\n\n🔗 First, join our group to use the bot:\n👉 [Join Cineflow Chat](https://t.me/cineflow_chat)\n\nThen use:\n/movie <movie name>\n/tv <tv show name>`, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
});

bot.onText(/\/(movie|tv) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const type = match[1];
  const query = match[2].trim();

  if (!query) {
    return bot.sendMessage(chatId, `❌ Please enter a ${type} name. Example:\n/${type} RRR`);
  }

  const isAllowed = await isMember(userId);

  try {
    const encodedUrl = encodeURIComponent(
      `https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(query)}&page=1&api_key=${process.env.TMDB_API_KEY}`
    );
    const finalUrl = `${process.env.PROXY_API_URL}${encodedUrl}`;
    const res = await axios.get(finalUrl);

    const results = res?.data?.results;
    if (!results || results.length === 0) {
      return bot.sendMessage(chatId, `❌ No results found. Please try again with a full name.`);
    }

    const result = results.find(r =>
      (r.title || r.name)?.toLowerCase() === query.toLowerCase()
    );

    if (!result) {
      return bot.sendMessage(chatId, `❌ No exact match found for "${query}". Please type the full correct name.`);
    }

    const title = result.title || result.name;
    const id = result.id;
    const imageUrl = `https://image.tmdb.org/t/p/w500${result.poster_path}`;
    const cineflowLink = `${process.env.CINEFLOW_URL}/${type}/${id}`;
    const buttonText = type === 'movie' ? '🎬 Watch Movie' : '📺 Watch Show';

    bot.sendPhoto(chatId, imageUrl, {
      caption: `*${title}*\n\nClick below to watch:`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: buttonText, url: cineflowLink }]]
      }
    });

  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, '⚠️ Something went wrong. Try again later.');
  }
});
