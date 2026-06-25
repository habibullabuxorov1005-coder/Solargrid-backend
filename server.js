const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const WEATHER_API_KEY = process.env.WEATHER_API_KEY || '5c2cd8324b3695b36c6f6681d0498111';

let stationConfig = {
  name: "G'uzor Quyosh Stansiyasi",
  location: { lat: 38.6169, lon: 66.2472, city: "G'uzor" },
  totalPanels: 48,
  rows: 6,
  panelsPerRow: 8,
  capacity_kw: 24,
  api_type: 'simulation',
  growatt: { username: '', password: '', plant_id: '' },
  huawei: { username: '', system_code: '', station_dn: '' },
};

function generateSimulationData(solarFactor) {
  const hour = new Date().getHours();
  const isSunny = solarFactor > 0;

  const panels = [];
  for (let row = 0; row < stationConfig.rows; row++) {
    for (let col = 0; col < stationConfig.panelsPerRow; col++) {
      const id = `${String.fromCharCode(65 + row)}${col + 1}`;
      let efficiency = 0.85 + Math.random() * 0.15;
      let status = 'normal';
      let issue = null;

      const rand = Math.random();
      if (rand < 0.04) {
        efficiency *= 0.45 + Math.random() * 0.2;
        status = 'dirty';
        issue = 'Changlanish ehtimoli yuqori';
      } else if (rand < 0.06) {
        efficiency *= 0.1 + Math.random() * 0.15;
        status = 'fault';
        issue = 'Panel shikastlangan yoki sim uzilgan';
      } else if (rand < 0.08) {
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
        id, row: String.fromCharCode(65 + row), col: col + 1,
        power_w: Math.round(power_w),
        voltage: Math.round(voltage * 10) / 10,
        current: Math.round(current * 100) / 100,
        temperature: Math.round(temperature * 10) / 10,
        efficiency: Math.round(efficiency * 100),
        status, issue,
      });
    }
  }
  return panels;
}

