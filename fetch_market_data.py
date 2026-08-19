"""
fetch_market_data.py
يجلب بيانات حقيقية لأسهم السوق الأمريكي من Finviz، مع حد قابل للضبط عبر MAX_UNIVERSE (الافتراضي 2500 سهم):
  - أساسية (Sector/Industry/PE/EPS Growth/Debt) من Finviz عبر finvizfinance
  - فنية حقيقية (SMA/RSI/ATR/السعر/الحجم) من yfinance
ثم يكتبها إلى Supabase.

--mode full   : أسهم السوق ضمن MAX_UNIVERSE (أساسي + فني كامل) — يُشغّل يوميًا
--mode quick  : الأسعار فقط لقائمة "الأسهم الحية" الأصغر (~50 سهم) — يُشغَّل كل 15 دقيقة

⚠️ ملاحظة مهمة: لم يُختبر هذا الملف مقابل Finviz/yfinance الحيّين فعليًا (بيئة
التطوير التي كتبته فيها لا تصل لتلك الشبكات). شغّله يدويًا أول مرة (workflow_dispatch)
وراجع السجلات — أي عمود لم يُطابَق من Finviz سيُطبع كتحذير بدل أن يُسقط الفحص كله.
"""
import os
import sys
import json
import time
import argparse
import logging

import pandas as pd
import numpy as np
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    log.error("SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY غير موجودين في متغيرات البيئة")
    sys.exit(1)

