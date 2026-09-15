// Returns bank transfer details for Upgrade Request UI (no secrets).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const PAYMENT = {
  bank: "مصرف الراجحي / Al Rajhi Bank",
  beneficiary: "عبدالعزيز محمد",
  accountName: "عبدالعزيز محمد",
  accountNumber: "226000010006086106666",
  iban: "SA0480000226608016106666",
  plans: [
    { code: "monthly", amountSar: 299, days: 30, labelAr: "شهر واحد — 299 ريال" },
    { code: "quarterly", amountSar: 899, days: 90, labelAr: "ثلاثة أشهر — 899 ريال" },
  ],
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  return new Response(JSON.stringify(PAYMENT), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
});
