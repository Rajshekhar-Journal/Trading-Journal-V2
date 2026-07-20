import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Math helpers ────────────────────────────────────────────────────────────

function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calculateRSI(prices, period) {
  if (prices.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  const rs = avgLoss === 0 ? 999 : avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

// ── Nifty 500 symbols ───────────────────────────────────────────────────────
const NIFTY_500 = ["360ONE.NS","3MINDIA.NS","ABB.NS","ACC.NS","ACMESOLAR.NS","AIAENG.NS","APLAPOLLO.NS","AUBANK.NS","AWL.NS","AADHARHFC.NS","AARTIIND.NS","AAVAS.NS","ABBOTINDIA.NS","ACE.NS","ACUTAAS.NS","ADANIENSOL.NS","ADANIENT.NS","ADANIGREEN.NS","ADANIPORTS.NS","ADANIPOWER.NS","ATGL.NS","ABCAPITAL.NS","ABFRL.NS","ABLBL.NS","ABREL.NS","ABSLAMC.NS","CPPLUS.NS","AEGISLOG.NS","AEGISVOPAK.NS","AFCONS.NS","AFFLE.NS","AJANTPHARM.NS","ALKEM.NS","ABDL.NS","ARE&M.NS","AMBER.NS","AMBUJACEM.NS","ANANDRATHI.NS","ANANTRAJ.NS","ANGELONE.NS","ANTHEM.NS","ANURAS.NS","APARINDS.NS","APOLLOHOSP.NS","APOLLOTYRE.NS","APTUS.NS","ASAHIINDIA.NS","ASHOKLEY.NS","ASIANPAINT.NS","ASTERDM.NS","ASTRAL.NS","ATHERENERG.NS","ATUL.NS","AUROPHARMA.NS","AIIL.NS","DMART.NS","AXISBANK.NS","BEML.NS","BLS.NS","BSE.NS","BAJAJ-AUTO.NS","BAJFINANCE.NS","BAJAJFINSV.NS","BAJAJHLDNG.NS","BAJAJHFL.NS","BALKRISIND.NS","BALRAMCHIN.NS","BANDHANBNK.NS","BANKBARODA.NS","BANKINDIA.NS","MAHABANK.NS","BATAINDIA.NS","BAYERCROP.NS","BELRISE.NS","BERGEPAINT.NS","BDL.NS","BEL.NS","BHARATFORG.NS","BHEL.NS","BPCL.NS","BHARTIARTL.NS","BHARTIHEXA.NS","BIKAJI.NS","GROWW.NS","BIOCON.NS","BSOFT.NS","BLUEDART.NS","BLUEJET.NS","BLUESTARCO.NS","BBTC.NS","BOSCHLTD.NS","FIRSTCRY.NS","BRIGADE.NS","BRITANNIA.NS","MAPMYINDIA.NS","CCL.NS","CESC.NS","CGPOWER.NS","CIEINDIA.NS","CRISIL.NS","CANFINHOME.NS","CANBK.NS","CANHLIFE.NS","CAPLIPOINT.NS","CGCL.NS","CARBORUNIV.NS","CARTRADE.NS","CASTROLIND.NS","CEATLTD.NS","CEMPRO.NS","CENTRALBK.NS","CDSL.NS","CHALET.NS","CHAMBLFERT.NS","CHENNPETRO.NS","CHOICEIN.NS","CHOLAHLDNG.NS","CHOLAFIN.NS","CIPLA.NS","CUB.NS","CLEAN.NS","COALINDIA.NS","COCHINSHIP.NS","COFORGE.NS","COHANCE.NS","COLPAL.NS","CAMS.NS","CONCORDBIO.NS","CONCOR.NS","COROMANDEL.NS","CRAFTSMAN.NS","CREDITACC.NS","CROMPTON.NS","CUMMINSIND.NS","CYIENT.NS","DCMSHRIRAM.NS","DLF.NS","DOMS.NS","DABUR.NS","DALBHARAT.NS","DATAPATTNS.NS","DEEPAKFERT.NS","DEEPAKNTR.NS","DELHIVERY.NS","DEVYANI.NS","DIVISLAB.NS","DIXON.NS","LALPATHLAB.NS","DRREDDY.NS","EIDPARRY.NS","EIHOTEL.NS","EICHERMOT.NS","ELECON.NS","ELGIEQUIP.NS","EMAMILTD.NS","EMCURE.NS","EMMVEE.NS","ENDURANCE.NS","ENGINERSIN.NS","ERIS.NS","ESCORTS.NS","ETERNAL.NS","EXIDEIND.NS","NYKAA.NS","FEDERALBNK.NS","FACT.NS","FINCABLES.NS","FSL.NS","FIVESTAR.NS","FORCEMOT.NS","FORTIS.NS","GAIL.NS","GVT&D.NS","GMRAIRPORT.NS","GABRIEL.NS","GALLANTT.NS","GRSE.NS","GICRE.NS","GILLETTE.NS","GLAND.NS","GLAXO.NS","GLENMARK.NS","MEDANTA.NS","GODIGIT.NS","GPIL.NS","GODFRYPHLP.NS","GODREJCP.NS","GODREJIND.NS","GODREJPROP.NS","GRANULES.NS","GRAPHITE.NS","GRASIM.NS","GRAVITA.NS","GESHIP.NS","FLUOROCHEM.NS","GMDCLTD.NS","HEG.NS","HBLENGINE.NS","HCLTECH.NS","HDBFS.NS","HDFCAMC.NS","HDFCBANK.NS","HDFCLIFE.NS","HFCL.NS","HAVELLS.NS","HEROMOTOCO.NS","HEXT.NS","HSCL.NS","HINDALCO.NS","HAL.NS","HINDCOPPER.NS","HINDPETRO.NS","HINDUNILVR.NS","HINDZINC.NS","POWERINDIA.NS","HOMEFIRST.NS","HONASA.NS","HONAUT.NS","HUDCO.NS","HYUNDAI.NS","ICICIBANK.NS","ICICIGI.NS","ICICIAMC.NS","ICICIPRULI.NS","IDBI.NS","IDFCFIRSTB.NS","IFCI.NS","IIFL.NS","IRB.NS","IRCON.NS","ITCHOTELS.NS","ITC.NS","ITI.NS","INDGN.NS","INDIACEM.NS","INDIAMART.NS","INDIANB.NS","IEX.NS","INDHOTEL.NS","IOC.NS","IOB.NS","IRCTC.NS","IRFC.NS","IREDA.NS","IGL.NS","INDUSTOWER.NS","INDUSINDBK.NS","NAUKRI.NS","INFY.NS","INOXWIND.NS","INTELLECT.NS","INDIGO.NS","IGIL.NS","IKS.NS","IPCALAB.NS","JKCEMENT.NS","JBMA.NS","JKTYRE.NS","JMFINANCIL.NS","JSWCEMENT.NS","JSWDULUX.NS","JSWENERGY.NS","JSWINFRA.NS","JSWSTEEL.NS","JAINREC.NS","JPPOWER.NS","J&KBANK.NS","JINDALSAW.NS","JSL.NS","JINDALSTEL.NS","JIOFIN.NS","JUBLFOOD.NS","JUBLINGREA.NS","JUBLPHARMA.NS","JWL.NS","JYOTICNC.NS","KPRMILL.NS","KEI.NS","KPITTECH.NS","KAJARIACER.NS","KPIL.NS","KALYANKJIL.NS","KARURVYSYA.NS","KAYNES.NS","KEC.NS","KFINTECH.NS","KIRLOSENG.NS","KOTAKBANK.NS","KIMS.NS","LTF.NS","LTTS.NS","LGEINDIA.NS","LICHSGFIN.NS","LTFOODS.NS","LTM.NS","LT.NS","LATENTVIEW.NS","LAURUSLABS.NS","THELEELA.NS","LEMONTREE.NS","LENSKART.NS","LICI.NS","LINDEINDIA.NS","LLOYDSME.NS","LODHA.NS","LUPIN.NS","MMTC.NS","MRF.NS","MGL.NS","M&MFIN.NS","M&M.NS","MANAPPURAM.NS","MRPL.NS","MANKIND.NS","MARICO.NS","MARUTI.NS","MFSL.NS","MAXHEALTH.NS","MAZDOCK.NS","MEESHO.NS","MINDACORP.NS","MSUMI.NS","MOTILALOFS.NS","MPHASIS.NS","MCX.NS","MUTHOOTFIN.NS","NATCOPHARM.NS","NBCC.NS","NCC.NS","NHPC.NS","NLCINDIA.NS","NMDC.NS","NSLNISP.NS","NTPCGREEN.NS","NTPC.NS","NH.NS","NATIONALUM.NS","NAVA.NS","NAVINFLUOR.NS","NESTLEIND.NS","NETWEB.NS","NEULANDLAB.NS","NEWGEN.NS","NAM-INDIA.NS","NIVABUPA.NS","NUVAMA.NS","NUVOCO.NS","OBEROIRLTY.NS","ONGC.NS","OIL.NS","OLAELEC.NS","OLECTRA.NS","PAYTM.NS","ONESOURCE.NS","OFSS.NS","POLICYBZR.NS","PCBL.NS","PGEL.NS","PIIND.NS","PNBHOUSING.NS","PTCIL.NS","PVRINOX.NS","PAGEIND.NS","PARADEEP.NS","PATANJALI.NS","PERSISTENT.NS","PETRONET.NS","PFIZER.NS","PHOENIXLTD.NS","PWL.NS","PIDILITIND.NS","PINELABS.NS","PIRAMALFIN.NS","PPLPHARMA.NS","POLYMED.NS","POLYCAB.NS","POONAWALLA.NS","PFC.NS","POWERGRID.NS","PREMIERENE.NS","PRESTIGE.NS","PFOCUS.NS","PNB.NS","RRKABEL.NS","RBLBANK.NS","RECLTD.NS","RHIM.NS","RITES.NS","RADICO.NS","RVNL.NS","RAILTEL.NS","RAINBOW.NS","RKFORGE.NS","REDINGTON.NS","RELIANCE.NS","RPOWER.NS","SBFC.NS","SBICARD.NS","SBILIFE.NS","SJVN.NS","SRF.NS","SAGILITY.NS","SAILIFE.NS","SAMMAANCAP.NS","MOTHERSON.NS","SAPPHIRE.NS","SARDAEN.NS","SAREGAMA.NS","SCHAEFFLER.NS","SCHNEIDER.NS","SCI.NS","SHREECEM.NS","SHRIRAMFIN.NS","SHYAMMETL.NS","ENRIN.NS","SIEMENS.NS","SIGNATURE.NS","SOBHA.NS","SOLARINDS.NS","SONACOMS.NS","SONATSOFTW.NS","STARHEALTH.NS","SBIN.NS","SAIL.NS","SUMICHEM.NS","SUNPHARMA.NS","SUNTV.NS","SUNDARMFIN.NS","SUPREMEIND.NS","SPLPETRO.NS","SUZLON.NS","SWANCORP.NS","SWIGGY.NS","SYNGENE.NS","SYRMA.NS","TBOTEK.NS","TVSMOTOR.NS","TATACAP.NS","TATACHEM.NS","TATACOMM.NS","TCS.NS","TATACONSUM.NS","TATAELXSI.NS","TATAINVEST.NS","TMCV.NS","TMPV.NS","TATAPOWER.NS","TATASTEEL.NS","TATATECH.NS","TTML.NS","TECHM.NS","TECHNOE.NS","TEGA.NS","TEJASNET.NS","TENNIND.NS","NIACL.NS","RAMCOCEM.NS","THERMAX.NS","TIMKEN.NS","TITAGARH.NS","TITAN.NS","TORNTPHARM.NS","TORNTPOWER.NS","TARIL.NS","TRAVELFOOD.NS","TRENT.NS","TRIDENT.NS","TRITURBINE.NS","TIINDIA.NS","UCOBANK.NS","UNOMINDA.NS","UPL.NS","UTIAMC.NS","ULTRACEMCO.NS","UNIONBANK.NS","UBL.NS","UNITDSPR.NS","URBANCO.NS","USHAMART.NS","VTL.NS","VBL.NS","VEDL.NS","VIJAYA.NS","VMM.NS","IDEA.NS","VOLTAS.NS","WAAREEENER.NS","WELCORP.NS","WELSPUNLIV.NS","WHIRLPOOL.NS","WIPRO.NS","WOCKPHARMA.NS","YESBANK.NS","ZFCVINDIA.NS","ZEEL.NS","ZENTEC.NS","ZENSARTECH.NS","ZYDUSLIFE.NS","ZYDUSWELL.NS","ECLERX.NS"];

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('MY_SERVICE_ROLE_KEY') || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ── 1. Nifty 500 Index: 6 months for Trend + RSI history ────────────────
    const indexRes = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5ECRSLDX?range=6mo&interval=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const indexData = await indexRes.json();
    const indexResult  = indexData.chart?.result?.[0];
    const indexPrices  = (indexResult?.indicators?.quote?.[0]?.close || []).filter(p => p != null);
    const indexTimes   = indexResult?.timestamp || [];

    // Trend via EMA
    let trend = 'Sideways';
    if (indexPrices.length > 50) {
      const p   = indexPrices[indexPrices.length - 1];
      const e20 = calculateEMA(indexPrices, 20);
      const e50 = calculateEMA(indexPrices, 50);
      if (p > e20 && e20 > e50) trend = 'Uptrend';
      else if (p < e20 && e20 < e50) trend = 'Downtrend';
    }

    // RSI time-series (last 90 days)
    const rsiHistory = [];
    for (let i = 28; i < indexPrices.length; i++) {
      const slice = indexPrices.slice(Math.max(0, i - 50), i + 1);
      const rsi   = calculateRSI(slice, 14);
      if (rsi != null && indexTimes[i]) {
        rsiHistory.push({ date: new Date(indexTimes[i] * 1000).toISOString().split('T')[0], value: rsi });
      }
    }
    const rsiValue = rsiHistory.length > 0 ? rsiHistory[rsiHistory.length - 1].value : null;

    // ── 2. Nifty 500 stocks: Breadth history ────────────────────────────────
    const breadthByTs = {};
    const chunkSize   = 100;

    for (let i = 0; i < NIFTY_500.length; i += chunkSize) {
      const chunk = NIFTY_500.slice(i, i + chunkSize);
      const sparkUrl = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${chunk.join(',')}&range=6mo&interval=1d`;
      const res  = await fetch(sparkUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await res.json();

      for (const r of (data?.spark?.result || [])) {
        const raw       = r.response?.[0];
        const prices    = (raw?.indicators?.quote?.[0]?.close || []).filter(p => p != null);
        const timestamps = raw?.timestamp || [];
        if (prices.length < 20) continue;

        // Rolling EMA for each day — efficient single-pass
        const period = 20, k = 2 / (period + 1);
        let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let d = period; d < prices.length; d++) {
          ema = prices[d] * k + ema * (1 - k);
          const ts = timestamps[d];
          if (!ts) continue;
          if (!breadthByTs[ts]) breadthByTs[ts] = { above: 0, total: 0 };
          breadthByTs[ts].total++;
          if (prices[d] > ema) breadthByTs[ts].above++;
        }
      }
    }

    // Build breadth history — aggregate by CALENDAR DATE first to avoid
    // duplicate-date issues caused by intra-day timestamp variation in Yahoo Finance
    const breadthByDate = {};
    for (const [ts, d] of Object.entries(breadthByTs)) {
      const date = new Date(Number(ts) * 1000).toISOString().split('T')[0];
      if (!breadthByDate[date]) breadthByDate[date] = { above: 0, total: 0 };
      breadthByDate[date].above += d.above;
      breadthByDate[date].total += d.total;
    }

    const breadthHistory = Object.entries(breadthByDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({
        date,
        value: parseFloat(((d.above / d.total) * 100).toFixed(1))
      }));

    const latestBreadth  = breadthHistory[breadthHistory.length - 1];
    const breadthPct     = latestBreadth?.value ?? null;

    // Legacy breadthValue (above/below ratio)
    const latestDateData = latestBreadth ? breadthByDate[latestBreadth.date] : null;
    const above    = latestDateData?.above ?? 0;
    const below    = latestDateData ? (latestDateData.total - latestDateData.above) : 0;
    const breadthValue = below === 0 ? 999 : parseFloat((above / below).toFixed(2));

    let breadthClassification, guidance;
    if (breadthValue < 0.5)       { breadthClassification = 'Extreme Weakness'; guidance = 'Look For Reversal'; }
    else if (breadthValue < 1.0)  { breadthClassification = 'Weak';             guidance = 'Capital Preservation'; }
    else if (breadthValue < 1.5)  { breadthClassification = 'Selective';        guidance = 'Selective Entries'; }
    else                          { breadthClassification = 'Strong';            guidance = 'Breakouts Favoured'; }

    // ── 3. Assemble & Save ──────────────────────────────────────────────────
    const marketHealth = {
      trend, breadthValue, breadthClassification, guidance,
      rsiValue, breadthPct,
      rsiHistory:     rsiHistory.slice(-90),
      breadthHistory: breadthHistory.slice(-90),
      lastUpdated: new Date().toISOString().split('T')[0]
    };

    const { data: usersSettings } = await supabase.from('settings').select('user_id, data');
    if (usersSettings) {
      for (const row of usersSettings) {
        await supabase.from('settings')
          .update({ data: { ...row.data, marketHealth } })
          .eq('user_id', row.user_id);
      }
    }

    return new Response(JSON.stringify(marketHealth), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
