// جدولة النشر الذكية: تقيّد المنشورات العادية بساعات الذروة (صباح العمل، بعد الظهر، المساء)
// في المنطقة المستهدفة، دون أي تكلفة إضافية — تعتمد فقط على التوقيت أثناء تشغيل الـ cron المجاني.
const PEAK_WINDOWS = [
  { from: 8, to: 11 },
  { from: 13, to: 16 },
  { from: 19, to: 24 },
];

function currentHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.POSTING_TIMEZONE || 'Asia/Riyadh',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(date)
  );
}

function isPeakHour(date = new Date()) {
  const hour = currentHour(date);
  return PEAK_WINDOWS.some((w) => hour >= w.from && hour < w.to);
}

function nextPeakWindowLabel(date = new Date()) {
  const hour = currentHour(date);
  const upcoming = PEAK_WINDOWS.find((w) => hour < w.from);
  return upcoming ? `${upcoming.from}:00` : `${PEAK_WINDOWS[0].from}:00 (غداً)`;
}

module.exports = { isPeakHour, currentHour, nextPeakWindowLabel, PEAK_WINDOWS };
