const axios = require('axios');

const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

async function generateImage({ imageStyle, type }) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY غير متوفر');
  const brandContext = `صورة تسويقية هادئة لمنصة تعليمية اسمها AZ Alpha Vision.
الهوية: كحلي مؤسسي، لمسات برونزية وزمردية خافتة، بلا نيون.
النمط: ${imageStyle}
النبرة: ${type === 'فكاهي' ? 'خفيفة دون مبالغة' : 'إدارية مالية هادئة'}.
لا تضع نصوصاً طويلة. مربع أو أفقي يناسب X.`;

  const response = await axios.post(
    `${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: brandContext }] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
  );

  const parts = response.data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart) throw new Error('Gemini لم يرجع صورة صالحة');
  return Buffer.from(imagePart.inlineData.data, 'base64');
}

module.exports = { generateImage };
