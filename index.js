require('dotenv').config();
const { App } = require('@slack/bolt');
const { Pool } = require('pg');

// Debug logging
console.log('=== ENVIRONMENT VARIABLES DEBUG ===');
console.log('SLACK_BOT_TOKEN:', process.env.SLACK_BOT_TOKEN ? 'EXISTS' : 'MISSING');
console.log('SLACK_SIGNING_SECRET:', process.env.SLACK_SIGNING_SECRET ? 'EXISTS' : 'MISSING');
console.log('SLACK_APP_TOKEN:', process.env.SLACK_APP_TOKEN ? 'EXISTS' : 'MISSING');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'EXISTS' : 'MISSING');
console.log('===============================');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Admin user ID - CHANGE THIS TO YOUR SLACK USER ID
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'U08QVDK2Z4L'; // Ryan's user ID

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initializeDatabase() {
  try {
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        bankroll INTEGER DEFAULT 1000,
        total_staked INTEGER DEFAULT 0,
        bets_placed INTEGER DEFAULT 0,
        bets_won INTEGER DEFAULT 0,
        accuracy DECIMAL(3,2) DEFAULT 0.5,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create markets table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS markets (
        id VARCHAR(255) PRIMARY KEY,
        question TEXT NOT NULL,
        creator VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deadline TIMESTAMP NOT NULL,
        resolved BOOLEAN DEFAULT FALSE,
        resolution BOOLEAN DEFAULT NULL,
        resolved_at TIMESTAMP DEFAULT NULL,
        probability DECIMAL(5,4) DEFAULT 0.5,
        total_stake INTEGER DEFAULT 0,
        active BOOLEAN DEFAULT TRUE
      )
    `);

    // Create bets table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id SERIAL PRIMARY KEY,
        market_id VARCHAR(255) REFERENCES markets(id),
        user_id VARCHAR(255) NOT NULL,
        stake INTEGER NOT NULL,
        probability DECIMAL(5,4) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(market_id, user_id)
      )
    `);

    console.log('✅ Database tables initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
  }
}

// Database helper functions
async function getUser(userId) {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      // Create new user
      await pool.query(`
        INSERT INTO users (id, bankroll, total_staked, bets_placed, bets_won, accuracy)
        VALUES ($1, 1000, 0, 0, 0, 0.5)
      `, [userId]);
      return { id: userId, bankroll: 1000, total_staked: 0, bets_placed: 0, bets_won: 0, accuracy: 0.5 };
    }
    return result.rows[0];
  } catch (error) {
    console.error('Error getting user:', error);
    throw error;
  }
}

async function updateUser(userId, updates) {
  try {
    const fields = Object.keys(updates).map((key, index) => `${key} = $${index + 2}`).join(', ');
    const values = [userId, ...Object.values(updates)];
    await pool.query(`UPDATE users SET ${fields} WHERE id = $1`, values);
  } catch (error) {
    console.error('Error updating user:', error);
    throw error;
  }
}

async function getMarket(marketId) {
  try {
    const result = await pool.query('SELECT * FROM markets WHERE id = $1', [marketId]);
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Error getting market:', error);
    throw error;
  }
}

