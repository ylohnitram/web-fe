import { supabase } from "./supabase-client";
import { fetchTimeframeCandles, fetchCandlestickData, type CandleData } from "./binance-api";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateLiquidityLevels } from "./liquidity-levels";
import { v4 as uuidv4 } from "uuid";

// Timeframe types we'll process
const TIMEFRAMES = ["5m", "15m", "30m", "1h"];

// Historical data for seasonality - imported from seasonality-data.ts
import { historicalMonthlyReturns } from "./seasonality-data";

// Interface for generated signal
export interface GeneratedSignal {
  signal_id: string;
  signal_type: "long" | "short";
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  pair: string;
  timeframe: string;
  signal_source: string;
  major_level?: number;
  peak_price?: number;
  peak_time?: Date;
  fib_levels?: any[];
  risk_reward_ratio: number;
  seasonality: "bullish" | "bearish" | "neutral";
  positive_probability: number;
}

// Function to get current seasonality
function getCurrentSeasonality(): { seasonality: "bullish" | "bearish" | "neutral"; probability: number } {
  const currentMonth = new Date().getMonth();
  const monthData = historicalMonthlyReturns[currentMonth as keyof typeof historicalMonthlyReturns];

  if (monthData) {
    const returns = Object.values(monthData);
    const positiveCount = returns.filter((ret) => ret > 0).length;
    const probability = (positiveCount / returns.length) * 100;

    // Determine seasonality based on probability of positive returns
    if (probability >= 60) {
      return { seasonality: "bullish", probability };
    } else if (probability <= 40) {
      return { seasonality: "bearish", probability };
    }
  }

  return { seasonality: "neutral", probability: 50 };
}

// Function to analyze liquidity levels
function analyzeLiquidityLevels(candles: CandleData[]) {
  try {
    return calculateLiquidityLevels(candles, {
      swingStrength: 5,
      majorThreshold: 0.3,
      reqThreshold: 2.0,
    });
  } catch (error) {
    console.error("Error analyzing liquidity levels:", error);
    return { bsl: [], ssl: [] };
  }
}