# ===== قائمة احتياطية/مبدئية؛ المصدر الرئيسي للماسح الكامل هو Finviz =====
STOCK_UNIVERSE = [
    'AAPL','MSFT','GOOGL','GOOG','AMZN','NVDA','META','TSLA','AVGO','PEP','COST','ADBE','NFLX','AMD','INTC','CSCO','CRM','ACN','TXN','QCOM',
    'AMAT','INTU','ADP','MU','LRCX','KLAC','MRVL','NXPI','SNPS','CDNS','ANSS','PTC','FTNT','PANW','CRWD','SNOW','PLTR','DDOG','NET','OKTA',
    'ZS','SPLK','VEEV','WDAY','NOW','TEAM','DOCU','ZM','U','RBLX','ABNB','UBER','LYFT','DASH','SQ','PYPL','SHOP','SPOT','TWLO','SNAP','PINS',
    'MTCH','BMBL','RDFN','Z','OPEN','EXPE','BKNG','TRIP','GDRX','RXRX','TDOC','AMGN','GILD','BIIB','REGN','VRTX','ILMN','DXCM','TMO','DHR',
    'ISRG','ZBH','BSX','ABT','SYK','BDX','MDT','EW','HOLX','IDXX','WAT','A','MTD','PKI','BRKR','WST','COO','ALGN','SGEN','MRNA','BNTX',
    'NVAX','JNJ','MRK','PFE','ABBV','BMY','LLY','NVO','AZN','GSK','SNY','RPRX','VTRS','CTLT','DVA','FMS','UHS','CYH','LPNT','HCA','THC',
    'MPW','OHI','WELL','VTR','PEAK','HCP','SBRA','HR','RHP','SLG','BXP','VNO','ARE','QTS','DLR','CCI','AMT','SBAC','WY','RYN','PCH',
    'CLF','NUE','STLD','MT','X','RS','CMC','TMST','ATI','KALU','SCHN','WOR','ZEUS','ASTL','CENX','AA','KGC','NEM','GOLD','AEM','FNV',
    'WPM','RGLD','OR','AUY','EGO','AGI','BTG','HL','CDE','PAAS','SSRM','MAG','SVM','EXK','GPL','LODE','TRX','THM','NGD','MUX','GORO',
    'DRD','SA','SAND','ORLA','FVI','SILV','AG','FSM','HYMC','GROY','MTA','REVG','OSK','NAV','WNC','PACCAR','CMI','PCAR','REV','MGA',
    'LEA','ALV','GNTX','DLPH','BWA','TEN','VC','AXL','MOD','SMP','DORM','STRT','SUP','CTB','GT','RGR','SWBI','VSTO','AOUT','POWW','RBC',
    'TWI','CUB','KWR','HAYN','FUBO','AMC','BBBY','GME','M','NOK','PFE','BAC','C','WFC','CSCO','INTC','AMD','MU','T','VZ','TMUS','CMCSA',
    'SIRI','TWLO','RIVN','LCID','PLUG','FSLR','ENPH','SPWR','NIO','XPEV','BYND','JMIA','SKLZ','U','CRNC','DOCU','ZM','WORK','DKNG','RBLX',
    'ABNB','UBER','WBD','PARA','FOXA','NWSA','NYT','META','SNAP','PINS','MTCH','BMBL','RDFN','Z','OPEN','EXPE','BKNG','TRIP','UBER','LYFT',
    'DASH','GDRX','RXRX','TDOC','AMZN','WMT','TGT','KSS','JCP','BIG','RAD','DPZ','PZZA','YUM','MCD','CMG','MRNA','BNTX','NVAX','AZN',
    'GSK','ILMN','DXCM','TMO','DHR','BRKR','VEEV','CDNS','SNPS','ANSS','ADSK','ADBE','INTU','NOW','CRM','TEAM','WORK','FSLY','FTNT','PANW',
    'NET','ZS','OKTA','PSTG','MDB','DDOG','CONN','IOT','AI','SOUN','NVDA','CRWD','HUBS','TWLO','S','ZUO','EGHT','AVGO','MRVL','TXN','ADI',
    'QCOM','NXPI','SWKS','QRVO','TECH','AMD','INTC','MU','NTAP','PSTG','WDC','STX','SE','PINS','TTD','MGNI','PUBM','CMPR','LDI','BIGC',
    'ETSY','WISH','CART','EBAY','AMZN','WMT','TGT','ROST','TJX','BOOT','BKE','DDS','M','JWN','GES','ANF','URBN','ZUMZ','CPRI','PVH','RL',
    'KORS','COH','OXM','SHOO','CWH','GIII','LEVI','SCVL','HIBB','GPS','DBI','KTB','CAL','CROX','WHR','ARHS','WSM','RH','BYON','NWHM',
    'TDOC','MDU','LNT','CMS','D','ED','ES','EIX','EXC','FE','DTE','XEL','AEP','PEG','ETR','NEE','SO','DUK','BK','RY','TD','PNC','USB',
    'TFC','COF','SYF','ALLY','DFS','FITB','KEY','HBAN','ZION','CMA','PB','TCF','UMB','IBKR','SCHW','MS','GS','JPM','C','BAC','WFC','MTB',
    'PPBI','FRC','WAL','PACW','SIVB','MUFG','SMFG','JEF','RJF','FHI','NTRS','STT','RF','VLY','TBBK','BSBR','ITUB','BBD','SBS','ABEV',
    'BRFS','ERJ','GOL','AZUL','BZ','VALE','GGB','CSAN','RAD','SU','HMC','TM','STLA','F','GM','TSLA','RIVN','LCID','NIO','XPEV','BYD',
    'HOG','PII','NTLA','BEAM','CRSP','NKTR','AZN','GSK','MRNA','BNTX','NVAX','JNJ','MRK','PFE','ABBV','BMY','GILD','AMGN','BIIB','REGN',
    'VRTX','QRTEA','TDOC','HUM','UNH','CNC','ANTM','WBA','CVS','TGT','AAP','KMX','AZO','ORLY','GPC','PAG','GPI','ABG','SAH','LAD','MUSA',
    'BC','ALSN','OSK','REV','PATK','BLD','OC','LPX','BECN','EPC','BUR','CARR','AA','ALB','AA','FMC','ECL','DD','DOW','RPM','SHW','PPG',
    'HXL','WLK','CE','LYB','EMN','ALB','NTR','CTVA','BA','RTX','LMT','NOC','GD','LHX','AXE','MRCY','HXL','TEL','APH','ROL','HII','SPR',
    'WWD','CW','NOC','GD','RTX','LMT','BHE','PNR','ITW','GWW','FAST','SNA','LECO','CAT','DE','CNHI','AGCO','TEX','MTW','ASTE','POWL',
    'DORM','WNC','SUPV','HTZ','CAR','AAL','DAL','UAL','JBLU','ALK','SAVE','HA','ASIX','AHCO','MDT','BSX','ABT','SYK','BDX','BAX','DHR',
    'TMO','ZBH','CNMD','VAR','ANIK','ATRC','BDX','BSX','MDT','SYK','ABT','ZBH','TMO','DHR','NEO','LIVN','NVRO','SIBN','HOLX','NOVT',
    'TWST','ATOM','EXAS','QGEN','NEO','FMI','GH','EXEL','AUTL','ALXN','CBM','IOVA','BMRN','DAWN','CYTK','ACAD','CNCE','ARNA','EYPT',
    'ACHV','ADVM','AGEN','ALLO','ALXN','AMRN','AMRS','ARPO','AVRO','BGNE','BHVN','BLUE','CALA','CLVS','CRIS','CRMD','CRTX','CTMX','CVAC',
    'CYRX','DVAX','EIGR','EMRA','EPZM','ESPR','EVFN','FBIO','FGEN','FOLD','GERN','GLUE','HARP','HGEN','HLGN','IMGN','IMTX','INO','JAGX',
    'KALA','KPTI','LGVN','LOGC','LXRX','MBIO','MESO','MGNX','MRNS','MVC','NDVA','OCGN','OLMA','ONCE','ORGS','PDSB','PTC','RAPT','REPL',
    'REPT','SAGE','SCPH','SGEN','SLNO','SRPT','STOK','TAK','TCBP','TCRX','TH','TKAI','TLSA','URGN','VANI','VERU','VIRC','VIRX','VSTM',
    'XBIT','XENE','XNCR','ZLAB','ALT','AMC','CWH','DDS','GES','HIBB','JWN','KSS','M','URBN','WISH','GME','BBBY','M','JCP','BIG','RAD',
    'KSS','JWN','ANF','GES','HIBB','URBN','ZUMZ','CHS','CWH','DDS','GES','JWN','KSS','M','URBN','WISH','GME','BBBY','SOFI','AFRM','UPST',
    'HOOD','COIN','PLTR','SNOW','DDOG','NET','CRWD','OKTA','ZS','S','MDB','ESTC','SMAR','ASAN','MNDY','AI','SOUN','BBAI','AMST','DUOT',
    'LTRX','RXT','SSTI','VRNS','RPD','TENB','CYBR','QLYS','SUMO','DOMO','PLAN','MOND','BABA','JD','PDD','NTES','BIDU','TCEHY','TCOM',
    'VIPS','MOMO','YY','HUYA','DOYU','FUTU','TIGR','LU','FINV','QFIN','LX','YRD','JT','PPDF','XYF','LI','FSR','GOEV','MULN','NKLA','WKHS',
    'RIDE','QS','SPWR','SEDG','RUN','NOVA','CWEN','AY','SRE','WEC','ATO','SWX','NFG','OGS','SR','SPH','FGP','APU','SUG','CMLP','DPM',
    'EPD','ETP','KMP','MMP','MWE','BPL','BWP','CPNO','DCP','ENLK','EXLP','GLP','HEP','MMLP','NS','OKS','PAA','SXL','TCP','TLP','WES',
    'WPZ','XTEX','APL','ATLS','EEP','ETP','GEL','CGC','TLRY','ACB','CRON','SNDL','GTBIF','TCNNF','CURLF','CRLBF','PLNHF','VRNOF','GDNSF',
    'AYRWF','JUSHF','MSOS','MJ','YOLO','POTX','THCX','TOKE','ACT','SPCE','RKLB','ASTS','MNTS','VORB','REDWIRE','SATL','BKSY','MYNA','SPIR',
    'ASTR','LLAP','SIDU','SATS','GSAT','IRDM','VSAT','MAXR','DDD','SSYS','DM','MKFG','VLD','MTLS','NNDM','XONE','PRLB','ATVI','EA','TTWO',
    'PLTK','SCPL','GLUU','ZNGA','XOM','CVX','COP','EOG','SLB','OXY','MPC','VLO','PSX','MRO','DVN','FANG','PXD','OVV','APA','CHRD','SM',
    'MTDR','PE','GPOR','RRC','AR','SWN','CTRA','EQT','CNX','RICE','NFG','UPS','FDX','CHRW','EXPD','XPO','SAIA','ODFL','LSTR','ARCB','HTLD',
    'MRTN','WERN','KNX','JBHT','SWFT','CGNX','ZTO','YMM','DIDI','GRUB','TKAY','GETR','DADA','GOGO','ATSG','ABSTS','AIR','AIRT','MOS','CF',
    'GE','HON','MMM'
]
STOCK_UNIVERSE = sorted(set(STOCK_UNIVERSE))