async function createMarket(marketData) {
  try {
    await pool.query(`
      INSERT INTO markets (id, question, creator, deadline, probability, total_stake, active)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      marketData.id,
      marketData.question,
      marketData.creator,
      marketData.deadline,
      marketData.probability,
      marketData.totalStake,
      marketData.active
    ]);
  } catch (error) {
    console.error('Error creating market:', error);
    throw error;
  }
}

async function updateMarket(marketId, updates) {
  try {
    const fields = Object.keys(updates).map((key, index) => `${key} = $${index + 2}`).join(', ');
    const values = [marketId, ...Object.values(updates)];
    await pool.query(`UPDATE markets SET ${fields} WHERE id = $1`, values);
  } catch (error) {
    console.error('Error updating market:', error);
    throw error;
  }
}

async function getMarketBets(marketId) {
  try {
    const result = await pool.query('SELECT * FROM bets WHERE market_id = $1', [marketId]);
    return result.rows;
  } catch (error) {
    console.error('Error getting market bets:', error);
    throw error;
  }
}

async function getUserBet(marketId, userId) {
  try {
    const result = await pool.query('SELECT * FROM bets WHERE market_id = $1 AND user_id = $2', [marketId, userId]);
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Error getting user bet:', error);
    throw error;
  }
}

async function upsertBet(marketId, userId, stake, probability) {
  try {
    await pool.query(`
      INSERT INTO bets (market_id, user_id, stake, probability, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (market_id, user_id)
      DO UPDATE SET 
        stake = EXCLUDED.stake,
        probability = EXCLUDED.probability,
        updated_at = CURRENT_TIMESTAMP
    `, [marketId, userId, stake, probability]);
  } catch (error) {
    console.error('Error upserting bet:', error);
    throw error;
  }
}

async function getActiveMarkets() {
  try {
    const result = await pool.query(`
      SELECT * FROM markets 
      WHERE active = true AND resolved = false 
      ORDER BY created_at DESC
    `);
    return result.rows;
  } catch (error) {
    console.error('Error getting active markets:', error);
    throw error;
  }
}

// Perfect stake formula
function calculateStake(desired_amount) {
    return Math.min(Math.max(desired_amount, 1), 100); // $1 min, $100 max
}

// Perfect market update formula
function updateMarketProbability(current_stakes, current_probs, new_stake, new_prob, old_stake = 0, old_prob = 0) {
    const current_total = current_stakes.reduce((sum, stake) => sum + stake, 0);
    
    if (current_total === 0) return new_prob; // First bet
    
    const new_total = current_total - old_stake + new_stake;
    const weighted_sum = current_stakes.reduce((sum, stake, i) => sum + stake * current_probs[i], 0) 
                        - old_stake * old_prob + new_stake * new_prob;
    
    return new_total === 0 ? 0.5 : weighted_sum / new_total;
}

// Perfect placeBet core logic
async function placeBet(market_id, user_id, desired_amount, probability) {
    // Validation
    if (probability < 0 || probability > 1) {
        throw new Error("Probability must be between 0 and 1");
    }
    
    const market = await getMarket(market_id);
    if (!market || !market.active) {
        throw new Error("Market not found or inactive");
    }
    
    if (new Date() > new Date(market.deadline)) {
        throw new Error("Market has expired");
    }
    
    // Calculate actual stake
    const stake = calculateStake(desired_amount);
    
    // Check user bankroll
    const user = await getUser(user_id);
    const old_bet = await getUserBet(market_id, user_id);
    const available_bankroll = user.bankroll - user.total_staked + (old_bet ? old_bet.stake : 0);
    
    if (stake > available_bankroll) {
        throw new Error(`Insufficient bankroll. Available: $${available_bankroll}`);
    }
    
    // Get current state for probability calculation (excluding the bet being updated)
    const all_bets = await getMarketBets(market_id);
    const other_bets = all_bets.filter(bet => bet.user_id !== user_id);
    const current_stakes = other_bets.map(bet => parseInt(bet.stake));
    const current_probs = other_bets.map(bet => parseFloat(bet.probability));
    
    // Update market probability
    const new_prob = updateMarketProbability(
        current_stakes, 
        current_probs, 
        stake, 
        probability,
        0, // No old bet to remove since we filtered it out
        0
    );
    
    // Calculate new total stake
    const old_stake = old_bet ? old_bet.stake : 0;
    const new_total_stake = market.total_stake - old_stake + stake;
    
    // Update database in transaction
    try {
        await pool.query('BEGIN');
        
        // Update bet
        await upsertBet(market_id, user_id, stake, probability);
        
        // Update market
        await updateMarket(market_id, {
            probability: new_prob,
            total_stake: new_total_stake
        });
        
        // Update user
        const net_stake_change = stake - old_stake;
        await updateUser(user_id, {
            total_staked: user.total_staked + net_stake_change
        });
        
        await pool.query('COMMIT');
        
        return {
            stake_placed: stake,
            new_market_probability: new_prob,
            was_capped: stake < desired_amount,
            message: stake < desired_amount ? `Bet capped at $${stake} (max: $100)` : `Bet placed: $${stake}`,
            user: await getUser(user_id),
            market: await getMarket(market_id)
        };
        
    } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
    }
}

// Show help menu (different for admin vs regular users)
function getHelpMenu(isAdmin = false) {
  const adminSection = isAdmin ? {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*🔧 Admin Commands:*\n`/predict resolve market_123 yes|no` - Resolve markets and distribute payouts"
    }
  } : null;

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "🎯 *Prediction Market Bot Help*\n\nCreate binary prediction markets and bet on outcomes with your team!"
      }
    },
    {
      type: "divider"
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*📝 Create Markets:*\n`/predict create Will we ship Feature X by Friday? | 2025-06-20`\n\n*💰 Place Bets:*\n`/predict bet market_123 75 50` (75% probability, $50 stake)\n\n*📊 View Markets:*\n`/predict markets` - List all active markets\n\n*📈 Your Stats:*\n`/predict stats` - View your performance\n\n*ℹ️ Market Info:*\n`/predict info market_123` - Detailed market view"
      }
    }
  ];

  if (adminSection) {
    blocks.push({
      type: "divider"
    });
    blocks.push(adminSection);
  }

  blocks.push(
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*🎮 Quick Tips:*\n• Everyone starts with $1000\n• Bet range: $1-$100\n• Probability: 0-100 (e.g., 75 = 75%)\n• Bigger bets = more market influence\n• Markets resolve manually by admin"
      }
    },
    {
      type: "divider"
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "💡 *Pro tip:* Use quick bet buttons on markets for instant betting!"
        }
      ]
    }
  );

  return {
    response_type: 'ephemeral',
    blocks: blocks
  };
}

// Parse market creation from natural language
function parseMarketCreation(text) {
  let cleanText = text.replace(/^create\s+/i, '');
  
  if (cleanText.includes('|')) {
    const [question, dateStr] = cleanText.split('|').map(s => s.trim());
    return { question, deadline: dateStr };
  } else if (cleanText.includes(' - ') && cleanText.includes('% chance')) {
    const question = cleanText.split(' - ')[0].trim();
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 7);
    return { question, deadline: deadline.toISOString().split('T')[0] };
  }
  
  return null;
}

// Parse betting from natural language
function parseBetting(text) {
  const parts = text.split(' ');
  if (parts.length < 3) return null;
  
  let marketId, probability, stake;
  
  if (parts[0] === 'bet') {
    [, marketId, probability, stake] = parts;
  } else {
    [marketId, probability, stake] = parts;
  }
  
  if (typeof probability === 'string') {
    probability = probability.replace('%', '');
    if (probability === 'likely') probability = '75';
    if (probability === 'unlikely') probability = '25';
    if (probability === 'certain') probability = '95';
    if (probability === 'impossible') probability = '5';
  }
  
  const prob = parseFloat(probability);
  const amount = parseInt(stake?.replace('$', '') || stake);
  
  if (isNaN(prob) || isNaN(amount)) return null;
  
  return {
    marketId,
    probability: prob > 1 ? prob / 100 : prob,
    stake: amount
  };
}

// Main /predict command with subcommands
app.command('/predict', async ({ command, ack, respond }) => {
  await ack();
  
  const text = command.text.trim().toLowerCase();
  const isAdmin = command.user_id === ADMIN_USER_ID;
  
  // Help menu
  if (!text || text === 'help') {
    await respond(getHelpMenu(isAdmin));
    return;
  }
  
  // Resolve market (admin only) - CHECK FIRST!
  if (text.startsWith('resolve ')) {
    if (!isAdmin) {
      await respond({
        response_type: 'ephemeral',
        text: '❌ Only admins can resolve markets'
      });
      return;
    }
    
    const args = text.replace('resolve ', '').split(' ');
    if (args.length < 2) {
      await respond({
        response_type: 'ephemeral',
        text: '❌ Usage: `/predict resolve market_id yes|no`'
      });
      return;
    }
    
    const [marketId, outcomeStr] = args;
    const outcome = outcomeStr.toLowerCase() === 'yes';
    
    try {
      const market = await getMarket(marketId);
      if (!market) {
        await respond('❌ Market not found');
        return;
      }
      
      if (market.resolved) {
        await respond('❌ Market already resolved');
        return;
      }
      
      // Get all bets for payout calculation
      const bets = await getMarketBets(marketId);
      
      if (bets.length === 0) {
        await respond('❌ No bets placed on this market');
        return;
      }
      
      // Calculate payouts
      const payoutPromises = bets.map(async (bet) => {
        const user = await getUser(bet.user_id);
        const accuracy = outcome ? parseFloat(bet.probability) : (1 - parseFloat(bet.probability));
        const payout = Math.floor(bet.stake * (1 + accuracy));
        
        // Update user stats
        const wasCorrect = (outcome && parseFloat(bet.probability) > 0.5) || (!outcome && parseFloat(bet.probability) < 0.5);
        const newBetsWon = user.bets_won + (wasCorrect ? 1 : 0);
        const newBetsPlaced = user.bets_placed + 1;
        const newAccuracy = newBetsWon / newBetsPlaced;
        
        await updateUser(bet.user_id, {
          bankroll: user.bankroll + payout,
          total_staked: user.total_staked - bet.stake,
          bets_placed: newBetsPlaced,
          bets_won: newBetsWon,
          accuracy: newAccuracy
        });
        
        return `<@${bet.user_id}>: $${payout} (${(accuracy * 100).toFixed(1)}% accuracy)`;
      });
      
      const payoutSummary = await Promise.all(payoutPromises);
      
      // Resolve market
      await updateMarket(marketId, {
        resolved: true,
        resolution: outcome,
        resolved_at: new Date()
      });
      
      await respond({
        response_type: 'in_channel',
        text: `🏁 *Market Resolved!*\n\n*${market.question}*\n\n✅ **Result: ${outcome ? 'YES' : 'NO'}**\n\n💰 **Payouts:**\n${payoutSummary.join('\n')}`
      });
    } catch (error) {
      await respond(`❌ Error: ${error.message}`);
    }
    return;
  }
  
  // Create market
  if (text.includes('create') || text.includes('|') || text.includes('% chance')) {
    const parsed = parseMarketCreation(command.text);
    
    if (!parsed) {
      await respond({
        response_type: 'ephemeral',
        text: "❌ Invalid format. Try:\n`/predict create Will we ship X? | 2025-06-20`\nor\n`/predict Will we ship X? - 50% chance`"
      });
      return;
    }
    
    const marketId = `market_${Date.now()}`;
    
    try {
      const deadline = new Date(parsed.deadline);
      if (deadline < new Date()) {
        await respond('❌ Deadline must be in the future');
        return;
      }
      
      const marketData = {
        id: marketId,
        question: parsed.question,
        creator: command.user_id,
        deadline: deadline,
        probability: 0.5,
        totalStake: 0,
        active: true
      };
      
      await createMarket(marketData);
      
      await respond({
        response_type: 'in_channel',
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `🎯 *New Market Created!*\n\n*${parsed.question}*\n\n📊 Probability: *50.0%* | 💰 Staked: $0\n⏰ ${deadline.toLocaleDateString()} | 🆔 \`${marketId}\``
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Very Likely (80%)" },
                action_id: `bet_quick_${marketId}_0.8`,
                style: "primary"
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Likely (65%)" },
                action_id: `bet_quick_${marketId}_0.65`
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Unlikely (35%)" },
                action_id: `bet_quick_${marketId}_0.35`
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Very Unlikely (20%)" },
                action_id: `bet_quick_${marketId}_0.2`,
                style: "danger"
              }
            ]
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `💡 Or use: \`/predict bet ${marketId} 75 50\` (75% prob, $50 stake)`
              }
            ]
          }
        ]
      });
      
    } catch (error) {
      await respond(`❌ Error: ${error.message}`);
    }
    return;
  }
  
  // Place bet
  if (text.includes('bet') || text.match(/market_\d+/)) {
    const parsed = parseBetting(command.text);
    
    if (!parsed) {
      await respond({
        response_type: 'ephemeral',
        text: "❌ Invalid format. Try:\n`/predict bet market_123 75 50` (75% probability, $50 stake)"
      });
      return;
    }
    
    try {
      const result = await placeBet(parsed.marketId, command.user_id, parsed.stake, parsed.probability);
      
      await respond({
        response_type: 'ephemeral',
        text: `✅ ${result.message}\n\n📊 Market: *${(result.new_market_probability * 100).toFixed(1)}%*\n💰 Available: $${result.user.bankroll - result.user.total_staked}`
      });
      
    } catch (error) {
      await respond(`❌ ${error.message}`);
    }
    return;
  }
  
  // List markets
  if (text === 'markets' || text === 'list') {
    try {
      const activeMarkets = await getActiveMarkets();
      
      if (activeMarkets.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: '📝 No active markets. Create one with:\n`/predict create Your question? | 2025-06-20`'
        });
        return;
      }
      
      const marketList = activeMarkets.slice(0, 5).map(market => {
        return `🎯 *${market.question}*\n📊 ${(parseFloat(market.probability) * 100).toFixed(1)}% | $${market.total_stake} staked\n🆔 \`${market.id}\``;
      }).join('\n\n');
      
      await respond({
        response_type: 'ephemeral',
        text: `📊 *Active Markets*\n\n${marketList}\n\n💡 Use \`/predict bet market_id probability stake\` to bet`
      });
    } catch (error) {
      await respond(`❌ Error: ${error.message}`);
    }
    return;
  }
  
  // User stats
  if (text === 'stats' || text === 'me') {
    try {
      const user = await getUser(command.user_id);
      
      await respond({
        response_type: 'ephemeral',
        text: `📊 *Your Stats*\n\n💰 Bankroll: $${user.bankroll}\n📈 Staked: $${user.total_staked}\n💵 Available: $${user.bankroll - user.total_staked}\n\n🏆 Bets: ${user.bets_placed} | ✅ Won: ${user.bets_won}\n📊 Accuracy: ${(parseFloat(user.accuracy) * 100).toFixed(1)}%`
      });
    } catch (error) {
      await respond(`❌ Error: ${error.message}`);
    }
    return;
  }
  
  // Market info
  if (text.startsWith('info ')) {
    const marketId = text.replace('info ', '').trim();
    
    try {
      const market = await getMarket(marketId);
      if (!market) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ Market not found'
        });
        return;
      }
      
      const bets = await getMarketBets(marketId);
      const participants = new Set(bets.map(bet => bet.user_id)).size;
      const user_bet = bets.find(bet => bet.user_id === command.user_id);
      
      let betDetails = '';
      if (user_bet) {
        betDetails = `\n🎯 Your bet: $${user_bet.stake} on ${(parseFloat(user_bet.probability) * 100).toFixed(1)}%`;
      }
      
      await respond({
        response_type: 'ephemeral',
        text: `📊 *Market Details*\n\n*${market.question}*\n\n📈 Probability: *${(parseFloat(market.probability) * 100).toFixed(1)}%*\n💰 Total staked: $${market.total_stake}\n👥 Participants: ${participants}\n⏰ Deadline: ${new Date(market.deadline).toLocaleDateString()}${betDetails}`
      });
    } catch (error) {
      await respond(`❌ Error: ${error.message}`);
    }
    return;
  }
  
  // Default: show help if command not recognized
  await respond({
    response_type: 'ephemeral',
    text: `❌ Unknown command. Try \`/predict help\` for available options.`
  });
});

