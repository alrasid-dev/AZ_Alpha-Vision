function getClient(db) {
  return db || null;
}

async function getRecentTweets(db, limit = 8) {
  const client = getClient(db);
  if (!client) return [];
  const { data, error } = await client
    .from('marketing_posts')
    .select('tweet_text')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('تعذر جلب السجل:', error.message);
    return [];
  }
  return (data || []).map((row) => row.tweet_text).filter(Boolean);
}

module.exports = { getRecentTweets };