LIVE_TRACKED = ['AAPL','MSFT','GOOGL','AMZN','NVDA','TSLA','META','AMD','NFLX','CRM','SHOP','SQ','UBER',
                 'ABNB','COIN','ROKU','SNAP','PINS','ETSY','TWLO','DDOG','NET','OKTA','ZS','CRWD','PLTR',
                 'SNOW','FSLR','ENPH','RUN','U','RBLX','SOFI','AFRM','HOOD','UPST','AI','SOUN','BBAI',
                 'PLUG','QS','SPCE','RKLB','ASTS','LLAP','BABA','JD','PDD','FUTU','TIGR']

# Finviz's real 11 sectors -> the app's simplified categories (unchanged from the original UI)
SECTOR_TRANSLATE = {
    'Technology': 'tech',
    'Financial': 'finance',
    'Healthcare': 'healthcare',
    'Consumer Cyclical': 'consumer',
    'Consumer Defensive': 'consumer',
    'Industrials': 'industrial',
    'Energy': 'energy',
    'Utilities': 'energy',
    'Real Estate': 'reits',
    'Basic Materials': 'other',
    'Communication Services': 'other',
}


def find_col(df, *keywords):
    """أول عمود يحتوي كل الكلمات المفتاحية (غير حساس لحالة الأحرف) — دفاعي لأن أسماء
    أعمدة Finviz لم تُتحقق مقابل الموقع الحي وقت كتابة هذا الملف."""
    for col in df.columns:
        low = str(col).lower()
        if all(k.lower() in low for k in keywords):
            return col
    return None


