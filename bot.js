require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Express server
app.get('/', (req, res) => {
  res.send('Cineflow Bot is running!');
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Bot commands
bot.setMyCommands([
  { command: 'start', description: 'Start the bot' },
  { command: 'movie', description: 'Search a movie (e.g., /movie RRR)' },
  { command: 'tv', description: 'Search a TV show (e.g., /tv Friends)' },
  { command: 'id', description: 'Search by TMDB ID (e.g., /id movie 12345)' },
]);

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `👋 Welcome to Cineflow Bot!\n\n🎥 Search movies & TV shows and watch them directly on Cineflow.\n\nAvailable commands:\n/movie <movie name>\n/tv <tv show name>\n/id <movie/tv> <tmdb_id>`);
});

// Helper function to send media result
async function sendMediaResult(chatId, type, result) {
  const title = result.title || result.name;
  const id = result.id;
  const imageUrl = `https://image.tmdb.org/t/p/w500${result.poster_path}`;
  const cineflowLink = `${process.env.CINEFLOW_URL}/${type}/${id}`;
  const downloadLink = `${process.env.CINEFLOW_URL}/download/${type}/${id}`;
  const buttonText = type === 'movie' ? '🎬 Watch Movie' : '📺 Watch Show';

  const shareText = `Check out ${title} on Cineflow:\n${cineflowLink}`;
  
  await bot.sendPhoto(chatId, imageUrl, {
    caption: `*${title}* (${type === 'movie' ? 'Movie' : 'TV Show'})\n\n${result.overview || 'No overview available'}`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: buttonText, url: cineflowLink },
          { text: '⬇️ Download', url: downloadLink }
        ],
        [
          { text: '🔗 Share', switch_inline_query: shareText }
        ]
      ]
    }
  });
}

bot.onText(/\/(movie|tv) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const type = match[1];
  const query = match[2].trim();

  if (!query) {
    return bot.sendMessage(chatId, `❌ Please enter a ${type} name. Example:\n/${type} RRR`);
  }

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
    ) || results[0];

    await sendMediaResult(chatId, type, result);

  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, '⚠️ Something went wrong. Try again later.');
  }
});

// TMDB ID search command
bot.onText(/\/id (movie|tv) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const type = match[1];
  const tmdbId = match[2];

  try {
    const encodedUrl = encodeURIComponent(
      `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${process.env.TMDB_API_KEY}`
    );
    const finalUrl = `${process.env.PROXY_API_URL}${encodedUrl}`;
    const res = await axios.get(finalUrl);

    // Check if response contains valid data
    if (res.data && (res.data.title || res.data.name)) {
      await sendMediaResult(chatId, type, res.data);
    } else {
      // Try alternative approach if direct ID lookup fails
      try {
        const searchEncodedUrl = encodeURIComponent(
          `https://api.themoviedb.org/3/find/${tmdbId}?external_source=imdb_id&api_key=${process.env.TMDB_API_KEY}`
        );
        const searchFinalUrl = `${process.env.PROXY_API_URL}${searchEncodedUrl}`;
        const searchRes = await axios.get(searchFinalUrl);
        
        if (searchRes.data?.movie_results?.length > 0) {
          await sendMediaResult(chatId, 'movie', searchRes.data.movie_results[0]);
        } else if (searchRes.data?.tv_results?.length > 0) {
          await sendMediaResult(chatId, 'tv', searchRes.data.tv_results[0]);
        } else {
          bot.sendMessage(chatId, `❌ No ${type} found with ID ${tmdbId}. Please check the ID and try again.`);
        }
      } catch (fallbackErr) {
        console.error(fallbackErr.message);
        bot.sendMessage(chatId, `❌ No ${type} found with ID ${tmdbId}. Please check the ID and try again.`);
      }
    }
  } catch (err) {
    console.error(err.message);
    if (err.response?.status === 404) {
      bot.sendMessage(chatId, `❌ No ${type} found with ID ${tmdbId}. Please check the ID and try again.`);
    } else {
      bot.sendMessage(chatId, '⚠️ Something went wrong. Try again later.');
    }
  }
});
