require('dotenv').config();
const { App } = require('@slack/bolt');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// In-memory storage (we'll add database later)
const markets = new Map();
const users = new Map();

// Initialize user with starting bankroll
function initializeUser(userId) {
  if (!users.has(userId)) {
    users.set(userId, {
      id: userId,
      bankroll: 1000,
      totalStaked: 0,
      betsPlaced: 0,
      betsWon: 0,
      accuracy: 0.5
    });
  }
  return users.get(userId);
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
function placeBet(market_id, user_id, desired_amount, probability) {
    // Validation
    if (probability < 0 || probability > 1) {
        throw new Error("Probability must be between 0 and 1");
    }
    
    const market = markets.get(market_id);
    if (!market || !market.active) {
        throw new Error("Market not found or inactive");
    }
    
    if (new Date() > market.deadline) {
        throw new Error("Market has expired");
    }
    
    // Calculate actual stake
    const stake = calculateStake(desired_amount);
    
    // Check user bankroll
    const user = initializeUser(user_id);
    const old_bet = market.bets.find(bet => bet.userId === user_id);
    const available_bankroll = user.bankroll - user.totalStaked + (old_bet ? old_bet.stake : 0);
    
    if (stake > available_bankroll) {
        throw new Error(`Insufficient bankroll. Available: $${available_bankroll}`);
    }
    
    // Get current state for probability calculation
    const current_stakes = market.bets.map(bet => bet.stake);
    const current_probs = market.bets.map(bet => bet.probability);
    
    // Update market probability
    const new_prob = updateMarketProbability(
        current_stakes, 
        current_probs, 
        stake, 
        probability,
        old_bet?.stake || 0,
        old_bet?.probability || 0
    );
    
    // Update market data
    const old_stake = old_bet ? old_bet.stake : 0;
    const existingBetIndex = market.bets.findIndex(bet => bet.userId === user_id);
    
    if (existingBetIndex >= 0) {
        // Update existing bet
        market.bets[existingBetIndex] = { 
            userId: user_id, 
            stake: stake, 
            probability: probability, 
            timestamp: new Date() 
        };
    } else {
        // New bet
        market.bets.push({ 
            userId: user_id, 
            stake: stake, 
            probability: probability, 
            timestamp: new Date() 
        });
    }
    
    // Update totals
    market.totalStake = market.totalStake - old_stake + stake;
    market.probability = new_prob;
    
    // Update user bankroll
    const net_stake_change = stake - old_stake;
    user.totalStaked += net_stake_change;
    
    return {
        stake_placed: stake,
        new_market_probability: new_prob,
        was_capped: stake < desired_amount,
        message: stake < desired_amount ? `Bet capped at $${stake} (max: $100)` : `Bet placed: $${stake}`,
        user: user,
        market: market
    };
}

// Show help menu
function getHelpMenu() {
  return {
    response_type: 'ephemeral',
    blocks: [
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
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*🎮 Quick Tips:*\n• Everyone starts with $1000\n• Bet range: $1-$100\n• Probability: 0-100 (e.g., 75 = 75%)\n• Bigger bets = more market influence\n• Markets auto-resolve on deadline"
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
    ]
  };
}

// Parse market creation from natural language
function parseMarketCreation(text) {
  // Handle various formats:
  // "Will we ship X by Friday? | 2025-06-20"
  // "create Will we ship X by Friday? | 2025-06-20"
  // "Will we ship X by Friday - 50% chance"
  
  let cleanText = text.replace(/^create\s+/i, ''); // Remove "create" if present
  
  if (cleanText.includes('|')) {
    // Standard format: Question | Date
    const [question, dateStr] = cleanText.split('|').map(s => s.trim());
    return { question, deadline: dateStr };
  } else if (cleanText.includes(' - ') && cleanText.includes('% chance')) {
    // Format: Question - XX% chance
    const question = cleanText.split(' - ')[0].trim();
    // Default to 7 days from now
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 7);
    return { question, deadline: deadline.toISOString().split('T')[0] };
  }
  
  return null;
}

// Parse betting from natural language
function parseBetting(text) {
  // Handle various formats:
  // "bet market_123 75 50" (probability, stake)
  // "market_123 75% $50"
  // "market_123 likely 25"
  
  const parts = text.split(' ');
  if (parts.length < 3) return null;
  
  let marketId, probability, stake;
  
  if (parts[0] === 'bet') {
    // Standard format: bet market_id probability stake
    [, marketId, probability, stake] = parts;
  } else {
    // Short format: market_id probability stake
    [marketId, probability, stake] = parts;
  }
  
  // Convert probability
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
    probability: prob > 1 ? prob / 100 : prob, // Convert percentage to decimal
    stake: amount
  };
}