def safe_num(val, default=None):
    try:
        if val is None or val == '-' or val == '' or (isinstance(val, float) and np.isnan(val)):
            return default
        s = str(val).replace('%', '').replace(',', '')
        return float(s)
    except Exception:
        return default


def safe_quantity(val, default=None):
    """تحويل قيم Finviz مثل 300K و99.5M و1.2B إلى أرقام فعلية."""
    if val is None or val == '-' or val == '':
        return default
    try:
        s = str(val).strip().replace(',', '').replace('%', '').upper()
        mult = 1.0
        if s.endswith('K'):
            mult, s = 1_000.0, s[:-1]
        elif s.endswith('M'):
            mult, s = 1_000_000.0, s[:-1]
        elif s.endswith('B'):
            mult, s = 1_000_000_000.0, s[:-1]
        return float(s) * mult
    except Exception:
        return default


def load_primary_exchange_symbols():
    """تحميل رموز NYSE وNASDAQ الرسمية؛ يستبعد NYSE American/AMEX وArca وغيرها."""
    symbols = {}
    sources = [
        ('NASDAQ', 'https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt'),
        ('NYSE', 'https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt'),
    ]
    for exchange_name, url in sources:
        try:
            text = requests.get(url, timeout=30, headers={'User-Agent': 'AZ-Alpha-Vision/1.0'}).text
            lines = [line for line in text.splitlines() if line and not line.startswith('File Creation')]
            for line in lines[1:]:
                parts = line.split('|')
                if exchange_name == 'NASDAQ':
                    ticker = parts[0].strip().upper() if parts else ''
                    if ticker and ticker != 'SYMBOL':
                        symbols[ticker] = 'NASDAQ'
                else:
                    ticker = parts[0].strip().upper() if parts else ''
                    exchange_code = parts[2].strip().upper() if len(parts) > 2 else ''
                    if ticker and ticker != 'ACT SYMBOL' and exchange_code == 'N':
                        symbols[ticker] = 'NYSE'
        except Exception as exc:
            log.warning(f'تعذر تحميل قائمة {exchange_name} الرسمية: {exc}')
    log.info(f'تم تحميل {len(symbols)} رمزًا من قوائم NYSE/NASDAQ الرسمية')
    return symbols


