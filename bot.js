require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Express server
app.get('/', (req, res) => {
  res.send('Movie Bot is running!');
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
  bot.sendMessage(chatId, `👋 Welcome to DeekhoMovies Bot!\n\n🎥 Search movies & TV shows and watch them directly on DekhoMovies.\n\nYou can either:\n1. Type /movie <name>\n2. Type /tv <name>\n3. Or simply type the movie/show name directly`);
});

// Helper function to send media result
async function sendMediaResult(chatId, type, result) {
  const title = result.title || result.name;
  const id = result.id;
  const imageUrl = `https://image.tmdb.org/t/p/w500${result.poster_path}`;
  const cineflowLink = `${process.env.CINEFLOW_URL}/${type}/${id}`;
  const downloadLink = `${process.env.CINEFLOW_URL}/download/${type}/${id}`;
  const buttonText = type === 'movie' ? '🎬 Watch on DekhoMovies' : '📺 Watch on DekhoMovies';

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

// Handle direct movie/TV show name input
bot.on('text', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // Skip if it's a command
  if (text.startsWith('/')) return;

  try {
    // First try movie search
    const movieEncodedUrl = encodeURIComponent(
      `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(text)}&page=1&api_key=${process.env.TMDB_API_KEY}`
    );
    const movieFinalUrl = `${process.env.PROXY_API_URL}${movieEncodedUrl}`;
    const movieRes = await axios.get(movieFinalUrl);

    if (movieRes.data?.results?.length > 0) {
      const exactMatch = movieRes.data.results.find(r => 
        (r.title || r.name)?.toLowerCase() === text.toLowerCase()
      ) || movieRes.data.results[0];
      await sendMediaResult(chatId, 'movie', exactMatch);
      return;
    }

    // If no movie found, try TV show search
    const tvEncodedUrl = encodeURIComponent(
      `https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(text)}&page=1&api_key=${process.env.TMDB_API_KEY}`
    );
    const tvFinalUrl = `${process.env.PROXY_API_URL}${tvEncodedUrl}`;
    const tvRes = await axios.get(tvFinalUrl);

    if (tvRes.data?.results?.length > 0) {
      const exactMatch = tvRes.data.results.find(r => 
        (r.title || r.name)?.toLowerCase() === text.toLowerCase()
      ) || tvRes.data.results[0];
      await sendMediaResult(chatId, 'tv', exactMatch);
    } else {
      bot.sendMessage(chatId, '❌ No results found. Please try with /movie or /tv command.');
    }
  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, '⚠️ Something went wrong. Try again later.');
  }
});

// Movie command
bot.onText(/\/movie (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1].trim();

  if (!query) {
    return bot.sendMessage(chatId, '❌ Please enter a movie name. Example:\n/movie RRR');
  }

  try {
    const encodedUrl = encodeURIComponent(
      `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(query)}&page=1&api_key=${process.env.TMDB_API_KEY}`
    );
    const finalUrl = `${process.env.PROXY_API_URL}${encodedUrl}`;
    const res = await axios.get(finalUrl);

    const results = res?.data?.results;
    if (!results || results.length === 0) {
      return bot.sendMessage(chatId, '❌ No results found. Please try again with a full name.');
    }

    const result = results.find(r =>
      (r.title || r.name)?.toLowerCase() === query.toLowerCase()
    ) || results[0];

    await sendMediaResult(chatId, 'movie', result);
  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, '⚠️ Something went wrong. Try again later.');
  }
});

// TV command
bot.onText(/\/tv (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1].trim();

  if (!query) {
    return bot.sendMessage(chatId, '❌ Please enter a TV show name. Example:\n/tv Friends');
  }

  try {
    const encodedUrl = encodeURIComponent(
      `https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(query)}&page=1&api_key=${process.env.TMDB_API_KEY}`
    );
    const finalUrl = `${process.env.PROXY_API_URL}${encodedUrl}`;
    const res = await axios.get(finalUrl);

    const results = res?.data?.results;
    if (!results || results.length === 0) {
      return bot.sendMessage(chatId, '❌ No results found. Please try again with a full name.');
    }

    const result = results.find(r =>
      (r.name)?.toLowerCase() === query.toLowerCase()
    ) || results[0];

    await sendMediaResult(chatId, 'tv', result);
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

    if (res.data && (res.data.title || res.data.name)) {
      await sendMediaResult(chatId, type, res.data);
    } else {
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
