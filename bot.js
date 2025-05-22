require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const groupId = process.env.GROUP_ID;
const channelId = process.env.CHANNEL_ID;

// Store search results and timers for deletion
const userSearchState = {};

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
  { command: 'id', description: 'Search by TMDB ID (e.g., /id movie 12345)' },
]);

async function isMember(userId) {
  // Temporary manual override for testing
  if ([2019316303, 8056565859].includes(userId)) {
    console.log(`Bypassing check for user ${userId}`);
    return true;
  }

  try {
    // Check group membership
    try {
      const groupRes = await bot.getChatMember(groupId, userId);
      if (['creator', 'administrator', 'member'].includes(groupRes.status)) {
        console.log(`User ${userId} found in group`);
        return true;
      }
    } catch (groupErr) {
      console.log(`Group check error for ${userId}:`, groupErr.message);
    }

    // Check channel membership
    try {
      const channelRes = await bot.getChatMember(channelId, userId);
      if (['creator', 'administrator', 'member'].includes(channelRes.status)) {
        console.log(`User ${userId} found in channel`);
        return true;
      }
    } catch (channelErr) {
      console.log(`Channel check error for ${userId}:`, channelErr.message);
    }

    return false;
  } catch (err) {
    console.error('Global membership check error:', err);
    return false;
  }
}

// Verify bot is in required chats
async function verifyBotMembership() {
  try {
    await bot.getChat(groupId);
    console.log('✅ Bot is in group');
  } catch (err) {
    console.error('❌ Bot NOT in group - add it first!');
  }

  try {
    await bot.getChat(channelId);
    console.log('✅ Bot is in channel');
  } catch (err) {
    console.error('❌ Bot NOT in channel - add it first!');
  }
}

// Run on startup
verifyBotMembership();

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const allowed = await isMember(userId);
  if (allowed) {
    return bot.sendMessage(chatId, `👋 Welcome to Cineflow Bot!\n\n🎥 Search movies & TV shows and watch them directly on Cineflow.\n\nAvailable commands:\n/movie <movie name>\n/tv <tv show name>\n/id <movie/tv> <tmdb_id>`);
  }

  return bot.sendMessage(chatId, `👋 Welcome to Cineflow Bot!\n\n🎥 Search movies & TV shows and watch them directly on Cineflow.\n\n🔗 First, join our group or channel to use the bot (join any one):\n👉 [Join Cineflow Chat](https://t.me/cineflow_chat)\n👉 [Join Cineflow Movies](https://t.me/cineflow_movies_official)\n\nAfter joining, send /start again.\n\nAvailable commands:\n/movie <movie name>\n/tv <tv show name>\n/id <movie/tv> <tmdb_id>`, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
});

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
      return bot.sendMessage(chatId, `❌ No results found for "${query}". Please try again with a different query.`);
    }

    // Clear any existing timer for this user
    if (userSearchState[userId]?.timeout) {
      clearTimeout(userSearchState[userId].timeout);
    }

    userSearchState[userId] = {
      query,
      page,
      totalPages,
      results,
      messageId: null,
      timeout: null // Will store the deletion timer
    };

    const buttons = [];
    const mediaButtons = [];
    
    results.forEach((item) => {
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

    // Set a timer to delete the search results after 5 minutes (300000 ms)
    userSearchState[userId].timeout = setTimeout(async () => {
      try {
        if (userSearchState[userId]?.messageId) {
          await bot.deleteMessage(chatId, userSearchState[userId].messageId);
          delete userSearchState[userId];
        }
      } catch (err) {
        console.error('Error auto-deleting search results:', err.message);
      }
    }, 300000); // 5 minutes

  } catch (err) {
    console.error('Search error:', err.message);
    bot.sendMessage(chatId, '⚠️ Something went wrong. Try again later.');
  }
}

bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const messageId = callbackQuery.message.message_id;

  const isAllowed = await isMember(userId);
  if (!isAllowed) {
    return bot.answerCallbackQuery(callbackQuery.id, { 
      text: '🚫 Please join our group or channel first to use this bot.', 
      show_alert: true 
    });
  }

  try {
    if (data.startsWith('search_prev_') || data.startsWith('search_next_')) {
      // Handle pagination
      const [_, action, pageStr] = data.split('_');
      let page = parseInt(pageStr);
      
      page = action === 'prev' ? page - 1 : page + 1;

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
        // Send the media result
        await sendMediaResult(chatId, type, res.data);
        
        // Don't delete the search grid immediately - let the timer handle it
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: `✅ Showing ${type === 'movie' ? 'movie' : 'TV show'} details`,
          show_alert: false
        });
      }
    }
  } catch (err) {
    console.error('Callback error:', err.message);
    await bot.answerCallbackQuery(callbackQuery.id, { 
      text: '⚠️ Something went wrong. Try again.', 
      show_alert: true 
    });
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text?.trim();

  // Ignore if it's a command or empty
  if (!text || text.startsWith('/')) return;

  const isAllowed = await isMember(userId);
  if (!isAllowed) {
    return bot.sendMessage(chatId, `🚫 To use this bot, please join our group or channel first:\n👉 https://t.me/cineflow_chat\nor\n👉 https://t.me/cineflow_movies_official\n\n(You only need to join one)`);
  }

  // Send search results for the query
  await sendSearchResults(chatId, userId, text);
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
  if (!isAllowed) {
    return bot.sendMessage(chatId, `🚫 To use this bot, please join our group or channel first:\n👉 https://t.me/cineflow_chat\nor\n👉 https://t.me/cineflow_movies_official\n\n(You only need to join one)`);
  }

  try {
    const encodedUrl = encodeURIComponent(
      `https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(query)}&page=1&api_key=${process.env.TMDB_API_KEY}`
    );
    const finalUrl = `${process.env.PROXY_API_URL}${encodedUrl}`;
    const res = await axios.get(finalUrl);

    const results = res?.data?.results;
    if (!results || results.length === 0) {
      return bot.sendMessage(chatId, `❌ No ${type} found for "${query}". Please try again with a full name.`);
    }

    const result = results.find(r =>
      (r.title || r.name)?.toLowerCase() === query.toLowerCase()
    ) || results[0];

    await sendMediaResult(chatId, type, result);

  } catch (err) {
    console.error('Command error:', err.message);
    bot.sendMessage(chatId, '⚠️ Something went wrong. Try again later.');
  }
});

bot.onText(/\/id (movie|tv) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const type = match[1];
  const tmdbId = match[2];

  const isAllowed = await isMember(userId);
  if (!isAllowed) {
    return bot.sendMessage(chatId, `🚫 To use this bot, please join our group or channel first:\n👉 https://t.me/cineflow_chat\nor\n👉 https://t.me/cineflow_movies_official\n\n(You only need to join one)`);
  }

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
        console.error('Fallback ID search error:', fallbackErr.message);
        bot.sendMessage(chatId, `❌ No ${type} found with ID ${tmdbId}. Please check the ID and try again.`);
      }
    }
  } catch (err) {
    console.error('ID search error:', err.message);
    if (err.response?.status === 404) {
      bot.sendMessage(chatId, `❌ No ${type} found with ID ${tmdbId}. Please check the ID and try again.`);
    } else {
      bot.sendMessage(chatId, '⚠️ Something went wrong. Try again later.');
    }
  }
});
