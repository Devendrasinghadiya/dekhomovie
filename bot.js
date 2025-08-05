require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const channelLink = process.env.CHANNEL_LINK || 'https://t.me/cineflow_movies_official';

const userSearchState = {};
const messageTimeouts = new Map();
const rateLimit = new Map();

// Rate limiting function
function checkRateLimit(userId) {
  const now = Date.now();
  const userLimit = rateLimit.get(userId) || { count: 0, lastRequest: 0 };
  
  if (now - userLimit.lastRequest < 2000) {
    userLimit.count++;
    if (userLimit.count > 5) {
      return false;
    }
  } else {
    userLimit.count = 1;
  }
  
  userLimit.lastRequest = now;
  rateLimit.set(userId, userLimit);
  return true;
}

// API request with retry logic
async function makeApiRequest(url, retries = 3, delay = 1000) {
  try {
    const response = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    return response;
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return makeApiRequest(url, retries - 1, delay * 2);
    }
    throw error;
  }
}

function scheduleMessageDeletion(chatId, messageId, delay = 120000) {
  clearTimeout(messageTimeouts.get(messageId));
  const timeout = setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
      messageTimeouts.delete(messageId);
    } catch (err) {
      console.error('Error deleting message:', err.message);
    }
  }, delay);
  messageTimeouts.set(messageId, timeout);
}

app.get('/', (req, res) => res.send('Cineflow Bot is running!'));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

bot.setMyCommands([
  { command: 'start', description: 'Start the bot' },
  { command: 'movie', description: 'Search a movie (e.g., /movie Inception)' },
  { command: 'tv', description: 'Search a TV show (e.g., /tv Breaking Bad)' },
  { command: 'id', description: 'Search by TMDB ID (e.g., /id movie 123)' }
]);

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const welcomeMsg = await bot.sendMessage(chatId,
    `👋 Welcome to Cineflow Bot!\n\n` +
    `Use /movie or /tv commands to search for content.\n` +
    `Example: /movie Inception`,
    { disable_web_page_preview: true }
  );
  scheduleMessageDeletion(chatId, welcomeMsg.message_id, 300000);
});

async function sendMediaResult(chatId, type, result) {
  const title = result.title || result.name;
  const year = result.release_date?.split('-')[0] || result.first_air_date?.split('-')[0] || '';
  const caption = `*${title}* (${year})\n\n${result.overview || 'No overview available'}`;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(process.env.CINEFLOW_URL + `/${type}/${result.id}`)}&text=${encodeURIComponent(`Check out ${title} on Cineflow!`)}`;
  
  const buttons = {
    inline_keyboard: [
      [
        { 
          text: type === 'movie' ? '🎬 Watch Movie' : '📺 Watch Episode',
          url: `${process.env.CINEFLOW_URL}/${type}/${result.id}`
        },
        { 
          text: '⬇️ Download', 
          url: `${process.env.CINEFLOW_URL}/download/${type}/${result.id}`
        }
      ],
      [
        { text: '🔗 Share', url: shareUrl }
      ]
    ]
  };

  try {
    const msg = await bot.sendPhoto(
      chatId,
      `https://image.tmdb.org/t/p/w500${result.poster_path}`,
      {
        caption,
        parse_mode: 'Markdown',
        reply_markup: buttons
      }
    );
  } catch (err) {
    console.error('Error sending media:', err);
    const msg = await bot.sendMessage(
      chatId,
      `${caption}\n\n🔗 ${process.env.CINEFLOW_URL}/${type}/${result.id}`,
      { 
        parse_mode: 'Markdown',
        reply_markup: buttons 
      }
    );
  }
}