async function fetchGrowattData(config) {
  try {
    const { username, password, plant_id } = config.growatt;
    const pass_hash = crypto.createHash('md5').update(password).digest('hex');
    const loginRes = await axios.post('https://server.growatt.com/login',
      { account: username, password: pass_hash },
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (!loginRes.data || loginRes.data.back?.success !== 1) throw new Error('Growatt login muvaffaqiyatsiz.');
    const plantRes = await axios.post('https://server.growatt.com/panel/getDevicesByPlantList',
      { plantId: plant_id, currPage: 1 },
      { headers: { Cookie: loginRes.headers['set-cookie']?.join(';') } }
    );
    return { source: 'growatt', raw: plantRes.data };
  } catch (err) {
    throw new Error(`Growatt API xatosi: ${err.message}`);
  }
}

async function fetchHuaweiData(config) {
  try {
    const { username, system_code, station_dn } = config.huawei;
    const loginRes = await axios.post('https://intl.fusionsolar.huawei.com/thirdData/login',
      { userName: username, systemCode: system_code }
    );
    if (loginRes.data?.failCode !== 0) throw new Error('Huawei login muvaffaqiyatsiz.');
    const token = loginRes.data.data?.xsrfToken;
    const dataRes = await axios.post('https://intl.fusionsolar.huawei.com/thirdData/getStationRealKpi',
      { stationCodes: station_dn },
      { headers: { 'xsrf-token': token } }
    );
    return { source: 'huawei', raw: dataRes.data };
  } catch (err) {
    throw new Error(`Huawei API xatosi: ${err.message}`);
  }
}

async function getWeather(lat, lon) {
  try {
    // OpenWeatherMap + Open-Meteo birgalikda
    const [owmCurrent, owmForecast, meteo] = await Promise.all([
      axios.get(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_API_KEY}&units=metric&lang=uz`),
      axios.get(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${WEATHER_API_KEY}&units=metric&lang=uz`),
      // Open-Meteo: haqiqiy radiatsiya + quyosh chiqish/botish vaqti
      axios.get(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=shortwave_radiation,uv_index,is_day&daily=shortwave_radiation_sum,temperature_2m_max,cloud_cover_mean,sunrise,sunset&timezone=auto&forecast_days=4`),
    ]);

    const w = owmCurrent.data;
    const m = meteo.data;

    // Quyosh chiqish va botish vaqti (bugun)
    const sunriseStr = m.daily.sunrise?.[0] || '';
    const sunsetStr = m.daily.sunset?.[0] || '';
    const sunrise = sunriseStr ? new Date(sunriseStr) : null;
    const sunset = sunsetStr ? new Date(sunsetStr) : null;

    // Haqiqiy radiatsiya — Open-Meteo dan (tunda avtomatik 0)
    const solar_radiation = Math.round(m.current.shortwave_radiation || 0);
    const uv_index = Math.round(m.current.uv_index || 0);
    const is_day = m.current.is_day === 1;

    // Quyosh chiqish/botish vaqtini formatlash
    const fmt = (d) => d ? d.toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' }) : '—';

    // 3 kunlik prognoz — radiatsiyaga asoslangan ishlab chiqarish foizi
    const days = ['Ertaga', 'Indiniga', '3 kundan keyin'];
    const radList = m.daily.shortwave_radiation_sum || [];
    const maxRad = Math.max(...radList.slice(1, 4), 1);

    const forecast = days.map((day, i) => {
      const idx = i + 1;
      const rad = radList[idx] || 0;
      const sr = m.daily.sunrise?.[idx] ? new Date(m.daily.sunrise[idx]) : null;
      const ss = m.daily.sunset?.[idx] ? new Date(m.daily.sunset[idx]) : null;
      return {
        day,
        temp: Math.round((m.daily.temperature_2m_max || [])[idx] || 0),
        clouds: Math.round((m.daily.cloud_cover_mean || [])[idx] || 0),
        production_estimate: Math.min(100, Math.round((rad / maxRad) * 100)),
        sunrise: fmt(sr),
        sunset: fmt(ss),
      };
    });

    return {
      temp: Math.round(w.main.temp),
      description: w.weather[0].description,
      clouds: w.clouds.all,
      wind_speed: Math.round(w.wind.speed * 10) / 10,
      solar_radiation,
      uv_index,
      is_day,
      sunrise: fmt(sunrise),
      sunset: fmt(sunset),
      icon: w.weather[0].icon,
      forecast,
    };
  } catch (err) {
    return { error: `Ob-havo xatosi: ${err.message}` };
  }
}

function analyzePanels(panels, weather) {
  const alerts = [];
  const solarGood = (weather.solar_radiation || 0) > 100;

  const rows = {};
  panels.forEach(p => { if (!rows[p.row]) rows[p.row] = []; rows[p.row].push(p); });

  Object.entries(rows).forEach(([row, rowPanels]) => {
    const working = rowPanels.filter(p => p.power_w > 10);
    if (working.length === 0 && solarGood) {
      alerts.push({
        type: 'wire_cut', severity: 'critical',
        title: `${row}-qator: Sim uzilgan bo'lishi mumkin`,
        description: `${row}-qatordagi barcha ${rowPanels.length} ta panel ishlamayapti. Ob-havo yaxshi.`,
        panels: rowPanels.map(p => p.id),
        action: `${row}-qator kabellarini tekshiring`,
      });
    }
  });

  panels.forEach(p => {
    if (!solarGood) return;
    const neighbors = panels.filter(n => n.row === p.row && Math.abs(n.col - p.col) <= 2 && n.id !== p.id);
    const avgNeighbor = neighbors.reduce((s, n) => s + n.power_w, 0) / (neighbors.length || 1);
    if (p.power_w < avgNeighbor * 0.55 && avgNeighbor > 50 && p.power_w > 5) {
      alerts.push({
        type: 'dirty', severity: 'warning',
        title: `Panel ${p.id}: Changlanish ehtimoli`,
        description: `Panel ${p.id} qo'shnilaridan ${Math.round((1 - p.power_w / avgNeighbor) * 100)}% kam ishlamoqda.`,
        panels: [p.id],
        action: `Panel ${p.id} ni tozalang`,
      });
    }
  });

  const totalPower = panels.reduce((s, p) => s + p.power_w, 0);
  const expectedPower = solarGood ? (weather.solar_radiation / 1000) * stationConfig.capacity_kw * 1000 * 0.8 : 0;
  if (solarGood && expectedPower > 0 && totalPower < expectedPower * 0.4) {
    if (!alerts.some(a => a.type === 'wire_cut')) {
      alerts.push({
        type: 'inverter', severity: 'critical',
        title: 'Umumiy quvvat past — Inverter yoki tarmoq muammosi',
        description: `Kutilgan: ${Math.round(expectedPower / 1000)} kW, haqiqiy: ${Math.round(totalPower / 1000)} kW.`,
        panels: [],
        action: 'Inverter va asosiy tarmoqni tekshiring',
      });
    }
  }

  panels.filter(p => p.status === 'fault').forEach(p => {
    if (!alerts.find(a => a.panels?.includes(p.id))) {
      alerts.push({
        type: 'fault', severity: 'critical',
        title: `Panel ${p.id}: Shikastlangan`,
        description: `Panel ${p.id} deyarli ishlamayapti (${p.power_w}W).`,
        panels: [p.id],
        action: `Panel ${p.id} ni ko'zdan kechiring`,
      });
    }
  });

  return alerts;
}