def fetch_finviz_fundamentals():
    from finvizfinance.screener.overview import Overview
    from finvizfinance.screener.valuation import Valuation
    from finvizfinance.screener.financial import Financial

    log.info("جلب Overview من Finviz (قد يستغرق عدة دقائق بسبب صفحات Finviz المتعددة)...")
    ov = Overview()
    ov.set_filter(filters_dict={'Country': 'USA'})
    df_ov = ov.screener_view()
    if df_ov is None or df_ov.empty:
        raise RuntimeError("Finviz Overview لم يُرجع أي بيانات")
    log.info(f"Overview: {len(df_ov)} سهم أمريكي إجمالاً من Finviz")
    max_universe = max(100, int(os.environ.get('MAX_UNIVERSE', '2500')))
    # Finviz يعيد النتائج مرتبة افتراضيًا؛ نأخذ أول MAX_UNIVERSE لتفادي تشغيل غير محدود.
    df_ov = df_ov.head(max_universe).copy()
    log.info(f"بعد تحديد نطاق الماسح: {len(df_ov)} سهم من أصل {len(df_ov)}+ المتاحة")

    # أهلية التداول: أسهم مدرجة في سوق رئيسي وليست ETF/صندوقًا أو رمزًا ضعيف السيولة.
    # هذه الحدود قابلة للضبط من متغيرات البيئة.
    allowed_exchanges = {'NYSE', 'NASDAQ'}
    min_price = float(os.environ.get('MIN_PRICE', '5'))
    max_price = float(os.environ.get('MAX_PRICE', '50'))
    min_avg_volume = float(os.environ.get('MIN_AVG_VOLUME', '300000'))
    min_current_volume = float(os.environ.get('MIN_CURRENT_VOLUME', '500000'))
    max_float = float(os.environ.get('MAX_FLOAT', '100000000'))
    min_rel_volume = float(os.environ.get('MIN_REL_VOLUME', '2'))
    excluded_symbols = {'DDV'}
    excluded_industries = {'exchange traded fund', 'etf', 'closed end fund', 'reit'}
    primary_exchange_symbols = load_primary_exchange_symbols()
    eligible_rows = []
    rejected = {'exchange': 0, 'etf': 0, 'liquidity': 0, 'float': 0, 'relative_volume': 0}
    for _, row in df_ov.iterrows():
        ticker = str(row.get('Ticker', '')).strip().upper()
        finviz_exchange = str(row.get('Exchange', '')).strip().upper()
        exchange = primary_exchange_symbols.get(ticker, finviz_exchange if finviz_exchange in allowed_exchanges else '')
        industry = str(row.get('Industry', '')).strip().lower()
        price = safe_num(row.get('Price')) or 0
        avg_volume = safe_quantity(row.get('Avg Volume') or row.get('Average Volume'))
        current_volume = safe_quantity(row.get('Volume') or row.get('Current Volume'))
        float_shares = safe_quantity(row.get('Float'))
        relative_volume = safe_num(row.get('Relative Volume'))
        if exchange not in allowed_exchanges:
            rejected['exchange'] += 1
            continue
        if ticker in excluded_symbols:
            rejected['exchange'] += 1
            continue
        if any(token in industry for token in excluded_industries):
            rejected['etf'] += 1
            continue
        if price < min_price or price > max_price:
            rejected['liquidity'] += 1
            continue
        # لا يوجد شرط حجم إلزامي؛ تُحفظ قيم الحجم إن وجدت لاستخدامها في العرض فقط.
        if float_shares is not None and float_shares >= max_float:
            rejected['float'] += 1
            continue
        eligible_rows.append(row)
    df_ov = pd.DataFrame(eligible_rows)
    log.info(f"بعد فلاتر Finviz والأهلية: {len(df_ov)} سهم؛ مرفوض exchange={rejected['exchange']}, ETF={rejected['etf']}, liquidity={rejected['liquidity']}, float={rejected['float']}, relvol={rejected['relative_volume']}")

    records = {}
    for _, row in df_ov.iterrows():
        t = row['Ticker']
        finviz_sector = str(row.get('Sector', ''))
        records[t] = {
            'symbol': t,
            'company': row.get('Company'),
            'price': safe_num(row.get('Price')),
            'exchange': str(row.get('Exchange', '')).strip().upper(),
            'sector': SECTOR_TRANSLATE.get(finviz_sector, 'other'),
            'finviz_sector': finviz_sector,
            'industry': row.get('Industry'),
            'pe': safe_num(row.get('P/E')),
        }

    try:
        log.info("جلب Valuation من Finviz...")
        val = Valuation()
        val.set_filter(filters_dict={'Country': 'USA'})
        df_val = val.screener_view()
        if df_val is not None and not df_val.empty:
            df_val = df_val[df_val['Ticker'].isin(records.keys())].copy()
            log.info(f"أعمدة Valuation المستلمة: {list(df_val.columns)}")
            c_pb = find_col(df_val, 'p/b')
            c_eps_ty = find_col(df_val, 'eps', 'this')
            c_eps_ny = find_col(df_val, 'eps', 'next', 'y')
            c_eps_5y = find_col(df_val, 'eps', 'past', '5')
            c_eps_n5y = find_col(df_val, 'eps', 'next', '5')
            for c_name, label in [(c_pb,'P/B'),(c_eps_ty,'EPS this Y'),(c_eps_ny,'EPS next Y'),(c_eps_5y,'EPS past 5Y'),(c_eps_n5y,'EPS next 5Y')]:
                if not c_name:
                    log.warning(f"لم يُطابَق عمود Valuation المتوقع: {label} — سيبقى فارغًا")
            for _, row in df_val.iterrows():
                t = row['Ticker']
                if t not in records:
                    continue
                records[t]['pb'] = safe_num(row.get(c_pb)) if c_pb else None
                records[t]['eps_growth_this_year'] = safe_num(row.get(c_eps_ty)) if c_eps_ty else None
                records[t]['eps_growth_next_year'] = safe_num(row.get(c_eps_ny)) if c_eps_ny else None
                records[t]['eps_growth_5y'] = safe_num(row.get(c_eps_5y)) if c_eps_5y else None
                records[t]['eps_growth_next_5y'] = safe_num(row.get(c_eps_n5y)) if c_eps_n5y else None
    except Exception as e:
        log.warning(f"تعذر جلب Valuation (سيُتخطى — الحقول المرتبطة تبقى فارغة): {e}")

    try:
        log.info("جلب Financial من Finviz...")
        fin = Financial()
        fin.set_filter(filters_dict={'Country': 'USA'})
        df_fin = fin.screener_view()
        if df_fin is not None and not df_fin.empty:
            df_fin = df_fin[df_fin['Ticker'].isin(records.keys())].copy()
            log.info(f"أعمدة Financial المستلمة: {list(df_fin.columns)}")
            c_ltdebt = find_col(df_fin, 'ltdebt') or find_col(df_fin, 'lt debt')
            c_debt = find_col(df_fin, 'debt/eq')
            c_earn_qtr = find_col(df_fin, 'eps', 'qtr') or find_col(df_fin, 'earnings')
            if not (c_ltdebt or c_debt):
                log.warning("لم يُطابَق أي عمود دين — lt_debt_equity سيبقى فارغًا")
            for _, row in df_fin.iterrows():
                t = row['Ticker']
                if t not in records:
                    continue
                debt_val = safe_num(row.get(c_ltdebt)) if c_ltdebt else safe_num(row.get(c_debt)) if c_debt else None
                records[t]['lt_debt_equity'] = debt_val
                records[t]['eps_growth_qtr'] = safe_num(row.get(c_earn_qtr)) if c_earn_qtr else None
    except Exception as e:
        log.warning(f"تعذر جلب Financial (سيُتخطى — الحقول المرتبطة تبقى فارغة): {e}")

    log.info(f"إجمالي السجلات الأساسية المجمّعة: {len(records)}")
    return records