// Function to generate signals - FIXED LOGIC
function generateSignals(pair: string, timeframe: string, candles: CandleData[], liquidityLevels: any): GeneratedSignal[] {
  const signals: GeneratedSignal[] = [];
  
  try {
    // Get current seasonality
    const { seasonality, probability } = getCurrentSeasonality();
    
    // Find all major levels
    const majorBSL = liquidityLevels.bsl.filter((level: any) => level.isMajor);
    const majorSSL = liquidityLevels.ssl.filter((level: any) => level.isMajor);
    
    // Current price (use close of last candle)
    const currentPrice = candles[candles.length - 1].close;
    
    // Determine signal type based on seasonality
    const signalType = seasonality === "bearish" ? "short" : "long";
    
    // Find appropriate major level based on signal type
    let relevantLevel = null;

    if (signalType === "long") {
      // For LONG signals, find lowest major SSL level BELOW current price
      const sslBelowPrice = majorSSL.filter((ssl: any) => ssl.price < currentPrice);
      const sortedSSL = [...sslBelowPrice].sort((a, b) => b.price - a.price); // Sort descending to get closest below
      relevantLevel = sortedSSL.length > 0 ? sortedSSL[0] : null;

      // If no valid SSL level found, try using BSL level in neutral seasonality
      if (!relevantLevel && seasonality === "neutral" && majorBSL.length > 0) {
        const bslBelowPrice = majorBSL.filter((bsl: any) => bsl.price < currentPrice);
        relevantLevel = bslBelowPrice.sort((a, b) => b.price - a.price)[0]; // Get highest BSL below price
      }
    } else {
      // For SHORT signals, find highest major BSL level ABOVE current price
      const bslAbovePrice = majorBSL.filter((bsl: any) => bsl.price > currentPrice);
      const sortedBSL = [...bslAbovePrice].sort((a, b) => a.price - b.price); // Sort ascending to get closest above
      relevantLevel = sortedBSL.length > 0 ? sortedBSL[0] : null;

      // If no valid BSL level found, try using SSL level in neutral seasonality
      if (!relevantLevel && seasonality === "neutral" && majorSSL.length > 0) {
        const sslAbovePrice = majorSSL.filter((ssl: any) => ssl.price > currentPrice);
        relevantLevel = sslAbovePrice.sort((a, b) => a.price - b.price)[0]; // Get lowest SSL above price
      }
    }
    
    // If no relevant level found, return empty array
    if (!relevantLevel) {
      return signals;
    }
    
    // Get all candles after the major level formation
    const candlesAfterLevel = candles.filter((candle) => candle.time > relevantLevel.time);
    
    if (candlesAfterLevel.length < 5) {
      return signals;
    }
    
    // Create base signal
    const signalId = uuidv4();
    
    // Create proper entry, stop loss, and take profit levels
    let entryPrice, stopLoss, takeProfit;
    const riskRewardRatio = 3.0; // Risk:Reward ratio
    
    if (signalType === "long") {
      // For LONG positions
      // Entry slightly below current price
      entryPrice = currentPrice * 0.985;
      
      // Stop loss must be BELOW the entry price
      // Use the major level as a reference, but ensure SL is below entry
      stopLoss = Math.min(entryPrice * 0.99, relevantLevel.price * 0.99);
      
      // Take profit must be ABOVE the entry price
      const riskAmount = entryPrice - stopLoss;
      takeProfit = entryPrice + (riskAmount * riskRewardRatio);
    } else {
      // For SHORT positions
      // Entry slightly above current price
      entryPrice = currentPrice * 1.015;
      
      // Stop loss must be ABOVE the entry price
      // Use the major level as a reference, but ensure SL is above entry
      stopLoss = Math.max(entryPrice * 1.01, relevantLevel.price * 1.01);
      
      // Take profit must be BELOW the entry price
      const riskAmount = stopLoss - entryPrice;
      takeProfit = entryPrice - (riskAmount * riskRewardRatio);
    }
    
    // Gather all Fibonacci levels for reference - Always ensure this is an array
    const priceDiff = Math.abs(relevantLevel.price - currentPrice);
    const fibLevels = [0, 23.6, 38.2, 50, 61.8, 78.6, 100].map(level => {
      const price = signalType === "long" 
        ? relevantLevel.price + (priceDiff * level / 100)
        : relevantLevel.price - (priceDiff * level / 100);
      return { level, price };
    });
    
    // Final validation of price levels
    if (signalType === "long") {
      // For long positions, ensure TP > Entry > SL
      if (!(takeProfit > entryPrice && entryPrice > stopLoss)) {
        console.warn(`Invalid long signal prices: Entry=${entryPrice}, SL=${stopLoss}, TP=${takeProfit}`);
        return signals;
      }
    } else {
      // For short positions, ensure TP < Entry < SL
      if (!(takeProfit < entryPrice && entryPrice < stopLoss)) {
        console.warn(`Invalid short signal prices: Entry=${entryPrice}, SL=${stopLoss}, TP=${takeProfit}`);
        return signals;
      }
    }
    
    // Add signal to results
    signals.push({
      signal_id: signalId,
      signal_type: signalType,
      entry_price: entryPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      pair,
      timeframe,
      signal_source: "fibonacci",
      major_level: relevantLevel.price,
      peak_price: currentPrice,
      peak_time: new Date(),
      fib_levels: fibLevels, // Always an array
      risk_reward_ratio: riskRewardRatio,
      seasonality,
      positive_probability: probability
    });
    
    return signals;
  } catch (error) {
    console.error("Error generating signals:", error);
    return [];
  }
}

