const { TwitterApi } = require('twitter-api-v2');

function getClient() {
  return new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
  });
}

/**
 * ينشر تغريدة مع صورة (اختياري)
 */
async function postTweet({ text, imageBuffer }) {
  const client = getClient();
  const rwClient = client.readWrite;

  let mediaId = null;
  if (imageBuffer) {
    mediaId = await rwClient.v1.uploadMedia(imageBuffer, { mimeType: 'image/png' });
  }

  const tweet = await rwClient.v2.tweet({
    text,
    ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
  });

  return tweet;
}

/**
 * ينشر سلسلة (Thread) من التغريدات المتتابعة؛ كل تغريدة ترد على التي قبلها.
 * يعيد مصفوفة بمعرفات كل تغريدة، ومعرف أول تغريدة كمرجع رئيسي للسجل.
 */
async function postThread({ parts, imageBuffer }) {
  const client = getClient();
  const rwClient = client.readWrite;
  let mediaId = null;
  if (imageBuffer) {
    mediaId = await rwClient.v1.uploadMedia(imageBuffer, { mimeType: 'image/png' });
  }
  const ids = [];
  let previousId = null;
  for (let i = 0; i < parts.length; i += 1) {
    const payload = {
      text: parts[i],
      ...(i === 0 && mediaId ? { media: { media_ids: [mediaId] } } : {}),
      ...(previousId ? { reply: { in_reply_to_tweet_id: previousId } } : {}),
    };
    const tweet = await rwClient.v2.tweet(payload);
    previousId = tweet.data.id;
    ids.push(tweet.data.id);
  }
  return { data: { id: ids[0] }, threadIds: ids };
}

module.exports = { postTweet, postThread };
