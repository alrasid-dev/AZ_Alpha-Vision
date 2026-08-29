const axios = require('axios');

const GEMINI_MODEL = 'gemini-2.5-flash-image';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * يولد صورة عبر Gemini بناءً على وصف التصميم المطلوب
 * يرجع Buffer للصورة (PNG) جاهز للرفع على X
 */
async function generateImage({ imageStyle, type }) {
  const brandContext = `صورة تسويقية لمنصة تعليمية لتداول الأسهم اسمها "AZ Alpha Vision".
الهوية البصرية: خلفية داكنة (كحلي/أسود)، شعار على شكل مربع بحواف دائرية بتدرج بنفسجي-أزرق مكتوب فيه "AZ"، لمسات فيروزي/أخضر (#2dd4a7) وبنفسجي (#7c5cf0).
النمط المطلوب لهذي الصورة تحديدًا: ${imageStyle}
النبرة العامة: ${type === 'فكاهي' ? 'مرحة وخفيفة، بدون نص كثير' : 'احترافية وجادة، تعليمية'}.
لا تضع أي نص طويل داخل الصورة (اسم المنصة AZ فقط لو مناسب). الأبعاد المفضلة: مربعة أو أفقية بسيطة تناسب منشور X.`;

  const response = await axios.post(
    `${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`,
    {
      contents: [
        {
          parts: [{ text: brandContext }],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    }
  );

  const parts = response.data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);

  if (!imagePart) {
    throw new Error('Gemini لم يرجع صورة صالحة');
  }

  return Buffer.from(imagePart.inlineData.data, 'base64');
}

module.exports = { generateImage };
