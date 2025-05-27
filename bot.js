require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const Fuse = require('fuse.js');

const app = express();
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const groupId = process.env.GROUP_ID;
const channelId = process.env.CHANNEL_ID;
const groupLink = process.env.GROUP_LINK || 'https://t.me/cineflow_chat';
const channelLink = process.env.CHANNEL_LINK || 'https://t.me/cineflow_movies_official';

// Store search results and timers
const userSearchState = {};
const messageTimeouts = new Map();

// Helper function to delete messages after delay
function scheduleMessageDeletion(chatId, messageId, delay = 120000) {
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

// Initialize Express server
app.get('/', (req, res) => res.send('Cineflow Bot is running!'));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Set bot commands
bot.setMyCommands([
  { command: 'start', description: 'Start the bot' },
  { command: 'movie', description: 'Search a movie (e.g., /movie Inception)' },
  { command: 'tv', description: 'Search a TV show (e.g., /tv Breaking Bad)' },
  { command: 'id', description: 'Search by TMDB ID (e.g., /id movie 123)' }
]);

// Membership verification
async function isMember(userId) {
  // Test user IDs bypass
  if ([2019316303, 8056565859].includes(userId)) {
    console.log(`Bypassing check for user ${userId}`);
    return true;
  }

  try {
    // Check group membership
    const groupRes = await bot.getChatMember(groupId, userId);
    if (['creator', 'administrator', 'member'].includes(groupRes.status)) {
      return true;
    }
  } catch (groupErr) {
    console.log(`Group check error: ${groupErr.message}`);
  }

  // Check channel membership
  try {
    const channelRes = await bot.getChatMember(channelId, userId);
    if (['creator', 'administrator', 'member'].includes(channelRes.status)) {
      return true;
    }
  } catch (channelErr) {
    console.log(`Channel check error: ${channelErr.message}`);
  }

  return false;
}

// Start command handler
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (await isMember(userId)) {
    return bot.sendMessage(chatId, 
      `👋 Welcome to Cineflow Bot!\n\n` +
      `🎥 Search movies & TV shows\n\n` +
      `Available commands:\n` +
      `/movie <name>\n/tv <name>\n/id <type> <tmdb_id>`
    );
  }

  const welcomeMsg = await bot.sendMessage(chatId,
    `👋 Welcome to Cineflow Bot!\n\n` +
    `🔗 Please join our community:\n` +
    `👉 [Cineflow Chat](${groupLink})\n` +
    `👉 [Cineflow Movies](${channelLink})\n\n` +
    `After joining, send /start again.`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );
  scheduleMessageDeletion(chatId, welcomeMsg.message_id, 300000);
});

// Improved media result display
async function sendMediaResult(chatId, type, result) {
  const title = result.title || result.name;
  const year = result.release_date?.split('-')[0] || result.first_air_date?.split('-')[0] || '';
  const caption = `*${title}* (${year})\n\n${result.overview || 'No overview available'}`;
  
  const buttons = [
    [
      { 
        text: type === 'movie' ? '🎬 Watch Movie' : '📺 Watch Episode',
        url: `${process.env.CINEFLOW_URL}/${type}/${result.id}`
      },
      { 
        text: '⬇️ Download', 
        url: `${process.env.CINEFLOW_URL}/download/${type}/${result.id}`
      }
    ]
  ];

  const msg = await bot.sendPhoto(
    chatId,
    `https://image.tmdb.org/t/p/w500${result.poster_path}`,
    {
      caption,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    }
  );
  scheduleMessageDeletion(chatId, msg.message_id, 300000);
}

