/**
 * SolarGrid API Server
 * Quyosh stansiyasi monitoring tizimi
 * 
 * Inverter ulanish usullari:
 *   1. Growatt API  (api_type: "growatt")
 *   2. Huawei FusionSolar API (api_type: "huawei")
 *   3. Simulyatsiya (api_type: "simulation") ← test uchun
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Ob-havo API (OpenWeatherMap) ───────────────────────
const WEATHER_API_KEY = process.env.WEATHER_API_KEY || 'YOUR_OPENWEATHER_KEY';

// ─── Stansiya konfiguratsiyasi (keyinchalik DB ga o'tadi) ─
let stationConfig = {
  name: 'Toshkent Quyosh Stansiyasi',
  location: { lat: 41.2995, lon: 69.2401, city: 'Toshkent' },
  totalPanels: 48,
  rows: 6,
  panelsPerRow: 8,
  capacity_kw: 24,
  api_type: 'simulation', // 'growatt' | 'huawei' | 'simulation'
  growatt: { username: '', password: '', plant_id: '' },
  huawei: { username: '', system_code: '', station_dn: '' },
};

// ─── Simulyatsiya ma'lumot generatori ───────────────────
function generateSimulationData() {
  const hour = new Date().getHours();
  const isSunny = hour >= 6 && hour <= 19;
  const solarFactor = isSunny
    ? Math.sin(((hour - 6) / 13) * Math.PI) * (0.8 + Math.random() * 0.2)
    : 0;

  const panels = [];
  for (let row = 0; row < stationConfig.rows; row++) {
    for (let col = 0; col < stationConfig.panelsPerRow; col++) {
      const id = `${String.fromCharCode(65 + row)}${col + 1}`;
      let efficiency = 0.85 + Math.random() * 0.15;
      let status = 'normal';
      let issue = null;

      // Muammoli panellarni simulyatsiya qilish
      const rand = Math.random();
      if (rand < 0.04) {
        // Changlanish
        efficiency *= 0.45 + Math.random() * 0.2;
        status = 'dirty';
        issue = 'Changlanish ehtimoli yuqori';
      } else if (rand < 0.06) {
        // Shikastlangan
        efficiency *= 0.1 + Math.random() * 0.15;
        status = 'fault';
        issue = 'Panel shikastlangan yoki sim uzilgan';
      } else if (rand < 0.08) {
        // Sust
        efficiency *= 0.6 + Math.random() * 0.1;
        status = 'weak';
        issue = 'Quvvat pasaygan';
      }

      const maxPower = (stationConfig.capacity_kw * 1000) / stationConfig.totalPanels;
      const power_w = isSunny ? maxPower * solarFactor * efficiency : 0;
      const voltage = isSunny ? 36 + Math.random() * 4 : 0;
      const current = power_w / (voltage || 1);
      const temperature = 25 + Math.random() * 20 + (isSunny ? 15 : 0);

      panels.push({
        id,
        row: String.fromCharCode(65 + row),
        col: col + 1,
        power_w: Math.round(power_w),
        voltage: Math.round(voltage * 10) / 10,
        current: Math.round(current * 100) / 100,
        temperature: Math.round(temperature * 10) / 10,
        efficiency: Math.round(efficiency * 100),
        status,
        issue,
      });
    }
  }
  return panels;
}

// ─── Growatt API integratsiyasi ──────────────────────────
async function fetchGrowattData(config) {
  try {
    const { username, password, plant_id } = config.growatt;
    const pass_hash = crypto.createHash('md5').update(password).digest('hex');

    // Login
    const loginRes = await axios.post('https://server.growatt.com/login', {
      account: username,
      password: pass_hash,
    }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    if (!loginRes.data || loginRes.data.back?.success !== 1) {
      throw new Error('Growatt login muvaffaqiyatsiz. Username/password tekshiring.');
    }

    // Stansiya ma'lumoti
    const plantRes = await axios.post(
      'https://server.growatt.com/panel/getDevicesByPlantList',
      { plantId: plant_id, currPage: 1 },
      { headers: { Cookie: loginRes.headers['set-cookie']?.join(';') } }
    );

    return { source: 'growatt', raw: plantRes.data };
  } catch (err) {
    throw new Error(`Growatt API xatosi: ${err.message}`);
  }
}

// ─── Huawei FusionSolar API integratsiyasi ───────────────
async function fetchHuaweiData(config) {
  try {
    const { username, system_code, station_dn } = config.huawei;

    // Login
    const loginRes = await axios.post(
      'https://intl.fusionsolar.huawei.com/thirdData/login',
      { userName: username, systemCode: system_code }
    );

    if (loginRes.data?.failCode !== 0) {
      throw new Error('Huawei login muvaffaqiyatsiz. Credentials tekshiring.');
    }

    const token = loginRes.data.data?.xsrfToken;

    // Real vaqt ma'lumot
    const dataRes = await axios.post(
      'https://intl.fusionsolar.huawei.com/thirdData/getStationRealKpi',
      { stationCodes: station_dn },
      { headers: { 'xsrf-token': token } }
    );

    return { source: 'huawei', raw: dataRes.data };
  } catch (err) {
    throw new Error(`Huawei API xatosi: ${err.message}`);
  }
}

// ─── Ob-havo ma'lumoti ───────────────────────────────────
async function getWeather(lat, lon) {
  try {
    if (WEATHER_API_KEY === 'YOUR_OPENWEATHER_KEY') {
      // Demo ma'lumot
      return {
        temp: 32,
        description: 'Quyoshli',
        clouds: 10,
        wind_speed: 3.2,
        solar_radiation: 850,
        uv_index: 8,
        icon: '01d',
        forecast: [
          { day: 'Ertaga', temp: 34, clouds: 5, production_estimate: 95 },
          { day: 'Indiniga', temp: 29, clouds: 40, production_estimate: 65 },
          { day: '3 kundan keyin', temp: 27, clouds: 70, production_estimate: 35 },
        ]
      };
    }

    const [current, forecast] = await Promise.all([
      axios.get(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_API_KEY}&units=metric&lang=uz`),
      axios.get(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${WEATHER_API_KEY}&units=metric&lang=uz`),
    ]);

    const w = current.data;
    return {
      temp: Math.round(w.main.temp),
      description: w.weather[0].description,
      clouds: w.clouds.all,
      wind_speed: w.wind.speed,
      solar_radiation: Math.round((1 - w.clouds.all / 100) * 1000),
      uv_index: Math.round((1 - w.clouds.all / 100) * 10),
      icon: w.weather[0].icon,
      forecast: forecast.data.list
        .filter((_, i) => i % 8 === 0)
        .slice(0, 3)
        .map((f, i) => ({
          day: ['Ertaga', 'Indiniga', '3 kundan keyin'][i],
          temp: Math.round(f.main.temp),
          clouds: f.clouds.all,
          production_estimate: Math.round((1 - f.clouds.all / 100) * 100),
        })),
    };
  } catch (err) {
    return { error: `Ob-havo ma'lumot xatosi: ${err.message}` };
  }
}

// ─── Tahlil mexanizmi (asosiy "miya") ────────────────────
function analyzePanels(panels, weather) {
  const alerts = [];
  const solarGood = weather.solar_radiation > 500;

  // Qator bo'yicha guruhlash
  const rows = {};
  panels.forEach(p => {
    if (!rows[p.row]) rows[p.row] = [];
    rows[p.row].push(p);
  });

  // 1. Butun qator ishlamayapti → sim uzilgan
  Object.entries(rows).forEach(([row, rowPanels]) => {
    const working = rowPanels.filter(p => p.power_w > 10);
    if (working.length === 0 && solarGood) {
      alerts.push({
        type: 'wire_cut',
        severity: 'critical',
        title: `${row}-qator: Sim uzilgan bo'lishi mumkin`,
        description: `${row}-qatordagi barcha ${rowPanels.length} ta panel ishlamayapti. Ob-havo yaxshi — sim yoki ulanish tekshirilsin.`,
        panels: rowPanels.map(p => p.id),
        action: `${row}-qator kabellarini va junction box ni tekshiring`,
      });
    }
  });

  // 2. Alohida panel sust, qo'shnilari normal → changlanish
  panels.forEach(p => {
    if (!solarGood) return;
    const neighbors = panels.filter(n =>
      n.row === p.row && Math.abs(n.col - p.col) <= 2 && n.id !== p.id
    );
    const avgNeighbor = neighbors.reduce((s, n) => s + n.power_w, 0) / (neighbors.length || 1);

    if (p.power_w < avgNeighbor * 0.55 && avgNeighbor > 50 && p.power_w > 5) {
      alerts.push({
        type: 'dirty',
        severity: 'warning',
        title: `Panel ${p.id}: Changlanish ehtimoli`,
        description: `Panel ${p.id} qo'shnilaridan ${Math.round((1 - p.power_w / avgNeighbor) * 100)}% kam ishlamoqda. Ob-havo yaxshi — changlanish yoki qisman soya tekshirilsin.`,
        panels: [p.id],
        action: `Panel ${p.id} ni tozalang`,
      });
    }
  });

  // 3. Hamma panellar sust, ob-havo yaxshi → inverter muammo
  const totalPower = panels.reduce((s, p) => s + p.power_w, 0);
  const expectedPower = solarGood
    ? (weather.solar_radiation / 1000) * stationConfig.capacity_kw * 1000 * 0.8
    : 0;

  if (solarGood && expectedPower > 0 && totalPower < expectedPower * 0.4) {
    const alreadyCritical = alerts.some(a => a.type === 'wire_cut');
    if (!alreadyCritical) {
      alerts.push({
        type: 'inverter',
        severity: 'critical',
        title: 'Umumiy quvvat juda past — Inverter yoki tarmoq muammosi',
        description: `Kutilgan quvvat: ${Math.round(expectedPower / 1000)} kW, haqiqiy: ${Math.round(totalPower / 1000)} kW. Ob-havo yaxshi lekin butun sistema sust.`,
        panels: [],
        action: 'Inverter va asosiy tarmoq ulanishlarini tekshiring',
      });
    }
  }

  // 4. Shikastlangan panellar
  panels.filter(p => p.status === 'fault').forEach(p => {
    if (!alerts.find(a => a.panels?.includes(p.id))) {
      alerts.push({
        type: 'fault',
        severity: 'critical',
        title: `Panel ${p.id}: Shikastlangan`,
        description: `Panel ${p.id} deyarli ishlamayapti (${p.power_w}W). Fizik shikast yoki ichki nosozlik bo'lishi mumkin.`,
        panels: [p.id],
        action: `Panel ${p.id} ni ko'zdan kechiring, zarur bo'lsa almashtiring`,
      });
    }
  });

  return alerts;
}

// ─── API Endpoints ───────────────────────────────────────

// GET /api/station — stansiya konfiguratsiyasi
app.get('/api/station', (req, res) => {
  const safe = { ...stationConfig };
  // Parollarni yashirish
  if (safe.growatt?.password) safe.growatt = { ...safe.growatt, password: '***' };
  if (safe.huawei?.system_code) safe.huawei = { ...safe.huawei, system_code: '***' };
  res.json({ success: true, data: safe });
});

// POST /api/station/config — konfiguratsiyani yangilash
app.post('/api/station/config', (req, res) => {
  const { name, location, totalPanels, rows, panelsPerRow, capacity_kw, api_type, growatt, huawei } = req.body;
  if (name) stationConfig.name = name;
  if (location) stationConfig.location = location;
  if (totalPanels) stationConfig.totalPanels = totalPanels;
  if (rows) stationConfig.rows = rows;
  if (panelsPerRow) stationConfig.panelsPerRow = panelsPerRow;
  if (capacity_kw) stationConfig.capacity_kw = capacity_kw;
  if (api_type) stationConfig.api_type = api_type;
  if (growatt) stationConfig.growatt = { ...stationConfig.growatt, ...growatt };
  if (huawei) stationConfig.huawei = { ...stationConfig.huawei, ...huawei };
  res.json({ success: true, message: 'Konfiguratsiya saqlandi' });
});

// POST /api/station/test-connection — ulanishni sinash
app.post('/api/station/test-connection', async (req, res) => {
  try {
    const type = stationConfig.api_type;
    if (type === 'simulation') {
      return res.json({ success: true, message: "Simulyatsiya rejimi — ulanish kerak emas ✓" });
    }
    if (type === 'growatt') {
      await fetchGrowattData(stationConfig);
      return res.json({ success: true, message: "Growatt ga muvaffaqiyatli ulandi ✓" });
    }
    if (type === 'huawei') {
      await fetchHuaweiData(stationConfig);
      return res.json({ success: true, message: "Huawei FusionSolar ga muvaffaqiyatli ulandi ✓" });
    }
    res.status(400).json({ success: false, message: 'Noma\'lum API turi' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/panels — panel ma'lumotlari
app.get('/api/panels', async (req, res) => {
  try {
    let panels;
    const type = stationConfig.api_type;

    if (type === 'growatt') {
      const raw = await fetchGrowattData(stationConfig);
      // Growatt ma'lumotini normallashtiramiz (real API dan keyin moslashtiring)
      panels = generateSimulationData(); // placeholder
    } else if (type === 'huawei') {
      const raw = await fetchHuaweiData(stationConfig);
      panels = generateSimulationData(); // placeholder
    } else {
      panels = generateSimulationData();
    }

    res.json({ success: true, data: panels, source: type });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/weather — ob-havo
app.get('/api/weather', async (req, res) => {
  const { lat, lon } = stationConfig.location;
  const weather = await getWeather(lat, lon);
  res.json({ success: true, data: weather });
});

// GET /api/dashboard — hamma ma'lumot bitta so'rovda
app.get('/api/dashboard', async (req, res) => {
  try {
    const [panels, weather] = await Promise.all([
      (async () => {
        const type = stationConfig.api_type;
        if (type === 'growatt') return generateSimulationData();
        if (type === 'huawei') return generateSimulationData();
        return generateSimulationData();
      })(),
      getWeather(stationConfig.location.lat, stationConfig.location.lon),
    ]);

    const alerts = analyzePanels(panels, weather);
    const totalPower = panels.reduce((s, p) => s + p.power_w, 0);
    const normalPanels = panels.filter(p => p.status === 'normal').length;
    const problemPanels = panels.filter(p => p.status !== 'normal').length;

    res.json({
      success: true,
      station: { name: stationConfig.name, location: stationConfig.location },
      summary: {
        total_power_kw: Math.round(totalPower / 100) / 10,
        capacity_kw: stationConfig.capacity_kw,
        efficiency_pct: Math.round((totalPower / (stationConfig.capacity_kw * 1000)) * 100),
        total_panels: stationConfig.totalPanels,
        normal_panels: normalPanels,
        problem_panels: problemPanels,
        today_kwh: Math.round(totalPower * 6 / 1000 * 10) / 10,
        alerts_count: alerts.length,
      },
      panels,
      weather,
      alerts,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/alerts — faqat ogohlantirishlar
app.get('/api/alerts', async (req, res) => {
  try {
    const panels = generateSimulationData();
    const weather = await getWeather(stationConfig.location.lat, stationConfig.location.lon);
    const alerts = analyzePanels(panels, weather);
    res.json({ success: true, data: alerts, count: alerts.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Server ishga tushirish ──────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   SolarGrid API Server               ║
  ║   Port: ${PORT}                          ║
  ╠══════════════════════════════════════╣
  ║  GET  /api/dashboard   — barchasi    ║
  ║  GET  /api/panels      — panellar    ║
  ║  GET  /api/weather     — ob-havo     ║
  ║  GET  /api/alerts      — xabarlar   ║
  ║  GET  /api/station     — sozlamalar  ║
  ║  POST /api/station/config            ║
  ║  POST /api/station/test-connection   ║
  ╚══════════════════════════════════════╝
  `);
});
