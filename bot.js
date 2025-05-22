require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const groupId = process.env.GROUP_ID;

// Store search results and pagination state
const userSearchState = {};

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
    return bot.sendMessage(chatId, `👋 Welcome to Cineflow Bot!\n\n🎥 Search movies & TV shows and watch them directly on Cineflow.\n\nAvailable commands:\n/movie <movie name>\n/tv <tv show name>\n/id <movie/tv> <tmdb_id>`);
  }

  return bot.sendMessage(chatId, `👋 Welcome to Cineflow Bot!\n\n🎥 Search movies & TV shows and watch them directly on Cineflow.\n\n🔗 First, join our group to use the bot:\n👉 [Join Cineflow Chat](https://t.me/cineflow_chat)\n\nAvailable commands:\n/movie <movie name>\n/tv <tv show name>\n/id <movie/tv> <tmdb_id>`, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
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

// Function to send search results as button grid
async function sendSearchResults(chatId, userId, query, page = 1) {
  try {
    const encodedUrl = encodeURIComponent(
      `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&page=${page}&include_adult=false&api_key=${process.env.TMDB_API_KEY}`
    );
    const finalUrl = `${process.env.PROXY_API_URL}${encodedUrl}`;
    const res = await axios.get(finalUrl);

    const results = res?.data?.results?.filter(item => 
      (item.media_type === 'movie' || item.media_type === 'tv') && item.poster_path
    );
    const totalPages = res?.data?.total_pages || 1;
    
    if (!results || results.length === 0) {
      return bot.sendMessage(chatId, `❌ No results found. Please try again with a different query.`);
    }

    // Store search state for pagination
    userSearchState[userId] = {
      query,
      page,
      totalPages,
      results,
      messageId: null // Will be set after sending the message
    };

    // Create button grid (3 buttons per row)
    const buttons = [];
    const mediaButtons = [];
    
    results.forEach((item, index) => {
      const emoji = item.media_type === 'movie' ? '🎬' : '📺';
      const year = item.release_date ? item.release_date.split('-')[0] : (item.first_air_date ? item.first_air_date.split('-')[0] : '');
      const buttonText = `${emoji} ${item.title || item.name}${year ? ` (${year})` : ''}`;
      
      mediaButtons.push({
        text: buttonText,
        callback_data: `select_${item.media_type}_${item.id}`
      });
    });

    // Split into rows of 3 buttons each
    while (mediaButtons.length > 0) {
      buttons.push(mediaButtons.splice(0, 3));
    }

    // Add pagination buttons if needed
    if (totalPages > 1) {
      const paginationRow = [];
      if (page > 1) {
        paginationRow.push({ text: '⬅️ Previous', callback_data: `search_prev_${page}` });
      }
      if (page < totalPages) {
        paginationRow.push({ text: 'Next ➡️', callback_data: `search_next_${page}` });
      }
      buttons.push(paginationRow);
    }

    const message = await bot.sendMessage(chatId, `🔍 Search Results for "${query}" (Page ${page}/${totalPages}):`, {
      reply_markup: {
        inline_keyboard: buttons
      }
    });

    // Store the message ID for later deletion
    userSearchState[userId].messageId = message.message_id;

  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, '⚠️ Something went wrong. Try again later.');
  }
}

// Handle callback queries for pagination and selection
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const messageId = callbackQuery.message.message_id;

  const isAllowed = await isMember(userId);
  if (!isAllowed) {
    return bot.answerCallbackQuery(callbackQuery.id, { text: '🚫 Please join our group first to use this bot.', show_alert: true });
  }

  try {
    if (data.startsWith('search_prev_') || data.startsWith('search_next_')) {
      // Handle pagination
      const [_, action, pageStr] = data.split('_');
      let page = parseInt(pageStr);
      
      if (action === 'prev') {
        page--;
      } else if (action === 'next') {
        page++;
      }

      const searchState = userSearchState[userId];
      if (searchState) {
        await sendSearchResults(chatId, userId, searchState.query, page);
        // Delete the old search results message
        if (searchState.messageId) {
          try {
            await bot.deleteMessage(chatId, searchState.messageId);
          } catch (err) {
            console.error('Error deleting old search message:', err.message);
          }
        }
      }
      
      await bot.answerCallbackQuery(callbackQuery.id);
    } else if (data.startsWith('select_')) {
      // Handle selection
      const [_, type, id] = data.split('_');
      
      const encodedUrl = encodeURIComponent(
        `https://api.themoviedb.org/3/${type}/${id}?api_key=${process.env.TMDB_API_KEY}`
      );
      const finalUrl = `${process.env.PROXY_API_URL}${encodedUrl}`;
      const res = await axios.get(finalUrl);

      if (res.data) {
        // Delete the search results message first
        const searchState = userSearchState[userId];
        if (searchState?.messageId) {
          try {
            await bot.deleteMessage(chatId, searchState.messageId);
          } catch (err) {
            console.error('Error deleting search message:', err.message);
          }
        }
        
        // Send the media result
        await sendMediaResult(chatId, type, res.data);
      }
      
      await bot.answerCallbackQuery(callbackQuery.id);
    }
  } catch (err) {
    console.error(err.message);
    await bot.answerCallbackQuery(callbackQuery.id, { text: '⚠️ Something went wrong. Try again.', show_alert: true });
  }
});

// Handle direct movie/TV show name input (without commands)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text?.trim();

  // Ignore if it's a command or empty
  if (!text || text.startsWith('/')) return;

  const isAllowed = await isMember(userId);
  if (!isAllowed) {
    return bot.sendMessage(chatId, `🚫 To use this bot, please join our group first:\n👉 https://t.me/cineflow_chat`);
  }

  // Send search results for the query using multi-search
  await sendSearchResults(chatId, userId, text);
});

// Existing command handlers (unchanged)
bot.onText(/\/(movie|tv) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const type = match[1];
  const query = match[2].trim();

  if (!query) {
    return bot.sendMessage(chatId, `❌ Please enter a ${type} name. Example:\n/${type} RRR`);
  }

  const isAllowed = await isMember(userId);
  if (!isAllowed) {
    return bot.sendMessage(chatId, `🚫 To use this bot, please join our group first:\n👉 https://t.me/cineflow_chat`);
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

// Updated TMDB ID search command
bot.onText(/\/id (movie|tv) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const type = match[1];
  const tmdbId = match[2];

  const isAllowed = await isMember(userId);
  if (!isAllowed) {
    return bot.sendMessage(chatId, `🚫 To use this bot, please join our group first:\n👉 https://t.me/cineflow_chat`);
  }

  try {
    const encodedUrl = encodeURIComponent(
      `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${process.env.TMDB_API_KEY}`
    );
    const finalUrl = `${process.env.PROXY_API_URL}${encodedUrl}`;
    const res = await axios.get(finalUrl);

    // Check if response contains valid data (not checking for success flag)
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