// Quick bet buttons
app.action(/^bet_quick_/, async ({ action, ack, respond, body }) => {
  await ack();
  
  console.log('=== BUTTON DEBUG ===');
  console.log('Full action_id:', action.action_id);
  console.log('Action split:', action.action_id.split('_'));
  
  const parts = action.action_id.split('_');
  const marketId = parts.slice(2, -1).join('_');
  const probability = parts[parts.length - 1];
  
  console.log('Extracted market ID:', marketId);
  console.log('Extracted probability:', probability);
  
  const userId = body.user.id;
  const default_amount = 25; // $25 quick bet
  
  try {
    const market = await getMarket(marketId);
    if (!market || !market.active) {
      await respond({
        response_type: 'ephemeral',
        text: '❌ Market not found or inactive'
      });
      return;
    }
    
    if (new Date() > new Date(market.deadline)) {
      await respond({
        response_type: 'ephemeral',
        text: '❌ Market has expired'
      });
      return;
    }
    
    const result = await placeBet(marketId, userId, default_amount, parseFloat(probability));
    
    await respond({
      response_type: 'ephemeral',
      text: `✅ Quick bet: $${result.stake_placed} on ${(parseFloat(probability) * 100).toFixed(0)}%\n\n📊 Market: *${(result.new_market_probability * 100).toFixed(1)}%*`
    });
    
  } catch (error) {
    await respond({
      response_type: 'ephemeral',
      text: `❌ ${error.message}`
    });
  }
});

// Start the app
(async () => {
  try {
    await initializeDatabase();
    await app.start();
    console.log('⚡️ Prediction Market Bot with Admin-Only Resolve is running!');
    console.log(`🔑 Admin User ID: ${ADMIN_USER_ID}`);
  } catch (error) {
    console.error('Failed to start app:', error);
  }
})();