require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express'); // Added for Render compatibility

// Initialize Express for Render's web service requirement
const app = express();
const port = process.env.PORT || 3000;

// Initialize your bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const groupId = process.env.GROUP_ID;

// Basic HTTP server to keep Render happy
app.get('/', (req, res) => {
  res.send('Cineflow Bot is running!');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

try {
  await bot.setWebHook(`${process.env.WEBHOOK_URL}/bot${process.env.BOT_TOKEN}`);
  console.log('Webhook set successfully');
} catch (err) {
  console.error('Error setting webhook:', err);
}
// Set bot commands
bot.setMyCommands([
  { command: 'start', description: 'Start the bot' },
  { command: 'movie', description: 'Search a movie (e.g., /movie Inception)' },
  { command: 'tv', description: 'Search a TV show (e.g., /tv Breaking Bad)' },
]);

// Group membership check
async function isMember(userId) {
  try {
    const res = await bot.getChatMember(groupId, userId);
    return ['creator', 'administrator', 'member'].includes(res.status);
  } catch (err) {
    console.error('Error checking membership:', err);
    return false;
  }
}

// Start command handler
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const allowed = await isMember(userId);
    if (allowed) {
      return bot.sendMessage(
        chatId,
        `🎬 Welcome to Cineflow Bot!\n\n` +
        `Search movies & TV shows:\n` +
        `/movie <name> - Find movies\n` +
        `/tv <name> - Find TV shows`,
        { parse_mode: 'Markdown' }
      );
    }

    return bot.sendMessage(
      chatId,
      `👋 Welcome!\n\n` +
      `🔹 Please join our group first:\n` +
      `👉 [Join Cineflow Chat](https://t.me/cineflow_chat)\n\n` +
      `Then use:\n` +
      `/movie <name> - Search movies\n` +
      `/tv <name> - Search TV shows`,
      {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }
    );
  } catch (err) {
    console.error('Start command error:', err);
    bot.sendMessage(chatId, '⚠️ Bot is having issues. Please try again later.');
  }
});

// Movie/TV search handler
bot.onText(/\/(movie|tv) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const type = match[1]; // 'movie' or 'tv'
  const query = match[2].trim();

  if (!query || query.length < 2) {
    return bot.sendMessage(
      chatId,
      `❌ Please enter a proper ${type} name.\nExample: /${type} ${type === 'movie' ? 'Inception' : 'Breaking Bad'}`
    );
  }

  try {
    // Check group membership
    const isAllowed = await isMember(userId);
    if (!isAllowed) {
      return bot.sendMessage(
        chatId,
        `🔒 Please join our group first:\n👉 https://t.me/cineflow_chat\n\nThen try your search again.`,
        { disable_web_page_preview: true }
      );
    }

    // Search TMDB API
    const encodedUrl = encodeURIComponent(
      `https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(query)}&page=1&api_key=${process.env.TMDB_API_KEY}`
    );
    const finalUrl = `${process.env.PROXY_API_URL}${encodedUrl}`;
    const response = await axios.get(finalUrl);
    const results = response.data?.results || [];

    if (results.length === 0) {
      return bot.sendMessage(
        chatId,
        `🔍 No ${type} found for "${query}".\nTry a different name or check spelling.`
      );
    }

    // Get the first result (most relevant)
    const media = results[0];
    const title = media.title || media.name;
    const year = new Date(media.release_date || media.first_air_date).getFullYear();
    const posterPath = media.poster_path ? `https://image.tmdb.org/t/p/w500${media.poster_path}` : null;
    const cineflowUrl = `${process.env.CINEFLOW_URL}/${type}/${media.id}`;

    // Send result to user
    if (posterPath) {
      await bot.sendPhoto(
        chatId,
        posterPath,
        {
          caption: `*${title} (${year || 'N/A'})*\n\n` +
                   `⭐ Rating: ${media.vote_average?.toFixed(1) || '?'}/10\n\n` +
                   `[Watch on Cineflow](${cineflowUrl})`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              {
                text: type === 'movie' ? '🎬 Watch Movie' : '📺 Watch Show',
                url: cineflowUrl
              }
            ]]
          }
        }
      );
    } else {
      await bot.sendMessage(
        chatId,
        `*${title} (${year || 'N/A'})*\n\n` +
        `⭐ Rating: ${media.vote_average?.toFixed(1) || '?'}/10\n\n` +
        `[Watch on Cineflow](${cineflowUrl})`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              {
                text: type === 'movie' ? '🎬 Watch Movie' : '📺 Watch Show',
                url: cineflowUrl
              }
            ]]
          }
        }
      );
    }

  } catch (error) {
    console.error('Search error:', error);
    bot.sendMessage(
      chatId,
      '⚠️ Failed to search. Please try again later.\n' +
      'If this keeps happening, contact support.'
    );
  }
});

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

console.log('Cineflow Bot is running...');