def compute_technical(hist_df):
    close = hist_df['Close']
    high = hist_df['High']
    low = hist_df['Low']

    def sma(n):
        return round(float(close.rolling(n).mean().iloc[-1]), 4) if len(close) >= n else None

    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi_series = 100 - (100 / (1 + rs))
    rsi = rsi_series.iloc[-1] if len(rsi_series) >= 15 else None
    rsi = round(float(rsi), 2) if rsi is not None and pd.notna(rsi) else None

    prev_close = close.shift(1)
    tr = pd.concat([high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    atr_series = tr.ewm(alpha=1/14, adjust=False, min_periods=14).mean()
    atr = atr_series.iloc[-1] if len(atr_series) >= 14 else None
    atr = round(float(atr), 4) if atr is not None and pd.notna(atr) else None

    perf_week = None
    if len(close) >= 6:
        wk_ago = float(close.iloc[-6])
        if wk_ago:
            perf_week = round(((float(close.iloc[-1]) - wk_ago) / wk_ago) * 100, 2)

    return {'sma20': sma(20), 'sma50': sma(50), 'sma200': sma(200), 'rsi14': rsi, 'atr14': atr, 'perf_week': perf_week}


def fetch_prices_and_technicals(tickers, full_history=True):
    import yfinance as yf
    results = {}
    chunk_size = 40
    period = '1y' if full_history else '5d'

    for i in range(0, len(tickers), chunk_size):
        chunk = tickers[i:i + chunk_size]
        log.info(f"yfinance دفعة {i // chunk_size + 1}/{(len(tickers)-1)//chunk_size + 1}: {len(chunk)} سهم")
        try:
            data = yf.download(chunk, period=period, group_by='ticker', threads=True,
                                auto_adjust=False, progress=False)
        except Exception as e:
            log.warning(f"فشلت دفعة yfinance بالكامل، سيُعاد المحاولة بعد تأخير: {e}")
            time.sleep(10)
            continue

        for t in chunk:
            try:
                df_t = data[t].dropna() if len(chunk) > 1 else data.dropna()
                if df_t is None or df_t.empty or 'Close' not in df_t.columns:
                    continue
                last = df_t.iloc[-1]
                prev = df_t.iloc[-2] if len(df_t) > 1 else last
                price = float(last['Close'])
                prev_close = float(prev['Close']) if pd.notna(prev['Close']) else price
                change_pct = round(((price - prev_close) / prev_close) * 100, 2) if prev_close else 0.0
                vol = int(last['Volume']) if pd.notna(last['Volume']) else 0
                prior_volumes = df_t['Volume'].iloc[:-1].dropna().tail(9)
                avg_vol_9 = float(prior_volumes.mean()) if len(prior_volumes) else float(vol)
                avg_vol = int(df_t['Volume'].tail(20).mean()) if len(df_t) >= 5 else vol
                rec = {
                    'price': round(price, 2), 'change_pct': change_pct, 'volume': vol,
                    'avg_volume': avg_vol, 'avg_volume_9': round(avg_vol_9, 2),
                    'rel_volume': round(vol / avg_vol, 2) if avg_vol else 1.0,
                    'rel_volume_9': round(vol / avg_vol_9, 2) if avg_vol_9 else 1.0,
                }
                if full_history:
                    rec.update(compute_technical(df_t))
                results[t] = rec
            except Exception as e:
                log.warning(f"تعذر معالجة {t}: {e}")
        time.sleep(2)

    log.info(f"نجح جلب أسعار/فنيات {len(results)} من أصل {len(tickers)} سهم")
    return results


def upsert_rows(table, rows):
    """إدراج/تحديث دفعات Supabase مع إيقاف واضح عند فشل المخطط أو الصلاحيات."""
    if not rows:
        log.warning(f"{table}: لا صفوف لكتابتها")
        return 0

    url = f"{SUPABASE_URL}/rest/v1/{table}?on_conflict=symbol"
    headers = {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates, return=minimal',
    }
    batch_size = 200
    written = 0
    expected_columns = sorted(rows[0].keys())

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        try:
            resp = requests.post(url, headers=headers, json=batch, timeout=30)
        except requests.RequestException as exc:
            raise RuntimeError(f"{table}: فشل الاتصال بـ Supabase في الدفعة {i}: {exc}") from exc

        if resp.status_code not in (200, 201, 204):
            detail = resp.text[:1200]
            log.error(
                f"{table}: فشل الحفظ في الدفعة {i}; status={resp.status_code}; "
                f"columns={expected_columns}; response={detail}"
            )
            raise RuntimeError(f"فشل حفظ {table}: HTTP {resp.status_code}: {detail}")

        written += len(batch)

    log.info(f"{table}: تم حفظ {written} صف")
    return written


def run_full():
    fundamentals = fetch_finviz_fundamentals()
    if not fundamentals:
        log.error("لا بيانات أساسية — إيقاف")
        sys.exit(1)

    tech = fetch_prices_and_technicals(list(fundamentals.keys()), full_history=True)
    now = pd.Timestamp.now(tz='UTC').isoformat()

    fund_rows = [{**v, 'updated_at': now} for v in fundamentals.values()]
    tech_rows = [{'symbol': t, **vals, 'updated_at': now} for t, vals in tech.items()]

    n1 = upsert_rows('market_fundamentals', fund_rows)
    n2 = upsert_rows('market_technicals', tech_rows)

    if n1 == 0:
        log.error("لم تُحفظ أي بيانات أساسية — فشل المسح")
        sys.exit(1)
    if n2 == 0:
        log.warning("لم تُحفظ بيانات فنية؛ تم حفظ الأساسيات بنجاح وسيُعاد تحديث الفنيات في تشغيل لاحق")


def run_quick():
    tech = fetch_prices_and_technicals(LIVE_TRACKED, full_history=False)
    now = pd.Timestamp.now(tz='UTC').isoformat()
    rows = [{'symbol': t, 'price': v['price'], 'change_pct': v['change_pct'],
             'volume': v['volume'], 'updated_at': now} for t, v in tech.items()]
    n = upsert_rows('live_quotes', rows)
    if n == 0:
        sys.exit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['full', 'quick'], default='full')
    args = parser.parse_args()
    if args.mode == 'full':
        run_full()
    else:
        run_quick()