async function sendSearchResults(chatId, userId, query, page = 1) {
  try {
    if (!checkRateLimit(userId)) {
      const msg = await bot.sendMessage(chatId, '⏳ Please wait a moment before making another request.');
      scheduleMessageDeletion(chatId, msg.message_id);
      return;
    }

    if (userSearchState[userId]?.timeout) {
      clearTimeout(userSearchState[userId].timeout);
      delete userSearchState[userId];
    }

    const apiUrl = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&page=${page}&include_adult=false`;
    // Try direct API access first, fall back to proxy if needed
    let res;
    try {
      res = await makeApiRequest(`${apiUrl}&api_key=${process.env.TMDB_API_KEY}`);
    } catch (directError) {
      console.log('Direct API failed, trying proxy...');
      const finalUrl = `${process.env.PROXY_API_URL}${encodeURIComponent(apiUrl + `&api_key=${process.env.TMDB_API_KEY}`)}`;
      res = await makeApiRequest(finalUrl);
    }

    const results = res.data?.results?.filter(item => 
      (item.media_type === 'movie' || item.media_type === 'tv') && item.poster_path
    ) || [];
    
    if (results.length === 0) {
      const msg = await bot.sendMessage(chatId, `❌ No results for "${query}"\n\nTry a different search term.`);
      scheduleMessageDeletion(chatId, msg.message_id);
      return;
    }

    const buttons = [];
    let currentRow = [];
    
    results.forEach(item => {
      const emoji = item.media_type === 'movie' ? '🎬' : '📺';
      const year = item.release_date?.split('-')[0] || item.first_air_date?.split('-')[0] || '';
      const title = `${emoji} ${item.title || item.name}${year ? ` (${year})` : ''}`;
      
      if (title.length > 25 || currentRow.length >= 2) {
        if (currentRow.length > 0) buttons.push(currentRow);
        currentRow = [];
      }
      
      currentRow.push({
        text: title,
        callback_data: `select_${item.media_type}_${item.id}`
      });
    });

    if (currentRow.length > 0) buttons.push(currentRow);

    const totalPages = Math.min(res.data.total_pages || 1, 5);
    if (totalPages > 1) {
      const pagination = [];
      if (page > 1) pagination.push({ 
        text: '⬅️ Previous', 
        callback_data: `search_${query}_${page-1}` 
      });
      if (page < totalPages) pagination.push({ 
        text: 'Next ➡️', 
        callback_data: `search_${query}_${page+1}` 
      });
      if (pagination.length > 0) buttons.push(pagination);
    }

    buttons.push([{ 
      text: '🔗 Share Search', 
      switch_inline_query: query 
    }]);

    const msg = await bot.sendMessage(
      chatId,
      `🔍 Results for "${query}" (Page ${page}/${totalPages}):`,
      { 
        reply_markup: { inline_keyboard: buttons } 
      }
    );

    userSearchState[userId] = {
      query, 
      page, 
      totalPages, 
      results,
      messageId: msg.message_id,
      timeout: setTimeout(async () => {
        try {
          await bot.deleteMessage(chatId, msg.message_id);
        } catch (err) {
          console.log('Auto-delete failed:', err.message);
        } finally {
          delete userSearchState[userId];
        }
      }, 180000)
    };

  } catch (err) {
    console.error('Search error:', err);
    let errorMessage = '⚠️ Search failed. Try again later.';
    
    if (err.response) {
      if (err.response.status === 403) {
        errorMessage = '🔒 Access denied. The bot is temporarily blocked. Please try again in a few minutes.';
      } else if (err.response.status === 429) {
        errorMessage = '⏳ Too many requests. Please wait before trying again.';
      }
    }
    
    const msg = await bot.sendMessage(chatId, errorMessage);
    scheduleMessageDeletion(chatId, msg.message_id);
  }
}

bot.on('callback_query', async (callbackQuery) => {
  const { message, data, from: { id: userId }, id: callbackId } = callbackQuery;
  const chatId = message.chat.id;

  try {
    if (!checkRateLimit(userId)) {
      await bot.answerCallbackQuery(callbackId, {
        text: 'Please wait before making another request',
        show_alert: false
      });
      return;
    }

    if (data.startsWith('search_')) {
      const parts = data.split('_');
      const query = parts.slice(1, -1).join('_');
      const page = parseInt(parts[parts.length - 1]);
      
      await sendSearchResults(chatId, userId, query, page);
      await bot.deleteMessage(chatId, message.message_id);
      await bot.answerCallbackQuery(callbackId);
    } 
    else if (data.startsWith('select_')) {
      const [_, type, id] = data.split('_');
      const apiUrl = `https://api.themoviedb.org/3/${type}/${id}?api_key=${process.env.TMDB_API_KEY}`;
      
      let res;
      try {
        res = await makeApiRequest(apiUrl);
      } catch (directError) {
        console.log('Direct API failed, trying proxy...');
        const finalUrl = `${process.env.PROXY_API_URL}${encodeURIComponent(apiUrl)}`;
        res = await makeApiRequest(finalUrl);
      }
      
      if (res.data) {
        await sendMediaResult(chatId, type, res.data);
      }
      await bot.answerCallbackQuery(callbackId);
    }
    else {
      await bot.answerCallbackQuery(callbackId, {
        text: 'Unknown action',
        show_alert: false
      });
    }
  } catch (err) {
    console.error('Callback error:', err);
    await bot.answerCallbackQuery(callbackId, {
      text: 'Action failed. Try again.',
      show_alert: true
    });
  }
});

