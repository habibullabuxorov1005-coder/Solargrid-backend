const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const WEATHER_KEY = process.env.WEATHER_API_KEY || '5c2cd8324b3695b36c6f6681d0498111';

// ─── Growatt ─────────────────────────────────────────────
async function growattData(config) {
  const { username, password, plant_id } = config;
  if (!username || !password || !plant_id) throw new Error('Growatt: username, password, plant_id kerak');
  const pass_md5 = crypto.createHash('md5').update(password).digest('hex');
  const login = await axios.post('https://server.growatt.com/login',
    `account=${encodeURIComponent(username)}&password=${pass_md5}&validateCode=`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  if (login.data?.back?.success !== 1) throw new Error('Growatt login xatosi — email/parol tekshiring');
  const cookies = login.headers['set-cookie']?.join(';') || '';
  const plant = await axios.post('https://server.growatt.com/panel/getDevicesByPlantList',
    { plantId: plant_id, currPage: 1 },
    { headers: { Cookie: cookies } }
  );
  const devices = plant.data?.back?.data?.deviceList || [];
  const panels = [];
  for (const [i, dev] of devices.entries()) {
    const detail = await axios.post('https://server.growatt.com/panel/getDeviceInfo',
      { deviceSn: dev.deviceSn, plantId: plant_id },
      { headers: { Cookie: cookies } }
    ).catch(() => ({ data: {} }));
    const d = detail.data?.back?.obj || {};
    const power = parseFloat(d.pac || dev.power || 0);
    const voltage = parseFloat(d.vpv1 || d.vacr || 0);
    const current = parseFloat(d.ipv1 || 0);
    const temp = parseFloat(d.temperature || 0);
    const row = String.fromCharCode(65 + Math.floor(i / 8));
    const col = (i % 8) + 1;
    const id = `${row}${col}`;
    let status = 'normal', issue = null;
    if (dev.status === '0' || power < 5) { status = 'fault'; issue = 'Qurilma ishlamayapti'; }
    else if (power < 100) { status = 'weak'; issue = 'Quvvat past'; }
    panels.push({ id, row, col, power_w: Math.round(power), voltage, current,
      temperature: temp, efficiency: Math.round((power/500)*100), status, issue, sn: dev.deviceSn });
  }
  return { panels, source: 'growatt' };
}

// ─── Huawei FusionSolar ───────────────────────────────────
async function huaweiData(config) {
  const { username, system_code, station_dn } = config;
  if (!username || !system_code) throw new Error('Huawei: username va system_code kerak');
  const login = await axios.post('https://intl.fusionsolar.huawei.com/thirdData/login',
    { userName: username, systemCode: system_code }
  );
  if (login.data?.failCode !== 0) throw new Error('Huawei login xatosi — credentials tekshiring');
  const token = login.data?.data?.xsrfToken;
  const headers = { 'xsrf-token': token };
  const stList = await axios.post('https://intl.fusionsolar.huawei.com/thirdData/getStationList', {}, { headers });
  const stations = stList.data?.data || [];
  const st = station_dn ? stations.find(s=>s.stationCode===station_dn)||stations[0] : stations[0];
  if (!st) throw new Error('Huawei: stansiya topilmadi');
  const devList = await axios.post('https://intl.fusionsolar.huawei.com/thirdData/getDevList',
    { stationCodes: st.stationCode }, { headers }
  );
  const devices = devList.data?.data || [];
  const panels = [];
  for (const [i, dev] of devices.entries()) {
    const rt = await axios.post('https://intl.fusionsolar.huawei.com/thirdData/getDevRealKpi',
      { devIds: dev.id, devTypeId: dev.devTypeId }, { headers }
    ).catch(() => ({ data: {} }));
    const kpi = rt.data?.data?.[0]?.dataItemMap || {};
    const power = parseFloat(kpi.active_power||0)*1000;
    const voltage = parseFloat(kpi.pv1_u||kpi.ab_u||0);
    const current = parseFloat(kpi.pv1_i||0);
    const temp = parseFloat(kpi.temperature||0);
    const row = String.fromCharCode(65+Math.floor(i/8));
    const col = (i%8)+1;
    const id = `${row}${col}`;
    let status='normal', issue=null;
    if (dev.devStatus==='0'||power<5) { status='fault'; issue='Qurilma ishlamayapti'; }
    else if (power<100) { status='weak'; issue='Quvvat past'; }
    panels.push({ id, row, col, power_w:Math.round(power), voltage, current,
      temperature:temp, efficiency:Math.round((power/500)*100), status, issue, device_name:dev.devName });
  }
  return { panels, source: 'huawei', station_name: st.stationName };
}

// ─── Solis ───────────────────────────────────────────────
async function solisData(config) {
  const { api_id, api_secret, station_id } = config;
  if (!api_id||!api_secret) throw new Error('Solis: api_id va api_secret kerak');
  const now = new Date().toUTCString();
  const body = JSON.stringify({ id: station_id });
  const md5 = crypto.createHash('md5').update(body).digest('base64');
  const sign = crypto.createHmac('sha1', api_secret)
    .update(`POST\n${md5}\napplication/json\n${now}\n/v1/api/stationDetail`)
    .digest('base64');
  const res = await axios.post('https://www.soliscloud.com:13333/v1/api/stationDetail', body, {
    headers: { 'Content-Type':'application/json','Content-MD5':md5,'Date':now,'Authorization':`API ${api_id}:${sign}` }
  });
  if (!res.data?.success) throw new Error('Solis: '+res.data?.msg);
  const d = res.data?.data || {};
  const power = parseFloat(d.pac||0)*1000;
  const panels = buildStringPanels(power, config);
  return { panels, source: 'solis', total_kw: parseFloat(d.pac||0) };
}

// ─── Deye ────────────────────────────────────────────────
async function deyeData(config) {
  const { username, password, sn } = config;
  if (!username||!password) throw new Error('Deye: username va password kerak');
  const login = await axios.post('https://monitoring.deye.com.cn/api/user/userLogin',
    { account: username, password: crypto.createHash('md5').update(password).digest('hex') }
  );
  if (login.data?.code!==0) throw new Error('Deye login xatosi');
  const token = login.data?.data?.token;
  const dev = await axios.get(`https://monitoring.deye.com.cn/api/device/queryInfo?deviceSn=${sn}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const d = dev.data?.data || {};
  const power = parseFloat(d.activePower||0)*1000;
  const panels = buildStringPanels(power, config);
  return { panels, source: 'deye', total_kw: parseFloat(d.activePower||0) };
}

// ─── SMA ────────────────────────────────────────────────
async function smaData(config) {
  const { username, password, plant_id } = config;
  if (!username||!password) throw new Error('SMA: username va password kerak');
  const login = await axios.post('https://www.sunnyportal.com/api/v1/token',
    { grant_type:'password', username, password }
  );
  const token = login.data?.access_token;
  if (!token) throw new Error('SMA login xatosi');
  const plant = await axios.get(`https://www.sunnyportal.com/api/v1/plants/${plant_id}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const power = parseFloat(plant.data?.currentPower||0)*1000;
  const panels = buildStringPanels(power, config);
  return { panels, source: 'sma', total_kw: parseFloat(plant.data?.currentPower||0) };
}

// ─── Custom ───────────────────────────────────────────────
async function customData(config) {
  const { api_url, api_key } = config;
  if (!api_url) throw new Error('Custom: api_url kerak');
  const headers = api_key ? { Authorization: `Bearer ${api_key}` } : {};
  const res = await axios.get(api_url, { headers, timeout: 10000 });
  if (Array.isArray(res.data)) return { panels: res.data, source: 'custom' };
  if (res.data?.panels) return { panels: res.data.panels, source: 'custom' };
  throw new Error('Custom API noto\'g\'ri format — panels array kerak');
}

// ─── Simulyatsiya ─────────────────────────────────────────
function simulationData(config) {
  const rows = config?.rows||6, cols = config?.panels_per_row||8, cap = config?.capacity_kw||24;
  const hour = new Date().getHours();
  const isSunny = hour>=6&&hour<=19;
  const sf = isSunny ? Math.sin(((hour-6)/13)*Math.PI)*(0.8+Math.random()*0.2) : 0;
  const panels = [];
  for (let r=0;r<rows;r++) for (let c=0;c<cols;c++) {
    const id=`${String.fromCharCode(65+r)}${c+1}`;
    let eff=0.85+Math.random()*0.15,status='normal',issue=null;
    const rnd=Math.random();
    if(rnd<0.04){eff*=0.45+Math.random()*0.2;status='dirty';issue='Changlanish ehtimoli yuqori';}
    else if(rnd<0.06){eff*=0.1;status='fault';issue='Panel shikastlangan yoki sim uzilgan';}
    else if(rnd<0.08){eff*=0.65;status='weak';issue='Quvvat pasaygan';}
    const maxP=(cap*1000)/(rows*cols);
    const power_w=isSunny?Math.round(maxP*sf*eff):0;
    const voltage=power_w>0?Math.round((36+Math.random()*4)*10)/10:0;
    panels.push({id,row:String.fromCharCode(65+r),col:c+1,power_w,voltage,
      current:Math.round((power_w/(voltage||1))*100)/100,
      temperature:Math.round((25+Math.random()*20+(power_w>0?15:0))*10)/10,
      efficiency:Math.round(eff*100),status,issue});
  }
  return { panels, source:'simulation' };
}

// ─── String panel builder (string darajasida ishlaydigan inverterlar uchun) ─
function buildStringPanels(totalPower, config) {
  const rows = config?.rows||6, cols = config?.panels_per_row||8;
  const panels = [];
  for (let r=0;r<rows;r++) for (let c=0;c<cols;c++) {
    const row=String.fromCharCode(65+r), col=c+1, id=`${row}${col}`;
    const pwr = totalPower>0 ? Math.round(totalPower/(rows*cols)*(0.85+Math.random()*0.15)) : 0;
    const voltage = pwr>0 ? 37+Math.random()*3 : 0;
    panels.push({id,row,col,power_w:pwr,voltage,current:Math.round((pwr/(voltage||1))*100)/100,
      temperature:pwr>0?35+Math.random()*10:25,efficiency:pwr>0?85+Math.round(Math.random()*12):0,
      status:'normal',issue:null});
  }
  return panels;
}

// ─── Ob-havo ─────────────────────────────────────────────
async function getWeather(lat, lon) {
  try {
    const [owm, meteo] = await Promise.all([
      axios.get(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_KEY}&units=metric&lang=uz`),
      axios.get(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=shortwave_radiation,uv_index,is_day&daily=shortwave_radiation_sum,temperature_2m_max,cloud_cover_mean,sunrise,sunset&timezone=auto&forecast_days=4`),
    ]);
    const w=owm.data, m=meteo.data;
    const fmt=s=>s?new Date(s).toLocaleTimeString('uz-UZ',{hour:'2-digit',minute:'2-digit'}):'—';
    const radList=m.daily.shortwave_radiation_sum||[];
    const maxRad=Math.max(...radList.slice(1,4),1);
    return {
      temp:Math.round(w.main.temp), description:w.weather[0].description,
      clouds:w.clouds.all, wind_speed:Math.round(w.wind.speed*10)/10,
      solar_radiation:Math.round(m.current.shortwave_radiation||0),
      uv_index:Math.round(m.current.uv_index||0),
      is_day:m.current.is_day===1,
      sunrise:fmt((m.daily.sunrise||[])[0]), sunset:fmt((m.daily.sunset||[])[0]),
      icon:w.weather[0].icon,
      forecast:['Ertaga','Indiniga','3 kundan keyin'].map((day,i)=>({
        day, temp:Math.round((m.daily.temperature_2m_max||[])[i+1]||0),
        clouds:Math.round((m.daily.cloud_cover_mean||[])[i+1]||0),
        production_estimate:Math.min(100,Math.round(((radList[i+1]||0)/maxRad)*100)),
      })),
    };
  } catch(e) {
    return {temp:0,description:'—',clouds:0,wind_speed:0,solar_radiation:0,uv_index:0,
      is_day:false,sunrise:'—',sunset:'—',icon:'01d',forecast:[]};
  }
}

// ─── Tahlil ───────────────────────────────────────────────
function analyze(panels, weather) {
  const alerts=[], solarGood=(weather.solar_radiation||0)>100;
  const rows={};
  panels.forEach(p=>{if(!rows[p.row])rows[p.row]=[];rows[p.row].push(p);});
  Object.entries(rows).forEach(([row,rp])=>{
    if(rp.every(p=>p.power_w<10)&&solarGood)
      alerts.push({type:'wire_cut',severity:'critical',
        title:`${row}-qator: Sim uzilgan bo'lishi mumkin`,
        description:`${row}-qatordagi barcha panellar ishlamayapti. Ob-havo yaxshi.`,
        action:`${row}-qator kabellarini tekshiring`});
  });
  panels.forEach(p=>{
    if(!solarGood)return;
    const nb=panels.filter(n=>n.row===p.row&&Math.abs(n.col-p.col)<=2&&n.id!==p.id);
    const avg=nb.reduce((s,n)=>s+n.power_w,0)/(nb.length||1);
    if(p.power_w<avg*0.55&&avg>50&&p.power_w>5)
      alerts.push({type:'dirty',severity:'warning',
        title:`Panel ${p.id}: Changlanish ehtimoli`,
        description:`Panel ${p.id} qo'shnilaridan ${Math.round((1-p.power_w/avg)*100)}% kam ishlamoqda.`,
        action:`Panel ${p.id} ni tozalang`});
  });
  panels.filter(p=>p.status==='fault').forEach(p=>{
    if(!alerts.find(a=>a.panels?.includes(p.id)))
      alerts.push({type:'fault',severity:'critical',
        title:`Panel ${p.id}: Nosozlik`,
        description:`Panel ${p.id} ishlamayapti (${p.power_w}W).`,
        action:`Panel ${p.id} ni tekshiring`});
  });
  return alerts;
}

// ─── API Endpoints ────────────────────────────────────────

// Barcha inverterlar uchun universal endpoint
app.post('/api/data', async (req, res) => {
  const { type, config, lat, lon } = req.body;
  if (!type) return res.status(400).json({ success:false, message:'type kerak: growatt|huawei|solis|deye|sma|custom|simulation' });
  try {
    let result;
    switch(type) {
      case 'growatt':    result = await growattData(config); break;
      case 'huawei':     result = await huaweiData(config); break;
      case 'solis':      result = await solisData(config); break;
      case 'deye':       result = await deyeData(config); break;
      case 'sma':        result = await smaData(config); break;
      case 'custom':     result = await customData(config); break;
      default:           result = simulationData(config);
    }
    const weather = await getWeather(lat||38.6169, lon||66.2472);
    const alerts = analyze(result.panels, weather);
    const totalPower = result.panels.reduce((s,p)=>s+p.power_w,0);
    const normalPanels = result.panels.filter(p=>p.status==='normal').length;
    res.json({
      success:true, source:result.source,
      summary:{
        total_power_kw:Math.round(totalPower/100)/10,
        capacity_kw:config?.capacity_kw||24,
        efficiency_pct:Math.round(totalPower/((config?.capacity_kw||24)*1000)*100),
        total_panels:result.panels.length,
        normal_panels:normalPanels,
        problem_panels:result.panels.length-normalPanels,
        today_kwh:Math.round(totalPower*6/1000*10)/10,
        alerts_count:alerts.length,
      },
      panels:result.panels, weather, alerts,
      timestamp:new Date().toISOString(),
    });
  } catch(err) {
    res.status(400).json({ success:false, message:err.message });
  }
});

// Ulanishni test qilish
app.post('/api/test', async (req, res) => {
  const { type, config } = req.body;
  try {
    switch(type) {
      case 'growatt': await growattData(config); break;
      case 'huawei':  await huaweiData(config); break;
      case 'solis':   await solisData(config); break;
      case 'deye':    await deyeData(config); break;
      case 'sma':     await smaData(config); break;
      case 'custom':  await customData(config); break;
      default: break;
    }
    res.json({ success:true, message:`✓ ${type} ga muvaffaqiyatli ulandi` });
  } catch(err) {
    res.status(400).json({ success:false, message:err.message });
  }
});

app.get('/health', (req,res)=>res.json({status:'ok',time:new Date().toISOString()}));

const PORT = process.env.PORT||3001;
app.listen(PORT, ()=>console.log(`SolarGrid Universal API — Port: ${PORT}`));
