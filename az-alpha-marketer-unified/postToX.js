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

module.exports = { postTweet };