bot.on('message', async (msg) => {
  const { text, chat: { id: chatId }, from: { id: userId } } = msg;
  if (!text || text.startsWith('/')) return;
  await sendSearchResults(chatId, userId, text.trim());
});

const handleMediaSearch = async (msg, match) => {
  const [_, type, query] = match;
  const { chat: { id: chatId }, from: { id: userId } } = msg;

  try {
    if (!checkRateLimit(userId)) {
      const msg = await bot.sendMessage(chatId, '⏳ Please wait a moment before making another request.');
      return scheduleMessageDeletion(chatId, msg.message_id);
    }

    const apiUrl = `https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(query)}&page=1`;
    
    let res;
    try {
      res = await makeApiRequest(`${apiUrl}&api_key=${process.env.TMDB_API_KEY}`);
    } catch (directError) {
      console.log('Direct API failed, trying proxy...');
      const finalUrl = `${process.env.PROXY_API_URL}${encodeURIComponent(apiUrl + `&api_key=${process.env.TMDB_API_KEY}`)}`;
      res = await makeApiRequest(finalUrl);
    }

    const result = res.data?.results?.[0];
    if (!result) {
      const msg = await bot.sendMessage(chatId, `❌ No ${type} found for "${query}"`);
      return scheduleMessageDeletion(chatId, msg.message_id);
    }

    await sendMediaResult(chatId, type, result);
  } catch (err) {
    console.error(`${type} search error:`, err);
    let errorMessage = `⚠️ ${type} search failed. Try again.`;
    
    if (err.response) {
      if (err.response.status === 403) {
        errorMessage = '🔒 Access denied. Please try again later.';
      } else if (err.response.status === 429) {
        errorMessage = '⏳ Too many requests. Please wait before trying again.';
      }
    }
    
    const msg = await bot.sendMessage(chatId, errorMessage);
    scheduleMessageDeletion(chatId, msg.message_id);
  }
};

bot.onText(/\/movie (.+)/, handleMediaSearch);
bot.onText(/\/tv (.+)/, handleMediaSearch);

bot.onText(/\/id (movie|tv) (\d+)/, async (msg, match) => {
  const [_, type, id] = match;
  const { chat: { id: chatId }, from: { id: userId } } = msg;

  try {
    if (!checkRateLimit(userId)) {
      const msg = await bot.sendMessage(chatId, '⏳ Please wait a moment before making another request.');
      return scheduleMessageDeletion(chatId, msg.message_id);
    }

    const apiUrl = `https://api.themoviedb.org/3/${type}/${id}?api_key=${process.env.TMDB_API_KEY}`;
    
    let res;
    try {
      res = await makeApiRequest(apiUrl);
    } catch (directError) {
      console.log('Direct API failed, trying proxy...');
      const finalUrl = `${process.env.PROXY_API_URL}${encodeURIComponent(apiUrl)}`;
      res = await makeApiRequest(finalUrl);
    }
    
    if (res.data) {
      await sendMediaResult(chatId, type, res.data);
    } else {
      throw new Error('No data received');
    }
  } catch (err) {
    console.error('ID search error:', err);
    const msg = await bot.sendMessage(chatId, `❌ Invalid ${type} ID or not found`);
    scheduleMessageDeletion(chatId, msg.message_id);
  }
});