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

const userSearchState = {};
const messageTimeouts = new Map();

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
  const userId = msg.from.id;

  const welcomeButtons = {
    inline_keyboard: [
      [{ text: 'Join Cineflow Chat', url: groupLink }],
      [{ text: 'Join Cineflow Movies', url: channelLink }],
      [{ text: 'Search Movies', switch_inline_query_current_chat: '/movie ' }]
    ]
  };

  const welcomeMsg = await bot.sendMessage(chatId,
    `👋 Welcome to Cineflow Bot!\n\n` +
    `🔗 Please join our community to use the bot:\n`,
    { 
      reply_markup: welcomeButtons,
      disable_web_page_preview: true 
    }
  );
  scheduleMessageDeletion(chatId, welcomeMsg.message_id, 300000);
});

async function sendMediaResult(chatId, type, result) {
  const title = result.title || result.name;
  const year = result.release_date?.split('-')[0] || result.first_air_date?.split('-')[0] || '';
  const caption = `*${title}* (${year})\n\n${result.overview || 'No overview available'}`;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(process.env.CINEFLOW_URL + `/${type}/${result.id}`)}&text=${encodeURIComponent(`Check out ${title} on Cineflow!`)} \n Join our community for more updates! \n 👉👉${groupLink}`;
  
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
        { text: '🔗 Share', url: shareUrl },
        { text: 'Join BackUp Channel', url: channelLink }
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
    // scheduleMessageDeletion(chatId, msg.message_id, 1000);
  } catch (err) {
    console.error('Error sending media:', err);
    // Fallback to text if image fails
    const msg = await bot.sendMessage(
      chatId,
      `${caption}\n\n🔗 ${process.env.CINEFLOW_URL}/${type}/${result.id}`,
      { 
        parse_mode: 'Markdown',
        reply_markup: buttons 
      }
    );
    // scheduleMessageDeletion(chatId, msg.message_id, 300000);
  }
}

// Improved sendSearchResults function
async function sendSearchResults(chatId, userId, query, page = 1) {
  try {
    // Clear previous search state
if (userSearchState[userId]?.timeout) {
      clearTimeout(userSearchState[userId].timeout);
      delete userSearchState[userId];
    }

    // API request
    const apiUrl = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&page=${page}&include_adult=false`;
    const finalUrl = `${process.env.PROXY_API_URL}${encodeURIComponent(apiUrl + `&api_key=${process.env.TMDB_API_KEY}`)}`;
    const res = await axios.get(finalUrl);

    // Process results
    const results = res.data?.results?.filter(item => 
      (item.media_type === 'movie' || item.media_type === 'tv') && item.poster_path
    ) || [];
    
    if (results.length === 0) {
      const msg = await bot.sendMessage(
        chatId, 
        `❌ No results for "${query}"\n\nTry a different search term.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Join Community', url: channelLink }]
            ]
          }
        }
      );
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
    const totalPages = Math.min(res.data.total_pages || 1, 5); // Limit to 5 pages max
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

    // Add share and join buttons
    buttons.push([
      { 
        text: '🔗 Share Search', 
        switch_inline_query: query 
      },
      { 
        text: 'Join Community', 
        url: channelLink 
      }
    ]);

    // Send results
    const msg = await bot.sendMessage(
      chatId,
      `🔍 Results for "${query}" (Page ${page}/${totalPages}):`,
      { 
        reply_markup: { inline_keyboard: buttons } 
      }
    );

    // Store for pagination and auto-delete
    userSearchState[userId] = {
      query, 
      page, 
      totalPages, 
      results,
      messageId: msg.message_id,
      timeout: setTimeout(async () => {
        try {
          // Only try to delete if the message is still there
          await bot.deleteMessage(chatId, msg.message_id);
        } catch (err) {
          console.log('Auto-delete failed (message may already be deleted):', err.message);
        } finally {
          delete userSearchState[userId];
        }
      }, 180000) // Delete after 3 minutes
    };

console.log(`Sending search results for ${query} page ${page} as message ${msg.message_id}`);

  } catch (err) {
    console.error('Search error:', err);
    const msg = await bot.sendMessage(
      chatId, 
      '⚠️ Search failed. Try again later.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Join Community', url: channelLink }]
          ]
        }
      }
    );
    scheduleMessageDeletion(chatId, msg.message_id);
  }
}

// Updated callback query handler
bot.on('callback_query', async (callbackQuery) => {
  const { message, data, from: { id: userId }, id: callbackId } = callbackQuery;
  const chatId = message.chat.id;

  try {
    if (data.startsWith('search_')) {
      // Handle pagination - format is "search_query_pageNumber"
      const parts = data.split('_');
      const query = parts.slice(1, -1).join('_'); // Handle queries with underscores
      const page = parseInt(parts[parts.length - 1]);
      
      await sendSearchResults(chatId, userId, query, page);
      await bot.deleteMessage(chatId, message.message_id);
      await bot.answerCallbackQuery(callbackId);
    } 
    else if (data.startsWith('select_')) {
      const [_, type, id] = data.split('_');
      const apiUrl = `https://api.themoviedb.org/3/${type}/${id}?api_key=${process.env.TMDB_API_KEY}`;
      const res = await axios.get(`${process.env.PROXY_API_URL}${encodeURIComponent(apiUrl)}`);
      
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

// Message handlers
bot.on('message', async (msg) => {
  const { text, chat: { id: chatId }, from: { id: userId } } = msg;
  if (!text || text.startsWith('/')) return;
  await sendSearchResults(chatId, userId, text.trim());
});

const handleMediaSearch = async (msg, match) => {
  const [_, type, query] = match;
  const { chat: { id: chatId }, from: { id: userId } } = msg;

  try {
    const apiUrl = `https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(query)}&page=1`;
    const finalUrl = `${process.env.PROXY_API_URL}${encodeURIComponent(apiUrl + `&api_key=${process.env.TMDB_API_KEY}`)}`;
    const res = await axios.get(finalUrl);

    const result = res.data?.results?.[0];
    if (!result) {
      const msg = await bot.sendMessage(
        chatId, 
        `❌ No ${type} found for "${query}"`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Try Again', switch_inline_query_current_chat: `/${type} ` }],
              [{ text: 'Join Community', url: channelLink }]
            ]
          }
        }
      );
      return scheduleMessageDeletion(chatId, msg.message_id);
    }

    await sendMediaResult(chatId, type, result);
  } catch (err) {
    console.error(`${type} search error:`, err);
    const msg = await bot.sendMessage(
      chatId, 
      `⚠️ ${type} search failed. Try again.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Join Community', url: channelLink }]
          ]
        }
      }
    );
    scheduleMessageDeletion(chatId, msg.message_id);
  }
};

bot.onText(/\/movie (.+)/, handleMediaSearch);
bot.onText(/\/tv (.+)/, handleMediaSearch);

bot.onText(/\/id (movie|tv) (\d+)/, async (msg, match) => {
  const [_, type, id] = match;
  const { chat: { id: chatId }, from: { id: userId } } = msg;

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
    const msg = await bot.sendMessage(
      chatId, 
      `❌ Invalid ${type} ID or not found`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Join Community', url: channelLink }]
          ]
        }
      }
    );
    scheduleMessageDeletion(chatId, msg.message_id);
  }
});