// Main /predict command with subcommands
app.command('/predict', async ({ command, ack, respond }) => {
  await ack();
  
  const text = command.text.trim().toLowerCase();
  
  // Help menu
  if (!text || text === 'help') {
    await respond(getHelpMenu());
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
      
      const market = {
        id: marketId,
        question: parsed.question,
        creator: command.user_id,
        created: new Date(),
        deadline: deadline,
        resolved: false,
        probability: 0.5,
        totalStake: 0,
        bets: [],
        active: true
      };
      
      markets.set(marketId, market);
      
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
      const result = placeBet(parsed.marketId, command.user_id, parsed.stake, parsed.probability);
      
      await respond({
        response_type: 'ephemeral',
        text: `✅ ${result.message}\n\n📊 Market: *${(result.new_market_probability * 100).toFixed(1)}%*\n💰 Available: $${result.user.bankroll - result.user.totalStaked}`
      });
      
    } catch (error) {
      await respond(`❌ ${error.message}`);
    }
    return;
  }
  
  // List markets
  if (text === 'markets' || text === 'list') {
    const activeMarkets = Array.from(markets.values())
      .filter(m => m.active && !m.resolved)
      .sort((a, b) => b.created - a.created);
    
    if (activeMarkets.length === 0) {
      await respond({
        response_type: 'ephemeral',
        text: '📝 No active markets. Create one with:\n`/predict create Your question? | 2025-06-20`'
      });
      return;
    }
    
    const marketList = activeMarkets.slice(0, 5).map(market => {
      const participants = new Set(market.bets.map(bet => bet.userId)).size;
      return `🎯 *${market.question}*\n📊 ${(market.probability * 100).toFixed(1)}% | $${market.totalStake} | ${participants} participants\n🆔 \`${market.id}\``;
    }).join('\n\n');
    
    await respond({
      response_type: 'ephemeral',
      text: `📊 *Active Markets*\n\n${marketList}\n\n💡 Use \`/predict bet market_id probability stake\` to bet`
    });
    return;
  }
  
  // User stats
  if (text === 'stats' || text === 'me') {
    const user = users.get(command.user_id);
    if (!user) {
      await respond({
        response_type: 'ephemeral',
        text: '📊 No betting history. Place your first bet to get started!'
      });
      return;
    }
    
    await respond({
      response_type: 'ephemeral',
      text: `📊 *Your Stats*\n\n💰 Bankroll: $${user.bankroll}\n📈 Staked: $${user.totalStaked}\n💵 Available: $${user.bankroll - user.totalStaked}\n\n🏆 Bets: ${user.betsPlaced} | ✅ Won: ${user.betsWon}\n📊 Accuracy: ${(user.accuracy * 100).toFixed(1)}%`
    });
    return;
  }
  
  // Market info
  if (text.startsWith('info ')) {
    const marketId = text.replace('info ', '').trim();
    const market = markets.get(marketId);
    
    if (!market) {
      await respond({
        response_type: 'ephemeral',
        text: '❌ Market not found'
      });
      return;
    }
    
    const participants = new Set(market.bets.map(bet => bet.userId)).size;
    const user_bet = market.bets.find(bet => bet.userId === command.user_id);
    
    let betDetails = '';
    if (user_bet) {
      betDetails = `\n🎯 Your bet: ${user_bet.stake} on ${(user_bet.probability * 100).toFixed(1)}%`;
    }
    
    await respond({
      response_type: 'ephemeral',
      text: `📊 *Market Details*\n\n*${market.question}*\n\n📈 Probability: *${(market.probability * 100).toFixed(1)}%*\n💰 Total staked: ${market.totalStake}\n👥 Participants: ${participants}\n⏰ Deadline: ${market.deadline.toLocaleDateString()}${betDetails}`
    });
    return;
  }
  
  // Resolve market (admin command)
  if (text.startsWith('resolve ')) {
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
    
    const market = markets.get(marketId);
    if (!market) {
      await respond('❌ Market not found');
      return;
    }
    
    if (market.resolved) {
      await respond('❌ Market already resolved');
      return;
    }
    
    // Resolve market
    market.resolved = true;
    market.resolution = outcome;
    market.resolvedAt = new Date();
    
    // Calculate payouts
    let payoutSummary = [];
    market.bets.forEach(bet => {
      const user = users.get(bet.userId);
      const accuracy = outcome ? bet.probability : (1 - bet.probability);
      const payout = Math.floor(bet.stake * (1 + accuracy));
      
      user.bankroll += payout;
      user.totalStaked -= bet.stake;
      user.betsPlaced++;
      
      const wasCorrect = (outcome && bet.probability > 0.5) || (!outcome && bet.probability < 0.5);
      if (wasCorrect) user.betsWon++;
      user.accuracy = user.betsWon / user.betsPlaced;
      
      payoutSummary.push(`<@${bet.userId}>: ${payout} (${(accuracy * 100).toFixed(1)}% accuracy)`);
    });
    
    await respond({
      response_type: 'in_channel',
      text: `🏁 *Market Resolved!*\n\n*${market.question}*\n\n✅ **Result: ${outcome ? 'YES' : 'NO'}**\n\n💰 **Payouts:**\n${payoutSummary.join('\n')}`
    });
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
  const marketId = parts.slice(2, -1).join('_'); // Handle market IDs with underscores
  const probability = parts[parts.length - 1];
  
  console.log('Extracted market ID:', marketId);
  console.log('Extracted probability:', probability);
  console.log('Available markets:', Array.from(markets.keys()));
  console.log('Market exists?', markets.has(marketId));
  
  const userId = body.user.id;
  const default_amount = 25; // $25 quick bet
  
  const market = markets.get(marketId);
  if (!market || !market.active) {
    await respond({
      response_type: 'ephemeral',
      text: `❌ Debug: Looking for '${marketId}', available: ${Array.from(markets.keys()).join(', ')}`
    });
    return;
  }
  
  if (new Date() > market.deadline) {
    await respond({
      response_type: 'ephemeral',
      text: '❌ Market has expired'
    });
    return;
  }
  
  try {
    const result = placeBet(marketId, userId, default_amount, parseFloat(probability));
    
    await respond({
      response_type: 'ephemeral',
      text: `✅ Quick bet: ${result.stake_placed} on ${(parseFloat(probability) * 100).toFixed(0)}%\n\n📊 Market: *${(result.new_market_probability * 100).toFixed(1)}%*`
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
  await app.start();
  console.log('⚡️ Prediction Market Bot (/predict) is running!');
})();