// Enhanced search results with smart grid layout
async function sendSearchResults(chatId, userId, query, page = 1) {
  try {
    // API request
    const apiUrl = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&page=${page}&include_adult=false`;
    const finalUrl = `${process.env.PROXY_API_URL}${encodeURIComponent(apiUrl + `&api_key=${process.env.TMDB_API_KEY}`)}`;
    const res = await axios.get(finalUrl);

    // Process results
    const results = res.data?.results?.filter(item => 
      (item.media_type === 'movie' || item.media_type === 'tv') && item.poster_path
    ) || [];
    
    if (results.length === 0) {
      const msg = await bot.sendMessage(chatId, `❌ No results for "${query}"`);
      scheduleMessageDeletion(chatId, msg.message_id);
      return;
    }

    // Create buttons with smart layout
    const buttons = [];
    let currentRow = [];
    
    results.forEach(item => {
      const emoji = item.media_type === 'movie' ? '🎬' : '📺';
      const year = item.release_date?.split('-')[0] || item.first_air_date?.split('-')[0] || '';
      const title = `${emoji} ${item.title || item.name}${year ? ` (${year})` : ''}`;
      
      // Smart row breaking
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

    // Add pagination if needed
    const totalPages = res.data.total_pages || 1;
    if (totalPages > 1) {
      const pagination = [];
      if (page > 1) pagination.push({ text: '⬅️ Previous', callback_data: `search_prev_${page}` });
      if (page < totalPages) pagination.push({ text: 'Next ➡️', callback_data: `search_next_${page}` });
      if (pagination.length > 0) buttons.push(pagination);
    }

    // Send results
    const msg = await bot.sendMessage(
      chatId,
      `🔍 Results for "${query}" (Page ${page}/${totalPages}):`,
      { reply_markup: { inline_keyboard: buttons } }
    );

    // Store for pagination
    userSearchState[userId] = {
      query, page, totalPages, results,
      messageId: msg.message_id,
      timeout: setTimeout(() => {
        bot.deleteMessage(chatId, msg.message_id).catch(console.error);
        delete userSearchState[userId];
      }, 180000)
    };

  } catch (err) {
    console.error('Search error:', err);
    const msg = await bot.sendMessage(chatId, '⚠️ Search failed. Try again later.');
    scheduleMessageDeletion(chatId, msg.message_id);
  }
}

// Callback query handler
bot.on('callback_query', async (callbackQuery) => {
  const { message, data, from: { id: userId } } = callbackQuery;
  const chatId = message.chat.id;

  if (!await isMember(userId)) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Please join our community first!',
      show_alert: true
    });
  }

  try {
    if (data.startsWith('search_')) {
      // Pagination handling
      const [_, action, page] = data.split('_');
      const newPage = parseInt(page) + (action === 'prev' ? -1 : 1);
      const searchState = userSearchState[userId];
      
      if (searchState) {
        await sendSearchResults(chatId, userId, searchState.query, newPage);
        await bot.deleteMessage(chatId, searchState.messageId);
      }
    } 
    else if (data.startsWith('select_')) {
      // Media selection
      const [_, type, id] = data.split('_');
      const apiUrl = `https://api.themoviedb.org/3/${type}/${id}?api_key=${process.env.TMDB_API_KEY}`;
      const res = await axios.get(`${process.env.PROXY_API_URL}${encodeURIComponent(apiUrl)}`);
      
      if (res.data) {
        await sendMediaResult(chatId, type, res.data);
      }
    }
    
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (err) {
    console.error('Callback error:', err);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Action failed. Try again.',
      show_alert: true
    });
  }
});

// Message handlers
bot.on('message', async (msg) => {
  const { text, chat: { id: chatId }, from: { id: userId } } = msg;
  if (!text || text.startsWith('/')) return;

  if (!await isMember(userId)) {
    const msg = await bot.sendMessage(chatId, 
      `🚫 Please join our community first:\n${groupLink}\nor\n${channelLink}`
    );
    return scheduleMessageDeletion(chatId, msg.message_id);
  }

  await sendSearchResults(chatId, userId, text.trim());
});

bot.onText(/\/(movie|tv) (.+)/, async (msg, match) => {
  const [_, type, query] = match;
  const { chat: { id: chatId }, from: { id: userId } } = msg;

  if (!await isMember(userId)) {
    const msg = await bot.sendMessage(chatId, 
      `🚫 Please join our community first:\n${groupLink}\nor\n${channelLink}`
    );
    return scheduleMessageDeletion(chatId, msg.message_id);
  }

  try {
    const apiUrl = `https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(query)}&page=1`;
    const finalUrl = `${process.env.PROXY_API_URL}${encodeURIComponent(apiUrl + `&api_key=${process.env.TMDB_API_KEY}`)}`;
    const res = await axios.get(finalUrl);

    const result = res.data?.results?.[0];
    if (!result) {
      const msg = await bot.sendMessage(chatId, `❌ No ${type} found for "${query}"`);
      return scheduleMessageDeletion(chatId, msg.message_id);
    }

    await sendMediaResult(chatId, type, result);
  } catch (err) {
    console.error(`${type} search error:`, err);
    const msg = await bot.sendMessage(chatId, `⚠️ ${type} search failed. Try again.`);
    scheduleMessageDeletion(chatId, msg.message_id);
  }
});

bot.onText(/\/id (movie|tv) (\d+)/, async (msg, match) => {
  const [_, type, id] = match;
  const { chat: { id: chatId }, from: { id: userId } } = msg;

  if (!await isMember(userId)) {
    const msg = await bot.sendMessage(chatId, 
      `🚫 Please join our community first:\n${groupLink}\nor\n${channelLink}`
    );
    return scheduleMessageDeletion(chatId, msg.message_id);
  }

  try {
    const apiUrl = `https://api.themoviedb.org/3/${type}/${id}?api_key=${process.env.TMDB_API_KEY}`;
    const res = await axios.get(`${process.env.PROXY_API_URL}${encodeURIComponent(apiUrl)}`);
    
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