app.get('/api/station', (req, res) => {
  const safe = { ...stationConfig };
  if (safe.growatt?.password) safe.growatt = { ...safe.growatt, password: '***' };
  if (safe.huawei?.system_code) safe.huawei = { ...safe.huawei, system_code: '***' };
  res.json({ success: true, data: safe });
});

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

app.post('/api/station/test-connection', async (req, res) => {
  try {
    const type = stationConfig.api_type;
    if (type === 'simulation') return res.json({ success: true, message: 'Simulyatsiya rejimi — ulanish kerak emas' });
    if (type === 'growatt') { await fetchGrowattData(stationConfig); return res.json({ success: true, message: 'Growatt ga ulandi' }); }
    if (type === 'huawei') { await fetchHuaweiData(stationConfig); return res.json({ success: true, message: 'Huawei ga ulandi' }); }
    res.status(400).json({ success: false, message: "Noma'lum API turi" });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.get('/api/panels', async (req, res) => {
  try {
    const weather = await getWeather(stationConfig.location.lat, stationConfig.location.lon);
    const solarFactor = Math.min(1, (weather.solar_radiation || 0) / 1000) * (0.8 + Math.random() * 0.2);
    const panels = generateSimulationData(solarFactor);
    res.json({ success: true, data: panels, source: stationConfig.api_type });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/weather', async (req, res) => {
  const weather = await getWeather(stationConfig.location.lat, stationConfig.location.lon);
  res.json({ success: true, data: weather });
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const weather = await getWeather(stationConfig.location.lat, stationConfig.location.lon);

    // Panel quvvatini haqiqiy radiatsiyaga bog'lash
    const solarFactor = Math.min(1, (weather.solar_radiation || 0) / 1000) * (0.8 + Math.random() * 0.2);
    const panels = generateSimulationData(solarFactor);
    const alerts = analyzePanels(panels, weather);
    const totalPower = panels.reduce((s, p) => s + p.power_w, 0);
    const normalPanels = panels.filter(p => p.status === 'normal').length;

    res.json({
      success: true,
      station: { name: stationConfig.name, location: stationConfig.location },
      summary: {
        total_power_kw: Math.round(totalPower / 100) / 10,
        capacity_kw: stationConfig.capacity_kw,
        efficiency_pct: Math.round((totalPower / (stationConfig.capacity_kw * 1000)) * 100),
        total_panels: stationConfig.totalPanels,
        normal_panels: normalPanels,
        problem_panels: stationConfig.totalPanels - normalPanels,
        today_kwh: Math.round(totalPower * 6 / 1000 * 10) / 10,
        alerts_count: alerts.length,
      },
      panels, weather, alerts,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const weather = await getWeather(stationConfig.location.lat, stationConfig.location.lon);
    const solarFactor = Math.min(1, (weather.solar_radiation || 0) / 1000);
    const panels = generateSimulationData(solarFactor);
    const alerts = analyzePanels(panels, weather);
    res.json({ success: true, data: alerts, count: alerts.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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
  ╚══════════════════════════════════════╝
  `);
});