export async function generateSignalsForTimeframe(
  timeframe: string, 
  symbol?: string,
  client?: SupabaseClient
): Promise<any[]> {
  console.log(`Generating signals for timeframe: ${timeframe}${symbol ? `, symbol: ${symbol}` : ''}`);

  // Use provided client or default supabase client
  const supabaseClient = client || supabase;

  // Check if Supabase client is valid
  if (!supabaseClient) {
    console.error("Supabase client is not available - check environment variables (SUPABASE_URL and SUPABASE_ANON_KEY)");
    throw new Error("Supabase client is not available");
  }

  // List of pairs to generate signals for
  let pairs = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"];
  
  // If a specific symbol was requested, filter to only that one
  if (symbol) {
    const normalizedSymbol = symbol.toUpperCase();
    const symbolWithUsdt = normalizedSymbol.endsWith('USDT') ? normalizedSymbol : `${normalizedSymbol}USDT`;
    pairs = [symbolWithUsdt]; // Use only the requested symbol
  }

  const results = [];

  for (const pair of pairs) {
    try {
      console.log(`Processing pair: ${pair} with timeframe: ${timeframe}`);

      // Get candlestick data from Binance API
      let candlestickData;
      try {
        console.log(`Fetching candlestick data for ${pair} with limit 100...`);
        candlestickData = await fetchCandlestickData(pair, timeframe, 100);
        
        console.log(`Received candlestick data for ${pair}: count=${candlestickData?.length || 0}`);
        
        // If still no data after retries and fallbacks, try with a smaller dataset
        if (!candlestickData || !Array.isArray(candlestickData) || candlestickData.length === 0) {
          console.log(`Trying with a smaller dataset (limit=20) for ${pair}...`);
          candlestickData = await fetchTimeframeCandles(pair, timeframe, 20);
          console.log(`Second attempt result: received ${candlestickData?.length || 0} candles`);
        }
        
        // Final check if we have valid data
        if (!candlestickData || !Array.isArray(candlestickData) || candlestickData.length === 0) {
          throw new Error("Invalid or empty candlestick data received after all fallback attempts");
        }
      } catch (fetchError) {
        console.error(`Error fetching candlestick data for ${pair}:`, fetchError);
        results.push({
          pair,
          error: fetchError instanceof Error ? fetchError.message : "Error fetching candlestick data"
        });
        continue; // Skip to next pair
      }

      // Analyze liquidity levels
      let liquidityLevels;
      try {
        liquidityLevels = analyzeLiquidityLevels(candlestickData);
        console.log(`Analyzed liquidity levels for ${pair}: bsl=${liquidityLevels.bsl.length}, ssl=${liquidityLevels.ssl.length}`);
      } catch (analysisError) {
        console.error(`Error analyzing liquidity levels for ${pair}:`, analysisError);
        results.push({
          pair,
          error: analysisError instanceof Error ? analysisError.message : "Error analyzing liquidity levels"
        });
        continue; // Skip to next pair
      }

      // Generate signals based on liquidity levels
      let signals;
      try {
        signals = generateSignals(pair, timeframe, candlestickData, liquidityLevels);
        console.log(`Generated ${signals.length} signals for ${pair}`);
      } catch (signalError) {
        console.error(`Error generating signals for ${pair}:`, signalError);
        results.push({
          pair,
          error: signalError instanceof Error ? signalError.message : "Error generating signals"
        });
        continue; // Skip to next pair
      }

      // Save signals to database
      for (const signal of signals) {
        try {
          // Fix: Always ensure fib_levels is an array before stringifying
          const fibLevels = Array.isArray(signal.fib_levels) ? signal.fib_levels : [];
          
          // Convert any Date objects to ISO strings for database compatibility
          const signalForDb = {
            ...signal,
            peak_time: signal.peak_time ? signal.peak_time.toISOString() : new Date().toISOString(),
            fib_levels: JSON.stringify(fibLevels), // Make sure we're storing a stringified array
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            // Změna zde - nové signály mají status "waiting" místo "active", protože čekají na entry hit
            status: 'waiting',
            entry_hit: false,
          };
          
          console.log(`Inserting signal into database:`, {
            signal_id: signalForDb.signal_id,
            pair: signalForDb.pair,
            timeframe: signalForDb.timeframe,
            signal_type: signalForDb.signal_type
          });

          // First check if signal with this ID already exists
          const { data: existingSignal, error: checkError } = await supabaseClient
            .from("generated_signals")
            .select("signal_id")
            .eq("signal_id", signalForDb.signal_id)
            .maybeSingle();

          if (checkError) {
            console.error(`Error checking for existing signal: ${checkError.message}`);
            throw checkError;
          }

          let result;
          if (existingSignal) {
            // Update existing signal
            console.log(`Signal ${signalForDb.signal_id} already exists, updating...`);
            result = await supabaseClient
              .from("generated_signals")
              .update(signalForDb)
              .eq("signal_id", signalForDb.signal_id);
          } else {
            // Insert new signal
            result = await supabaseClient
              .from("generated_signals")
              .insert(signalForDb);
          }

          if (result.error) {
            console.error(`Database error saving signal for ${pair}:`, result.error);
            throw result.error;
          } else {
            console.log(`Signal successfully saved to database: ${signal.signal_id}`);
          }
        } catch (saveError) {
          console.error(`Error saving signal to database for ${pair}:`, saveError);
        }
      }

      // Update cache for quick access
      try {
        await updateSignalCacheForTimeframe(pair, timeframe, signals, supabaseClient);
      } catch (cacheError) {
        console.error(`Error updating cache for ${pair}:`, cacheError);
      }

      results.push({
        pair,
        signalsGenerated: signals.length,
      });
    } catch (error) {
      console.error(`Error processing ${pair}:`, error);
      results.push({
        pair,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // Clean up old cache entries
  try {
    await cleanupOldCacheEntriesForTimeframe(timeframe, supabaseClient);
  } catch (cleanupError) {
    console.error(`Error cleaning up cache entries:`, cleanupError);
  }

  return results;
}

async function updateSignalCacheForTimeframe(
  pair: string,
  timeframe: string,
  signals: GeneratedSignal[],
  supabaseClient: SupabaseClient,
) {
  try {
    if (!supabaseClient) {
      console.error("Supabase client is not available for cache update");
      return;
    }

    // Prepare signal IDs array
    const signalIds = signals.map(signal => signal.signal_id);
    
    if (signalIds.length === 0) {
      console.log(`No signals to store in cache for ${pair} ${timeframe}`);
      return;
    }

    // Check if cache_key already exists first
    const { data: existingCache, error: checkError } = await supabaseClient
      .from("signal_cache")
      .select("id")
      .eq("cache_key", `${pair}_${timeframe}`)
      .maybeSingle();

    if (checkError) {
      console.error(`Error checking existing cache: ${checkError.message}`);
      return;
    }

    // Insert or update based on whether the cache entry already exists
    let result;
    if (existingCache) {
      // Update existing cache entry
      result = await supabaseClient
        .from("signal_cache")
        .update({
          signal_ids: JSON.stringify(signalIds),
          last_updated: new Date().toISOString()
        })
        .eq("id", existingCache.id);
    } else {
      // Insert new cache entry
      result = await supabaseClient
        .from("signal_cache")
        .insert({
          cache_key: `${pair}_${timeframe}`,
          signal_ids: JSON.stringify(signalIds),
          pair,
          timeframe,
          last_updated: new Date().toISOString()
        });
    }

    if (result.error) {
      console.error(`Error updating cache for ${pair} ${timeframe}:`, result.error);
    } else {
      console.log(`Cache successfully updated for ${pair} ${timeframe}: ${signalIds.length} signals`);
    }
  } catch (error) {
    console.error(`Error in updateSignalCacheForTimeframe:`, error);
  }
}

async function cleanupOldCacheEntriesForTimeframe(timeframe: string, supabaseClient: SupabaseClient) {
  try {
    if (!supabaseClient) {
      console.error("Supabase client is not available for cache cleanup");
      return;
    }

    // First, check if the timeframe column exists
    const { error: checkError } = await supabaseClient
      .from("signal_cache")
      .select("count(*)")
      .limit(1);

    if (checkError) {
      console.error(`Error checking signal_cache table: ${checkError.message}`);
      return;
    }

    // Set time limit for old records (24 hours)
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - 24);

    // We won't filter by timeframe if we're unsure about the column
    // Instead, just delete entries older than the cutoff time
    const { error } = await supabaseClient
      .from("signal_cache")
      .delete()
      .lt("last_updated", cutoffTime.toISOString());

    if (error) {
      console.error(`Error cleaning up old cache entries:`, error);
    } else {
      console.log(`Old cache entries cleaned up`);
    }
  } catch (error) {
    console.error(`Error in cleanupOldCacheEntriesForTimeframe:`, error);
  }
}

// Function to check and update signal statuses
export async function checkAndUpdateSignalStatuses(
  timeframe?: string,
  pair?: string
): Promise<{
  checked: number;
  updated: number;
  completed: number;
  expired: number;
  errors: number;
}> {
  try {
    console.log(`Checking and updating signal statuses${timeframe ? ` for ${timeframe} timeframe` : ""}${pair ? ` and ${pair} pair` : ""}...`);

    if (!supabase) {
      console.error("Supabase client is not available for signal status update");
      throw new Error("Supabase client not available");
    }

    // Get all waiting and active signals (not completed or expired)
    let query = supabase.from("generated_signals").select("*").in("status", ["waiting", "active"]);

    // Apply filters if provided
    if (timeframe) {
      query = query.eq("timeframe", timeframe);
    }
    
    if (pair) {
      query = query.eq("pair", pair);
    }

    const { data: signals, error } = await query;

    if (error) {
      console.error("Error fetching signals:", error);
      throw error;
    }

    console.log(`Found ${signals?.length || 0} signals to check (waiting and active)`);

    // Initialize counters for tracking updates
    const results = {
      checked: signals?.length || 0,
      updated: 0,
      completed: 0,
      expired: 0,
      errors: 0
    };

    // Group signals by pair for more efficient processing
    const signalsByPair: Record<string, any[]> = {};

    signals?.forEach((signal) => {
      if (!signalsByPair[signal.pair]) {
        signalsByPair[signal.pair] = [];
      }
      signalsByPair[signal.pair].push(signal);
    });

    // Process signals for each pair
    for (const [signalPair, pairSignals] of Object.entries(signalsByPair)) {
      try {
        // Get current price for the pair
        const currentPriceData = await fetchTimeframeCandles(signalPair, "1m", 1);

        if (!currentPriceData || currentPriceData.length === 0) {
          console.log(`No current price data available for ${signalPair}, skipping...`);
          continue;
        }

        const currentPrice = currentPriceData[0].close;
        console.log(`Current price for ${signalPair}: ${currentPrice}`);

        // Check each signal for the pair
        for (const signal of pairSignals) {
          try {
            // Fix: Parse fib_levels from JSON to array if it's a string
            if (signal.fib_levels && typeof signal.fib_levels === 'string') {
              try {
                signal.fib_levels = JSON.parse(signal.fib_levels);
                if (!Array.isArray(signal.fib_levels)) {
                  signal.fib_levels = []; // Set to empty array if not an array
                }
              } catch (parseError) {
                console.error(`Error parsing fib_levels for signal ${signal.signal_id}:`, parseError);
                signal.fib_levels = []; // Set to empty array on parse error
              }
            } else if (!Array.isArray(signal.fib_levels)) {
              signal.fib_levels = []; // Set to empty array if not an array
            }
            
            // Check if signal has already been activated (entry hit)
            let entryHit = signal.entry_hit;
            let entryHitTime = signal.entry_hit_time;
            let status = signal.status;
            let isCompleted = false;
            let exitType: string | null = null;
            let exitPrice: number | null = null;
            let exitTime: Date | null = null;
            let wasUpdated = false;

            // First check if entry price has been hit (if not already)
            if (!entryHit) {
              if (signal.signal_type === "long") {
                // For long positions - price must drop to or below entry price
                if (currentPrice <= signal.entry_price) {
                  entryHit = true;
                  entryHitTime = new Date().toISOString();
                  // Status changes from "waiting" to "active" when entry is hit
                  status = "active";
                  wasUpdated = true;
                  console.log(`Entry hit for ${signalPair} ${signal.timeframe} LONG signal at ${currentPrice}`);
                }
              } else {
                // For short positions - price must rise to or above entry price
                if (currentPrice >= signal.entry_price) {
                  entryHit = true;
                  entryHitTime = new Date().toISOString();
                  // Status changes from "waiting" to "active" when entry is hit
                  status = "active";  
                  wasUpdated = true;
                  console.log(`Entry hit for ${signalPair} ${signal.timeframe} SHORT signal at ${currentPrice}`);
                }
              }
            }

            // If signal is active (entry price has been hit), check TP/SL
            if (entryHit) {
              if (signal.signal_type === "long") {
                // For long positions
                if (currentPrice >= signal.take_profit) {
                  isCompleted = true;
                  exitType = "tp";
                  exitPrice = signal.take_profit;
                  exitTime = new Date();
                  status = "completed";
                  wasUpdated = true;
                  console.log(`Take profit hit for ${signalPair} ${signal.timeframe} LONG signal at ${currentPrice}`);
                } else if (currentPrice <= signal.stop_loss) {
                  isCompleted = true;
                  exitType = "sl";
                  exitPrice = signal.stop_loss;
                  exitTime = new Date();
                  status = "completed";
                  wasUpdated = true;
                  console.log(`Stop loss hit for ${signalPair} ${signal.timeframe} LONG signal at ${currentPrice}`);
                }
              } else {
                // For short positions
                if (currentPrice <= signal.take_profit) {
                  isCompleted = true;
                  exitType = "tp";
                  exitPrice = signal.take_profit;
                  exitTime = new Date();
                  status = "completed";
                  wasUpdated = true;
                  console.log(`Take profit hit for ${signalPair} ${signal.timeframe} SHORT signal at ${currentPrice}`);
                } else if (currentPrice >= signal.stop_loss) {
                  isCompleted = true;
                  exitType = "sl";
                  exitPrice = signal.stop_loss;
                  exitTime = new Date();
                  status = "completed";
                  wasUpdated = true;
                  console.log(`Stop loss hit for ${signalPair} ${signal.timeframe} SHORT signal at ${currentPrice}`);
                }
              }
            }

            // Check signal expiration (if older than 7 days and not activated)
            const signalAge = Date.now() - new Date(signal.created_at).getTime();
            const maxSignalAge = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

            if (!entryHit && signalAge > maxSignalAge) {
              isCompleted = true;
              exitType = "expired";
              exitPrice = currentPrice;
              exitTime = new Date();
              status = "expired";
              wasUpdated = true;
              console.log(`Signal expired for ${signalPair} ${signal.timeframe} ${signal.signal_type} signal`);
            }

            // Update signal in database if there was a change
            if (wasUpdated) {
              const updateData: any = {
                entry_hit: entryHit,
                status,
                updated_at: new Date().toISOString()
              };

              if (entryHit && !signal.entry_hit) {
                updateData.entry_hit_time = entryHitTime;
              }

              if (isCompleted) {
                updateData.exit_type = exitType;
                updateData.exit_price = exitPrice;
                updateData.exit_time = exitTime?.toISOString();

                // Calculate P&L
                let profitLoss = 0;

                if (signal.signal_type === "long") {
                  profitLoss = exitPrice! - signal.entry_price;
                } else {
                  profitLoss = signal.entry_price - exitPrice!;
                }

                updateData.profit_loss = profitLoss;
                updateData.profit_loss_percent = (profitLoss / signal.entry_price) * 100;
              }

              console.log(`Updating signal ${signal.signal_id} with data:`, updateData);

              // Update in database
              const { error: updateError } = await supabase
                .from("generated_signals")
                .update(updateData)
                .eq("signal_id", signal.signal_id);

              if (updateError) {
                console.error(`Error updating signal ${signal.signal_id}:`, updateError);
                results.errors++;
              } else {
                console.log(`Signal ${signal.signal_id} updated successfully`);
                results.updated++;
                
                if (isCompleted) {
                  if (exitType === "expired") {
                    results.expired++;
                  } else {
                    results.completed++;
                  }
                }
              }
            }
          } catch (signalError) {
            console.error(`Error processing signal ${signal.signal_id}:`, signalError);
            results.errors++;
          }
        }
      } catch (pairError) {
        console.error(`Error processing signals for ${signalPair}:`, pairError);
        results.errors++;
      }
    }

    console.log("Signal status check completed with results:", results);
    return results;
  } catch (error) {
    console.error("Error checking signal statuses:", error);
    throw error;
  }
}

// Function to get signals from cache
export async function getSignalsFromCache(pair: string, timeframe: string): Promise<any[]> {
  try {
    if (!supabase) {
      console.error("Supabase client is not available for cache retrieval");
      return [];
    }

    // Check if our cache table is accessible
    const { error: checkError } = await supabase
      .from("signal_cache")
      .select("count(*)")
      .limit(1);

    // If there's an error accessing the cache table, get signals directly from generated_signals
    if (checkError) {
      console.log(`Unable to access signal_cache table: ${checkError.message}`);
      console.log(`Fetching signals directly from generated_signals table`);

      const { data: signals, error } = await supabase
        .from("generated_signals")
        .select("*")
        .eq("pair", pair)
        .eq("timeframe", timeframe)
        .in("status", ["waiting", "active"]) // Změna zde - nyní bereme jak čekající, tak aktivní signály
        .order("created_at", { ascending: false })
        .limit(10);

      if (error) {
        console.error(`Error fetching signals for ${pair} on ${timeframe}:`, error);
        return [];
      }

      // Process fib_levels for each signal to ensure it's an array
      return signals?.map(signal => {
        // Parse fib_levels if it's a string
        if (signal.fib_levels && typeof signal.fib_levels === 'string') {
          try {
            signal.fib_levels = JSON.parse(signal.fib_levels);
            if (!Array.isArray(signal.fib_levels)) {
              signal.fib_levels = [];
            }
          } catch (e) {
            signal.fib_levels = [];
          }
        } else if (!Array.isArray(signal.fib_levels)) {
          signal.fib_levels = [];
        }
        return signal;
      }) || [];
    }

    // Try to get signals from cache
    const { data: cacheEntry, error: cacheError } = await supabase
      .from("signal_cache")
      .select("signal_ids")
      .eq("cache_key", `${pair}_${timeframe}`)
      .single();

    if (cacheError || !cacheEntry || !cacheEntry.signal_ids) {
      console.log(`No cache entries found for ${pair}_${timeframe}, fetching from database`);

      // If not in cache, get directly from database
      const { data: signals, error } = await supabase
        .from("generated_signals")
        .select("*")
        .eq("pair", pair)
        .eq("timeframe", timeframe)
        .in("status", ["waiting", "active"]) // Změna zde - nyní bereme jak čekající, tak aktivní signály
        .order("created_at", { ascending: false })
        .limit(10);

      if (error) {
        console.error(`Error fetching signals for ${pair} on ${timeframe}:`, error);
        return [];
      }

      // Process fib_levels for each signal
      return signals?.map(signal => {
        // Parse fib_levels if it's a string
        if (signal.fib_levels && typeof signal.fib_levels === 'string') {
          try {
            signal.fib_levels = JSON.parse(signal.fib_levels);
            if (!Array.isArray(signal.fib_levels)) {
              signal.fib_levels = [];
            }
          } catch (e) {
            signal.fib_levels = [];
          }
        } else if (!Array.isArray(signal.fib_levels)) {
          signal.fib_levels = [];
        }
        return signal;
      }) || [];
    }

    // Get signals by ID from cache
    let signalIds;
    try {
      signalIds = JSON.parse(cacheEntry.signal_ids);

      if (!Array.isArray(signalIds) || signalIds.length === 0) {
        console.log(`Invalid or empty signal_ids in cache for ${pair}_${timeframe}`);
        return [];
      }
    } catch (e) {
      console.error(`Error parsing signal_ids for ${pair}_${timeframe}:`, e);
      return [];
    }

    const { data: signals, error } = await supabase
      .from("generated_signals")
      .select("*")
      .in("signal_id", signalIds)
      .in("status", ["waiting", "active"]) // Změna zde - nyní bereme jak čekající, tak aktivní signály
      .order("created_at", { ascending: false });

    if (error) {
      console.error(`Error fetching signals from cache for ${pair}_${timeframe}:`, error);
      return [];
    }

    // Process fib_levels for each signal
    return signals?.map(signal => {
      // Parse fib_levels if it's a string
      if (signal.fib_levels && typeof signal.fib_levels === 'string') {
        try {
          signal.fib_levels = JSON.parse(signal.fib_levels);
          if (!Array.isArray(signal.fib_levels)) {
            signal.fib_levels = [];
          }
        } catch (e) {
          signal.fib_levels = [];
        }
      } else if (!Array.isArray(signal.fib_levels)) {
        signal.fib_levels = [];
      }
      return signal;
    }) || [];
  } catch (error) {
    console.error("Error getting signals from cache:", error);
    return [];
  }
}
